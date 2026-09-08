import fs from 'node:fs/promises';
import path from 'node:path';
import { ActivitySynchronizer, syncExitCode, syncOutcome, SyncEvent } from '../core/engine';
import { SyncError } from '../core/errors';
import { PlatformAdapter, SavedSession, Slot, SyncRoute } from '../core/types';
import { CorosAdapter } from '../platforms/coros';
import { GarminAdapter } from '../platforms/garmin';
import { GarminSessionStore, sessionSettings } from '../state/garmin-session';
import { GitHubSecrets } from '../state/github-secrets';
import { requireSecrets, RunMode, SecretName } from './config';

export const DAILY_TRANSFER_LIMIT = 10;
export const MIGRATION_TRANSFER_LIMIT = 100;

interface RouteDefinition {
    source: Slot;
    target: Slot;
    secrets: SecretName[];
}

const ROUTES: Record<SyncRoute, RouteDefinition> = {
    'garmin-cn-to-garmin-global': {
        source: 'garmin-cn', target: 'garmin-global',
        secrets: ['GARMIN_USERNAME', 'GARMIN_PASSWORD', 'GARMIN_GLOBAL_USERNAME', 'GARMIN_GLOBAL_PASSWORD'],
    },
    'garmin-global-to-garmin-cn': {
        source: 'garmin-global', target: 'garmin-cn',
        secrets: ['GARMIN_USERNAME', 'GARMIN_PASSWORD', 'GARMIN_GLOBAL_USERNAME', 'GARMIN_GLOBAL_PASSWORD'],
    },
    'garmin-cn-to-coros-cn': {
        source: 'garmin-cn', target: 'coros-cn',
        secrets: ['GARMIN_USERNAME', 'GARMIN_PASSWORD', 'COROS_USERNAME', 'COROS_PASSWORD'],
    },
    'coros-cn-to-garmin-cn': {
        source: 'coros-cn', target: 'garmin-cn',
        secrets: ['GARMIN_USERNAME', 'GARMIN_PASSWORD', 'COROS_USERNAME', 'COROS_PASSWORD'],
    },
};

export interface BridgeResult {
    route: SyncRoute;
    mode: RunMode;
    limit: number;
    transferLimitReached: boolean;
    outcome: ReturnType<typeof syncOutcome>;
    exitCode: number;
    counts: Record<SyncEvent['status'], number>;
    events: SyncEvent[];
}

function adapter(slot: Slot, writable: boolean, env: NodeJS.ProcessEnv, store?: GarminSessionStore): PlatformAdapter {
    if (slot === 'coros-cn') {
        return new CorosAdapter({ username: env.COROS_USERNAME!, password: env.COROS_PASSWORD! });
    }
    const credentials = sessionSettings(slot, env);
    return new GarminAdapter({ region: credentials.region, username: credentials.username,
        password: credentials.password, writable, onSession: saved => store!.save(saved) });
}

function emptyCounts(): Record<SyncEvent['status'], number> {
    return { uploaded: 0, existing: 0, review: 0, verifying: 0, failed: 0, unsupported: 0, deferred: 0 };
}

export async function runBridge(root: string, route: SyncRoute, mode: RunMode,
    activityId: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<BridgeResult> {
    const definition = ROUTES[route];
    requireSecrets(env, definition.secrets);
    if (mode === 'migration' && activityId) throw new SyncError('USAGE', 'Migration does not accept an activity ID.');

    const actions = env.GITHUB_ACTIONS === 'true';
    let secrets: GitHubSecrets | undefined;
    if (actions) {
        requireSecrets(env, ['GH_SECRETS_TOKEN']);
        secrets = new GitHubSecrets(env.GITHUB_REPOSITORY ?? '', env.GH_SECRETS_TOKEN);
        await secrets.check();
    }
    const sessions = new Map<Slot, { store: GarminSessionStore; saved?: SavedSession }>();
    for (const slot of [definition.source, definition.target]) {
        if (slot === 'coros-cn') continue;
        const store = new GarminSessionStore(root, sessionSettings(slot, env), { actions, secrets });
        sessions.set(slot, { store, saved: await store.load() });
    }
    const source = adapter(definition.source, false, env, sessions.get(definition.source)?.store);
    const target = adapter(definition.target, true, env, sessions.get(definition.target)?.store);

    const runRoot = path.join(root, '.local', 'runs');
    await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(runRoot, 0o700);
    const directory = await fs.mkdtemp(path.join(runRoot, 'run-'));
    await fs.chmod(directory, 0o700);
    let events: SyncEvent[] = [];
    let runError: unknown;
    const synchronizer = new ActivitySynchronizer({ source, target,
        sourceSession: sessions.get(source.slot)?.saved,
        targetSession: sessions.get(target.slot)?.saved,
        directory,
    }, { activityId, transferLimit: mode === 'migration' ? MIGRATION_TRANSFER_LIMIT : DAILY_TRANSFER_LIMIT });
    try {
        events = await synchronizer.run();
    } catch (error) {
        runError = error;
    } finally {
        for (const current of [source, target]) {
            try {
                const exported = current.exportSession?.();
                if (!exported) continue;
                await sessions.get(current.slot)!.store.save(exported);
            } catch (error) {
                runError = error;
            }
        }
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (runError) throw runError;

    const counts = emptyCounts();
    for (const event of events) counts[event.status]++;
    return { route, mode, limit: mode === 'migration' ? MIGRATION_TRANSFER_LIMIT : DAILY_TRANSFER_LIMIT,
        transferLimitReached: synchronizer.transferLimitReached,
        outcome: syncOutcome(events), exitCode: syncExitCode(events), counts, events };
}
