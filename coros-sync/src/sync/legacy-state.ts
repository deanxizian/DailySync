import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { SyncError } from './errors';
import { DEFAULT_AES_KEY } from './garmin-db';
import { GarminDbState, initializeStateDatabase, STATE_TABLE } from './state';
import { COROS_STATE_DB_PATH, decodeUploadIntent, UPLOAD_INTENT_PATH } from './upload-intent';

export const LEGACY_UPLOAD_INTENT_PATH = 'coros-sync/.upload-intent.enc';

async function isFile(filename: string): Promise<boolean> {
    try { return (await fs.stat(filename)).isFile(); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

export async function migrateLegacyCorosState(root: string,
    aesKey = process.env.AESKEY): Promise<boolean> {
    const effectiveKey = aesKey || process.env.AESKEY || DEFAULT_AES_KEY;
    const destination = path.join(root, COROS_STATE_DB_PATH);
    if (await isFile(destination)) return false;
    const legacyIntent = path.join(root, LEGACY_UPLOAD_INTENT_PATH);
    const hasLegacyIntent = await isFile(legacyIntent);
    const source = path.join(root, 'db', 'garmin.db');
    if (!await isFile(source)) {
        if (hasLegacyIntent) throw new SyncError('STATE_INVALID', 'The legacy COROS upload intent has no state database.');
        return false;
    }

    let sourceDb;
    let row: { payload: string; updated_at: string } | undefined;
    try {
        sourceDb = await open({ filename: source, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
        const check = await sourceDb.get('PRAGMA integrity_check');
        if (!check || Object.values(check)[0] !== 'ok') throw new Error();
        const table = await sourceDb.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", STATE_TABLE);
        if (!table) {
            if (hasLegacyIntent) throw new SyncError('STATE_INVALID', 'The legacy COROS upload intent has no saved state.');
            return false;
        }
        row = await sourceDb.get(`SELECT payload, updated_at FROM ${STATE_TABLE} WHERE id = 1`);
        if (!row) {
            if (hasLegacyIntent) throw new SyncError('STATE_INVALID', 'The legacy COROS upload intent has no saved state.');
            return false;
        }
        if (typeof row.payload !== 'string' || typeof row.updated_at !== 'string') throw new Error();
    } catch (_) {
        throw new SyncError('STATE_INVALID', 'Cannot read the legacy COROS state from db/garmin.db.');
    } finally {
        await sourceDb?.close();
    }

    let intent: string | undefined;
    if (hasLegacyIntent) {
        try {
            intent = await fs.readFile(legacyIntent, 'utf8');
            decodeUploadIntent(intent, effectiveKey);
        } catch (error) {
            if (error instanceof SyncError) throw error;
            throw new SyncError('STATE_INVALID', 'Cannot read the legacy COROS upload intent.');
        }
    }

    const temporary = `${destination}.${process.pid}.${randomUUID()}.migrate`;
    let stateLinked = false;
    let intentWritten = false;
    try {
        await initializeStateDatabase(temporary);
        const migrated = await open({ filename: temporary, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE });
        try {
            await migrated.run(`INSERT INTO ${STATE_TABLE} (id, payload, updated_at) VALUES (1, ?, ?)`,
                row.payload, row.updated_at);
        } finally { await migrated.close(); }
        const validation = await GarminDbState.open(temporary, false, effectiveKey);
        try {
            if (!await validation.load()) throw new Error();
        } finally { await validation.close(); }

        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        if (intent !== undefined) {
            const targetIntent = path.join(root, UPLOAD_INTENT_PATH);
            await fs.writeFile(targetIntent, intent, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            intentWritten = true;
        }
        await fs.link(temporary, destination);
        stateLinked = true;
        await fs.chmod(destination, 0o600);
        return true;
    } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('STATE_INVALID', 'Cannot migrate the legacy COROS synchronization state.');
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (!stateLinked) {
            if (intentWritten) await fs.rm(path.join(root, UPLOAD_INTENT_PATH), { force: true }).catch(() => {});
        }
    }
}
