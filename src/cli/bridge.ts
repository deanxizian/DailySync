import fs from 'node:fs/promises';
import path from 'node:path';
import { ActivitySynchronizer, syncExitCode, syncOutcome, SyncEvent } from '../core/engine';
import { SyncError } from '../core/errors';
import { PlatformAdapter, SavedSession, Slot, SyncRoute } from '../core/types';
import { CorosAdapter } from '../platforms/coros';
import { GarminAdapter } from '../platforms/garmin';
import { GarminCredentials, loadGarminSession, saveGarminSession } from '../state/session-db';
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
    sessionChanged: boolean;
}

function garminCredentials(slot: 'garmin-cn' | 'garmin-global', env: NodeJS.ProcessEnv): GarminCredentials {
    return slot === 'garmin-cn'
        ? { region: 'CN', slot, username: env.GARMIN_USERNAME!, password: env.GARMIN_PASSWORD! }
        : { region: 'GLOBAL', slot, username: env.GARMIN_GLOBAL_USERNAME!, password: env.GARMIN_GLOBAL_PASSWORD! };
}

function adapter(slot: Slot, writable: boolean, env: NodeJS.ProcessEnv): PlatformAdapter {
    if (slot === 'coros-cn') {
        return new CorosAdapter({ username: env.COROS_USERNAME!, password: env.COROS_PASSWORD! });
    }
    const credentials = garminCredentials(slot, env);
    return new GarminAdapter({ region: credentials.region, username: credentials.username,
        password: credentials.password, writable });
}

function emptyCounts(): Record<SyncEvent['status'], number> {
    return { uploaded: 0, existing: 0, review: 0, verifying: 0, failed: 0, unsupported: 0, deferred: 0 };
}

export async function runBridge(root: string, route: SyncRoute, mode: RunMode,
    activityId: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<BridgeResult> {
    const definition = ROUTES[route];
    requireSecrets(env, definition.secrets);
    if (mode === 'migration' && activityId) throw new SyncError('USAGE', 'Migration does not accept an activity ID.');

    const source = adapter(definition.source, false, env);
    const target = adapter(definition.target, true, env);
    const database = path.join(root, 'db', 'garmin.db');
    const sessions = new Map<Slot, { credentials: GarminCredentials; saved?: SavedSession; adapter: PlatformAdapter }>();
    for (const current of [source, target]) {
        if (current.slot === 'coros-cn') continue;
        const credentials = garminCredentials(current.slot, env);
        sessions.set(current.slot, { credentials, saved: await loadGarminSession(database, credentials), adapter: current });
    }

    const runRoot = path.join(root, '.local', 'runs');
    await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(runRoot, 0o700);
    const directory = await fs.mkdtemp(path.join(runRoot, 'run-'));
    await fs.chmod(directory, 0o700);
    let events: SyncEvent[] = [];
    let sessionChanged = false;
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
        try {
            for (const current of sessions.values()) {
                const exported = current.adapter.exportSession?.();
                if (!exported) continue;
                const result = await saveGarminSession(database, current.credentials, exported);
                sessionChanged ||= result.changed;
            }
        } catch (error) {
            runError = error;
        }
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (runError) throw runError;

    const counts = emptyCounts();
    for (const event of events) counts[event.status]++;
    return { route, mode, limit: mode === 'migration' ? MIGRATION_TRANSFER_LIMIT : DAILY_TRANSFER_LIMIT,
        transferLimitReached: synchronizer.transferLimitReached,
        outcome: syncOutcome(events), exitCode: syncExitCode(events), counts, events, sessionChanged };
}
