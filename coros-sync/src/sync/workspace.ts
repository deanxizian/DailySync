import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { GarminDbState } from './state';
import { emptyState, SyncState } from './types';
import { SyncError } from './errors';
import { clearUploadIntent, mergeUploadIntent, readUploadIntent } from './upload-intent';

export class SyncWorkspace {
    private store?: GarminDbState;
    private writable = false;
    private lockPayload?: string;

    private constructor(readonly directory: string, private readonly root: string,
        private readonly database: string, private readonly lockFile: string) {}

    static async create(root: string): Promise<SyncWorkspace> {
        const base = path.join(root, 'coros-sync', '.local');
        await fs.mkdir(base, { recursive: true, mode: 0o700 });
        await fs.chmod(base, 0o700);
        const directory = await fs.mkdtemp(path.join(base, 'run-'));
        return new SyncWorkspace(directory, root, path.join(root, 'db', 'garmin.db'), path.join(base, 'write.lock'));
    }

    private async acquireWriteLock(): Promise<void> {
        const payload = JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let created = false;
        try {
            handle = await fs.open(this.lockFile, 'wx', 0o600);
            created = true;
            await handle.writeFile(payload, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            this.lockPayload = payload;
        } catch (error) {
            await handle?.close().catch(() => {});
            if (created) await fs.unlink(this.lockFile).catch(() => {});
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new SyncError('LOCK_HELD', 'Another writable COROS run or an unconfirmed stale lock exists.');
            }
            throw new SyncError('LOCK_CREATE', 'Cannot create the writable COROS state lock.');
        }
    }

    private async releaseWriteLock(): Promise<void> {
        if (!this.lockPayload) return;
        const expected = this.lockPayload;
        let actual: string;
        try { actual = await fs.readFile(this.lockFile, 'utf8'); }
        catch (_) {
            this.lockPayload = undefined;
            throw new SyncError('LOCK_LOST', 'The writable COROS run no longer owns its state lock.');
        }
        if (actual !== expected) {
            this.lockPayload = undefined;
            throw new SyncError('LOCK_LOST', 'The writable COROS run no longer owns its state lock.');
        }
        try { await fs.unlink(this.lockFile); }
        catch (_) { throw new SyncError('LOCK_RELEASE', 'Cannot release the writable COROS state lock.'); }
        this.lockPayload = undefined;
    }

    async load(write: boolean, allowEmpty = true): Promise<SyncState> {
        if (this.store) throw new SyncError('STATE_INVALID', 'COROS sync state was opened more than once.');
        if (write) await this.acquireWriteLock();
        this.writable = write;
        try {
            this.store = await GarminDbState.open(this.database, write);
            const saved = await this.store.load();
            const intent = await readUploadIntent(this.root);
            if (!saved && !intent && !allowEmpty) throw new SyncError('STATE_MISSING', 'No COROS sync state exists in db/garmin.db.');
            const state = saved ?? emptyState();
            return intent ? mergeUploadIntent(state, intent) : state;
        } catch (error) {
            let cleanupFailure: unknown;
            try { await this.store?.close(); } catch (failure) { cleanupFailure = failure; }
            this.store = undefined;
            this.writable = false;
            try { await this.releaseWriteLock(); } catch (failure) { cleanupFailure ??= failure; }
            throw cleanupFailure ?? error;
        }
    }

    async save(state: SyncState): Promise<void> {
        await this.assertOwned();
        await this.store!.save(state);
    }

    async assertOwned(): Promise<void> {
        if (!this.writable || !this.store || !this.lockPayload) {
            throw new SyncError('STATE_SAVE', 'The current run does not own a writable db/garmin.db state connection.');
        }
        try {
            if (await fs.readFile(this.lockFile, 'utf8') !== this.lockPayload) throw new Error();
        } catch (_) {
            throw new SyncError('LOCK_LOST', 'The writable COROS run no longer owns its state lock.');
        }
    }

    async clearUploadIntent(): Promise<void> {
        await this.assertOwned();
        await clearUploadIntent(this.root);
    }

    async close(keepFits = false): Promise<void> {
        let failure: unknown;
        if (this.writable && this.lockPayload) {
            try { await this.assertOwned(); } catch (error) { failure = error; }
        }
        try { await this.store?.close(); } catch (error) { failure ??= error; }
        this.store = undefined;
        this.writable = false;
        try { await this.releaseWriteLock(); } catch (error) { failure ??= error; }
        if (!keepFits) {
            try { await fs.rm(this.directory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
        }
        if (failure) throw failure;
    }
}
