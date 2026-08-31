import fs from 'node:fs/promises';
import path from 'node:path';
import { SyncError } from '../core/errors';

export async function withRunLock<T>(root: string, action: () => Promise<T>): Promise<T> {
    const directory = path.join(root, '.local', 'locks');
    const filename = path.join(directory, 'activity-sync.lock');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(filename, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new SyncError('LOCKED', 'Another DailySync process holds the local account lock.');
        }
        throw new SyncError('LOCK_FAILED', 'Cannot create the local account lock.');
    }
    try {
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.sync();
        return await action();
    } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(filename, { force: true }).catch(() => undefined);
    }
}
