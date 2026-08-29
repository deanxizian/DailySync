import { randomUUID } from 'crypto';
import path from 'path';
import { ActivitySynchronizer, candidatesNear, scanAll, SyncEvent, syncExitCode } from './sync/engine';
import { CorosAdapter } from './sync/coros';
import { GarminCnReadOnlyAdapter } from './sync/garmin';
import { newerGarminSession, readGarminCnSession } from './sync/garmin-db';
import { CliOptions, loadPrivateEnv, parseActivityReference, parseOptions, requireBridgeAccounts } from './sync/config';
import { safeError, SyncError } from './sync/errors';
import { SyncWorkspace } from './sync/workspace';
import { assertRemoteGarminDbLock, clearCorosUploadIntent, publishCorosUploadIntent } from './sync/git-checkpoint';
import { activityKey, PlatformAdapter, Slot, SyncState, transferKey } from './sync/types';

export type BridgeProfile = 'migration' | 'sync';

const HELP: Record<BridgeProfile, string> = {
    migration: `DailySync historical migration: Garmin CN -> COROS CN

pnpm --dir coros-sync migrate_garmin_cn_to_coros                   Read-only migration preview
pnpm --dir coros-sync migrate_garmin_cn_to_coros --apply           Migrate the selected history batch

Options: --migrate-start N, --time-budget SECONDS, --retry-failed, --json
GARMIN_MIGRATE_START is 1-based with the newest activity at position 1; 0 also starts at the newest activity.
`,
    sync: `DailySync activity sync: Garmin CN -> COROS CN

pnpm --dir coros-sync sync_garmin_cn_to_coros                       Read-only recent sync preview
pnpm --dir coros-sync sync_garmin_cn_to_coros --apply               Sync missing activities to COROS
pnpm --dir coros-sync sync_garmin_cn_to_coros --activity-id ID --apply
pnpm --dir coros-sync sync_garmin_cn_to_coros state                 Inspect mappings and unresolved imports
pnpm --dir coros-sync sync_garmin_cn_to_coros link --source garmin-cn:ID --target coros-cn:ID
pnpm --dir coros-sync sync_garmin_cn_to_coros ignore --source garmin-cn:ID --target coros-cn
pnpm --dir coros-sync sync_garmin_cn_to_coros retry --source garmin-cn:ID --target coros-cn --confirm-not-imported

Options: --activity-id ID, --time-budget SECONDS, --retry-failed, --json
`,
};

function countSetting(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0 || Number(raw) > 1000) {
        throw new SyncError('CONFIG', `${name} must be an integer from 1 to 1000.`);
    }
    return Number(raw);
}

function migrationStartSetting(option?: number): number {
    if (option !== undefined) return option;
    const raw = process.env.GARMIN_MIGRATE_START;
    if (raw === undefined || raw === '') return 0;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new SyncError('CONFIG', 'GARMIN_MIGRATE_START must be a non-negative integer.');
    }
    return Number(raw);
}

function autoPageEnabled(): boolean {
    const value = String(process.env.GARMIN_MIGRATE_AUTO_PAGE ?? '').trim().toLowerCase();
    if (!value || ['1', 'true', 'on'].includes(value)) return true;
    if (['0', 'false', 'off'].includes(value)) return false;
    throw new SyncError('CONFIG', 'GARMIN_MIGRATE_AUTO_PAGE must be true or false.');
}

function summarize(events: SyncEvent[]): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const event of events) summary[event.status] = (summary[event.status] ?? 0) + 1;
    return summary;
}

function validateProfile(profile: BridgeProfile, options: CliOptions): void {
    if (profile === 'migration' && (options.command !== 'sync' || options.activityId)) {
        throw new SyncError('USAGE', 'The migration script only accepts historical migration options.');
    }
    if (profile === 'sync' && options.migrateStart !== undefined) {
        throw new SyncError('USAGE', 'GARMIN_MIGRATE_START belongs to the migration script, not daily sync.');
    }
}

export async function main(profile: BridgeProfile, args = process.argv.slice(2),
    root = path.resolve(__dirname, '..', '..')): Promise<number> {
    const options = parseOptions(args);
    if (options.help) { console.log(HELP[profile]); return 0; }
    validateProfile(profile, options);
    loadPrivateEnv(root);
    const write = options.command === 'sync' ? options.apply : ['link', 'ignore', 'retry'].includes(options.command);
    if (['sync', 'link', 'ignore', 'retry'].includes(options.command)) requireBridgeAccounts(process.env);
    const workspace = await SyncWorkspace.create(root);
    let state: SyncState | undefined;
    let succeeded = false;
    try {
        state = await workspace.load(write, true);
        if (options.command === 'state') {
            console.log(JSON.stringify({ accounts: Object.keys(state.accounts), activities: Object.keys(state.activities).length,
                tasks: Object.values(state.transfers).filter(task => task.status !== 'complete').map(task => ({
                    source: activityKey(task.source, task.sourceId), target: task.target, status: task.status, code: task.code,
                    targetId: task.receipt?.targetId, taskId: task.receipt?.taskId, candidates: task.candidates,
                })) }, null, 2));
            succeeded = true;
            return 0;
        }
        const databaseSession = await readGarminCnSession(root, process.env.GARMIN_USERNAME!);
        state.sessions['garmin-cn'] = newerGarminSession(state.sessions['garmin-cn'], databaseSession);
        const sourcePageSize = countSetting(profile === 'migration' ? 'GARMIN_MIGRATE_NUM' : 'GARMIN_SYNC_NUM',
            profile === 'migration' ? 100 : 10);
        const adapters: Record<Slot, PlatformAdapter> = {
            'garmin-cn': new GarminCnReadOnlyAdapter(process.env.GARMIN_USERNAME!, undefined, undefined, sourcePageSize),
            'coros-cn': new CorosAdapter({ username: process.env.COROS_USERNAME!, password: process.env.COROS_PASSWORD! }),
        };
        const timeBudget = options.timeBudget ?? (process.env.GITHUB_ACTIONS === 'true' ? 2700 : undefined);
        const assertOwned = async () => {
            await workspace.assertOwned();
            await assertRemoteGarminDbLock(root);
        };
        const engine = new ActivitySynchronizer({ adapters, state, directory: workspace.directory,
            checkpoint: value => workspace.save(value), publishIntent: intent => publishCorosUploadIntent(root, intent),
            clearIntent: async () => { await workspace.assertOwned(); await clearCorosUploadIntent(root); }, assertOwned,
            emit: options.json ? undefined : event => {
                if (event.status !== 'existing') console.log(`${event.source} ${event.status}${event.code ? ` (${event.code})` : ''}${event.candidates?.length ? ` candidates=${event.candidates.join(',')}` : ''}`);
            } }, { apply: write, activityId: options.activityId,
                sourceOffset: profile === 'migration' ? Math.max(0, migrationStartSetting(options.migrateStart) - 1) : 0,
                sourceLimit: profile === 'migration' && !autoPageEnabled() ? sourcePageSize : undefined,
                retryFailed: options.retryFailed, deadline: timeBudget ? Date.now() + timeBudget * 1000 : undefined });
        if (options.command !== 'sync') {
            const sourceRef = parseActivityReference(options.source!);
            const targetRef = options.command === 'link' ? parseActivityReference(options.target!) : { slot: options.target as Slot, id: '' };
            if (sourceRef.slot !== 'garmin-cn' || targetRef.slot !== 'coros-cn') {
                throw new SyncError('USAGE', 'Only garmin-cn to coros-cn mappings are supported.');
            }
            await engine.scan();
            const source = state.activities[activityKey(sourceRef.slot, sourceRef.id)];
            if (!source) throw new SyncError('NOT_FOUND', 'Source activity is not in the complete Garmin scan.');
            const task = state.transfers[transferKey(source.canonical, 'coros-cn')];
            if (options.command === 'link') {
                const target = state.activities[activityKey(targetRef.slot, targetRef.id)];
                if (!target || target.missing) throw new SyncError('NOT_FOUND', 'Target activity must currently exist in COROS.');
                await engine.link(source, target);
            } else if (options.command === 'ignore') {
                await engine.ignore(source.activity, 'coros-cn');
            } else {
                if (!task || !['failed', 'uploading', 'verifying'].includes(task.status) || source.missing ||
                    Object.values(state.activities).some(record => record.canonical === source.canonical && record.activity.slot === 'coros-cn')) {
                    throw new SyncError('RETRY_UNSAFE', 'Only an unlinked failed or unknown COROS import with an existing Garmin source can be retried.');
                }
                const receipt = await adapters['coros-cn'].verify(task);
                if (receipt.status === 'pending' || receipt.stage === 'finished' || receipt.targetId ||
                    candidatesNear(task.evidence ?? source.activity, await scanAll(adapters['coros-cn'])).length) {
                    throw new SyncError('RETRY_UNSAFE', 'A COROS activity or completed/pending import exists; reconcile it instead of retrying.');
                }
                const attempt = randomUUID();
                Object.assign(task, { status: 'pending', attempt, filename: `dailysync_${attempt}.fit`, createdAt: Date.now(),
                    receipt: undefined, code: undefined, beforeIds: undefined, evidence: undefined });
                await workspace.save(state);
            }
            console.log('Bridge mapping updated. No activity was uploaded, edited or deleted.');
            succeeded = true;
            return 0;
        }
        const events = await engine.run();
        const result = { mode: write ? 'apply' : 'preview', task: profile,
            direction: 'garmin-cn-to-coros-cn', summary: summarize(events) };
        console.log(JSON.stringify(options.json ? { ...result, events } : result, null, 2));
        succeeded = true;
        return syncExitCode(events);
    } finally {
        const keepFits = process.env.GITHUB_ACTIONS !== 'true' && (!succeeded || Object.values(state?.transfers ?? {}).some(task =>
            ['uploading', 'verifying', 'failed'].includes(task.status)));
        let cleanupFailure: unknown;
        if (succeeded && write) {
            try { await workspace.clearUploadIntent(); } catch (error) { cleanupFailure = error; }
        }
        try { await workspace.close(keepFits); } catch (error) { cleanupFailure ??= error; }
        if (cleanupFailure) throw cleanupFailure;
    }
}

export function runCli(profile: BridgeProfile): void {
    main(profile).then(code => { process.exitCode = code; })
        .catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
