import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ActivitySynchronizer, SyncEvent, syncExitCode, syncOutcome } from './sync/engine';
import { CorosAdapter } from './sync/coros';
import { GarminCnReadOnlyAdapter, GarminCnUploadAdapter } from './sync/garmin';
import { readGarminCnSession } from './sync/garmin-db';
import { CliOptions, loadPrivateEnv, parseOptions, requireBridgeAccounts } from './sync/config';
import { safeError, SyncError } from './sync/errors';

export type BridgeProfile = 'migration' | 'sync';
export type BridgeDirection = 'garmin-to-coros' | 'coros-to-garmin';
export type AccountLockScope = 'coros-cn' | 'garmin-cn';

async function reclaimDeadLock(filename: string): Promise<boolean> {
    let current: string;
    try { current = await fs.readFile(filename, 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        return false;
    }

    let pid: number | undefined;
    try {
        const owner = JSON.parse(current) as { pid?: unknown };
        if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) pid = Number(owner.pid);
    } catch (_) {}
    if (pid !== undefined) {
        try { process.kill(pid, 0); return false; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
        }
    } else {
        try {
            const stat = await fs.stat(filename);
            if (Date.now() - stat.mtimeMs < 300000) return false;
        } catch (_) { return true; }
    }

    try {
        if (await fs.readFile(filename, 'utf8') !== current) return false;
        await fs.unlink(filename);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
}

export async function acquireAccountLock(directory: string, account: string,
    scope: AccountLockScope = 'coros-cn'): Promise<() => Promise<void>> {
    const accountHash = createHash('sha256').update(account.trim().toLowerCase()).digest('hex').slice(0, 24);
    const filename = path.join(directory, `${scope}-${accountHash}.lock`);
    const token = JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let created = false;
        try {
            handle = await fs.open(filename, 'wx', 0o600);
            created = true;
            await handle.writeFile(token, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            acquired = true;
        } catch (error) {
            await handle?.close().catch(() => {});
            if (created) await fs.unlink(filename).catch(() => {});
            if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') {
                if (await reclaimDeadLock(filename)) continue;
                throw new SyncError('LOCK_HELD', `Another local migration or sync is already using this ${scope} account.`);
            }
            throw new SyncError('LOCK_CREATE', 'Cannot create the local COROS account lock.');
        }
    }
    if (!acquired) throw new SyncError('LOCK_HELD', `Another local migration or sync is already using this ${scope} account.`);
    return async () => {
        let current: string;
        try { current = await fs.readFile(filename, 'utf8'); }
        catch (_) { throw new SyncError('LOCK_LOST', 'The local COROS account lock disappeared during the run.'); }
        if (current !== token) throw new SyncError('LOCK_LOST', 'The local COROS account lock changed during the run.');
        try { await fs.unlink(filename); }
        catch (_) { throw new SyncError('LOCK_RELEASE', 'Cannot release the local COROS account lock.'); }
    };
}

export async function acquireAccountLocks(directory: string,
    accounts: Array<{ scope: AccountLockScope; account: string }>): Promise<() => Promise<void>> {
    const ordered = [...accounts].sort((left, right) =>
        `${left.scope}:${left.account.trim().toLowerCase()}`.localeCompare(
            `${right.scope}:${right.account.trim().toLowerCase()}`));
    const releases: Array<() => Promise<void>> = [];
    try {
        for (const { scope, account } of ordered) {
            releases.push(await acquireAccountLock(directory, account, scope));
        }
    } catch (error) {
        for (const release of releases.reverse()) await release().catch(() => {});
        throw error;
    }
    return async () => {
        let releaseError: unknown;
        for (const release of releases.reverse()) {
            try { await release(); }
            catch (error) { releaseError ??= error; }
        }
        if (releaseError) throw releaseError;
    };
}

function help(profile: BridgeProfile, direction: BridgeDirection): string {
    const command = profile === 'migration'
        ? direction === 'garmin-to-coros' ? 'migrate_garmin_cn_to_coros' : 'migrate_coros_cn_to_garmin_cn'
        : direction === 'garmin-to-coros' ? 'sync_garmin_cn_to_coros' : 'sync_coros_cn_to_garmin_cn';
    const label = direction === 'garmin-to-coros' ? 'Garmin CN -> COROS CN' : 'COROS CN -> Garmin CN';
    const options = profile === 'migration'
        ? '--migrate-start N, --time-budget SECONDS, --json\nGARMIN_MIGRATE_START is 1-based; 0 and 1 both start with the newest activity.'
        : '--activity-id ID, --time-budget SECONDS, --json';
    return `DailySync ${profile === 'migration' ? 'historical migration' : 'activity sync'}: ${label}\n\n` +
        `pnpm --dir coros-sync ${command}\n\nOptions: ${options}\n`;
}

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
    if (profile === 'migration' && options.activityId) {
        throw new SyncError('USAGE', '--activity-id belongs to the daily sync script.');
    }
    if (profile === 'sync' && options.migrateStart !== undefined) {
        throw new SyncError('USAGE', '--migrate-start belongs to the historical migration script.');
    }
}

export async function main(profile: BridgeProfile, args = process.argv.slice(2),
    root = path.resolve(__dirname, '..', '..'), direction: BridgeDirection = 'garmin-to-coros'): Promise<number> {
    const options = parseOptions(args);
    if (options.help) {
        console.log(help(profile, direction));
        return 0;
    }
    validateProfile(profile, options);
    loadPrivateEnv(root);
    requireBridgeAccounts(process.env);

    const pageSize = countSetting(profile === 'migration' ? 'GARMIN_MIGRATE_NUM' : 'GARMIN_SYNC_NUM',
        profile === 'migration' ? 100 : 10);
    const sourceOffset = profile === 'migration' ? Math.max(0, migrationStartSetting(options.migrateStart) - 1) : 0;
    const sourceLimit = profile === 'migration' && !autoPageEnabled() ? pageSize : undefined;
    const timeBudget = options.timeBudget ??
        (profile === 'sync' && process.env.GITHUB_ACTIONS === 'true' ? 2700 : undefined);
    const base = path.join(root, 'coros-sync', '.local');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    await fs.chmod(base, 0o700);
    const releaseLocks = await acquireAccountLocks(base, [
        { scope: 'coros-cn', account: process.env.COROS_USERNAME! },
        { scope: 'garmin-cn', account: process.env.GARMIN_USERNAME! },
    ]);
    let directory: string | undefined;

    try {
        directory = await fs.mkdtemp(path.join(base, 'run-'));
        const garminSession = await readGarminCnSession(root, process.env.GARMIN_USERNAME!);
        const coros = new CorosAdapter({ username: process.env.COROS_USERNAME!, password: process.env.COROS_PASSWORD! });
        const garmin = direction === 'garmin-to-coros'
            ? new GarminCnReadOnlyAdapter(process.env.GARMIN_USERNAME!, undefined, undefined, pageSize)
            : new GarminCnUploadAdapter(process.env.GARMIN_USERNAME!, undefined, undefined, pageSize);
        const source = direction === 'garmin-to-coros' ? garmin : coros;
        const target = direction === 'garmin-to-coros' ? coros : garmin;
        const engine = new ActivitySynchronizer({ source, target,
            sourceSession: direction === 'garmin-to-coros' ? garminSession : undefined,
            targetSession: direction === 'coros-to-garmin' ? garminSession : undefined,
            directory,
            emit: options.json ? undefined : event => {
                if (event.status !== 'existing') {
                    console.log(`${event.source} ${event.status}${event.code ? ` (${event.code})` : ''}` +
                        `${event.candidates?.length ? ` candidates=${event.candidates.join(',')}` : ''}`);
                }
            } }, {
            activityId: options.activityId,
            sourceOffset,
            sourceLimit,
            deadline: timeBudget ? Date.now() + timeBudget * 1000 : undefined,
        });
        const events = await engine.run();
        const result = { task: profile, direction: direction === 'garmin-to-coros'
            ? 'garmin-cn-to-coros-cn' : 'coros-cn-to-garmin-cn', outcome: syncOutcome(events), summary: summarize(events) };
        console.log(JSON.stringify(options.json ? { ...result, events } : result, null, 2));
        return syncExitCode(events);
    } finally {
        let cleanupError: unknown;
        if (directory) {
            try { await fs.rm(directory, { recursive: true, force: true }); }
            catch (error) { cleanupError = error; }
        }
        try { await releaseLocks(); }
        catch (error) { cleanupError ??= error; }
        if (cleanupError) throw cleanupError;
    }
}

export function runCli(profile: BridgeProfile, direction: BridgeDirection = 'garmin-to-coros'): void {
    main(profile, process.argv.slice(2), path.resolve(__dirname, '..', '..'), direction).then(code => { process.exitCode = code; })
        .catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
