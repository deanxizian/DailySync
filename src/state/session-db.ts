import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { garminAccountHash } from '../core/account';
import { SyncError } from '../core/errors';
import { GarminSlot, SavedSession } from '../core/types';

const SCHEMA_VERSION = 2;
const ENVELOPE_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type GarminRegion = 'CN' | 'GLOBAL';

export interface GarminCredentials {
    region: GarminRegion;
    slot: GarminSlot;
    username: string;
    password: string;
}

interface SessionRow {
    region: GarminRegion;
    account_hash: string;
    version: number;
    salt: Buffer;
    iv: Buffer;
    tag: Buffer;
    ciphertext: Buffer;
}

interface EncryptedSession {
    accountHash: string;
    salt: Buffer;
    iv: Buffer;
    tag: Buffer;
    ciphertext: Buffer;
}

export interface SessionWriteResult {
    changed: boolean;
    created: boolean;
}

function expectedSlot(region: GarminRegion): GarminSlot {
    return region === 'CN' ? 'garmin-cn' : 'garmin-global';
}

function validateCredentials(credentials: GarminCredentials): void {
    if (credentials.slot !== expectedSlot(credentials.region) || !credentials.username || !credentials.password) {
        throw new SyncError('CONFIG', 'Garmin region, account and password configuration is incomplete.');
    }
}

function canonicalValue(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) result[key] = canonicalValue(item);
        }
        return result;
    }
    throw new SyncError('SESSION_INVALID', 'Garmin OAuth Session contains unsupported values.');
}

export function canonicalSession(saved: SavedSession): string {
    if (!saved || typeof saved !== 'object' || !saved.token || typeof saved.token !== 'object' ||
        !saved.token.oauth1 || typeof saved.token.oauth1 !== 'object' || Array.isArray(saved.token.oauth1) ||
        !saved.token.oauth2 || typeof saved.token.oauth2 !== 'object' || Array.isArray(saved.token.oauth2) ||
        typeof saved.token.oauth1.oauth_token !== 'string' ||
        typeof saved.token.oauth1.oauth_token_secret !== 'string' ||
        typeof saved.token.oauth2.access_token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(saved.loginHash)) {
        throw new SyncError('SESSION_INVALID', 'Garmin OAuth Session is incomplete.');
    }
    return JSON.stringify(canonicalValue(saved));
}

function accountHash(credentials: GarminCredentials): string {
    return garminAccountHash(credentials.slot, credentials.username);
}

function aad(credentials: GarminCredentials, hash: string): Buffer {
    return Buffer.from(`DailySync\0GarminSession\0${ENVELOPE_VERSION}\0${credentials.region}\0${hash}`, 'utf8');
}

function deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encryptSession(credentials: GarminCredentials, saved: SavedSession): EncryptedSession {
    validateCredentials(credentials);
    const hash = accountHash(credentials);
    if (saved.loginHash !== hash) {
        throw new SyncError('ACCOUNT_CHANGED', `Saved ${credentials.region} Session belongs to a different Garmin account.`);
    }
    const plaintext = Buffer.from(canonicalSession(saved), 'utf8');
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(credentials.password, salt), iv);
    cipher.setAAD(aad(credentials, hash));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { accountHash: hash, salt, iv, tag: cipher.getAuthTag(), ciphertext };
}

function validBuffer(value: unknown, size?: number): value is Buffer {
    return Buffer.isBuffer(value) && (size === undefined || value.length === size);
}

function decryptSession(row: SessionRow, credentials: GarminCredentials): SavedSession {
    validateCredentials(credentials);
    const hash = accountHash(credentials);
    try {
        if (row.region !== credentials.region || row.account_hash !== hash || row.version !== ENVELOPE_VERSION ||
            !validBuffer(row.salt, SALT_BYTES) || !validBuffer(row.iv, IV_BYTES) ||
            !validBuffer(row.tag, TAG_BYTES) || !validBuffer(row.ciphertext) || !row.ciphertext.length) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', deriveKey(credentials.password, row.salt), row.iv);
        decipher.setAAD(aad(credentials, hash));
        decipher.setAuthTag(row.tag);
        const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
        const saved = JSON.parse(plaintext) as SavedSession;
        canonicalSession(saved);
        if (saved.loginHash !== hash) throw new Error();
        return saved;
    } catch (_) {
        throw new SyncError('SESSION_DB_DECRYPT',
            `Cannot decrypt the ${credentials.region} Garmin Session; check the account, password and database.`);
    }
}

async function integrityCheck(db: Database): Promise<void> {
    const rows = await db.all<Record<string, string>[]>('PRAGMA integrity_check');
    if (rows.length !== 1 || Object.values(rows[0]!)[0] !== 'ok') {
        throw new SyncError('SESSION_DB_CORRUPT', 'Garmin Session database integrity check failed.');
    }
}

async function assertSchema(db: Database): Promise<void> {
    await integrityCheck(db);
    const version = await db.get<{ user_version: number }>('PRAGMA user_version');
    const tables = await db.all<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const columns = await db.all<{ name: string }[]>('PRAGMA table_info(garmin_session)');
    const expected = ['region', 'account_hash', 'version', 'salt', 'iv', 'tag', 'ciphertext'];
    if (version?.user_version !== SCHEMA_VERSION || tables.length !== 1 || tables[0]!.name !== 'garmin_session' ||
        columns.map(column => column.name).join(',') !== expected.join(',')) {
        throw new SyncError('SESSION_DB_SCHEMA', 'Garmin Session database schema is unsupported.');
    }
    const rows = await db.all<{ region: string; count: number }[]>(
        'SELECT region, COUNT(*) AS count FROM garmin_session GROUP BY region');
    if (rows.length !== 2 || rows.some(row => !['CN', 'GLOBAL'].includes(row.region) || row.count !== 1) ||
        !rows.some(row => row.region === 'CN') || !rows.some(row => row.region === 'GLOBAL')) {
        throw new SyncError('SESSION_DB_SCHEMA', 'Garmin Session database contains unexpected records.');
    }
}

async function openChecked(filename: string, mode: number): Promise<Database> {
    let db: Database | undefined;
    try {
        db = await open({ filename, driver: sqlite3.Database, mode });
        await assertSchema(db);
        return db;
    } catch (error) {
        await db?.close().catch(() => undefined);
        if (error instanceof SyncError) throw error;
        throw new SyncError('SESSION_DB_READ', 'Cannot open the Garmin Session database.');
    }
}

async function rowFor(db: Database, region: GarminRegion): Promise<SessionRow | undefined> {
    return db.get<SessionRow>('SELECT region, account_hash, version, salt, iv, tag, ciphertext FROM garmin_session WHERE region = ?', region);
}

export async function checkGarminSessionDatabase(filename: string): Promise<void> {
    const db = await openChecked(filename, sqlite3.OPEN_READONLY);
    await db.close();
}

export async function loadGarminSession(filename: string,
    credentials: GarminCredentials): Promise<SavedSession | undefined> {
    validateCredentials(credentials);
    const db = await openChecked(filename, sqlite3.OPEN_READONLY);
    try {
        const row = await rowFor(db, credentials.region);
        return row ? decryptSession(row, credentials) : undefined;
    } finally {
        await db.close();
    }
}

async function writeEncrypted(db: Database, credentials: GarminCredentials, encrypted: EncryptedSession): Promise<void> {
    await db.run(`INSERT INTO garmin_session (region, account_hash, version, salt, iv, tag, ciphertext)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(region) DO UPDATE SET account_hash = excluded.account_hash, version = excluded.version,
            salt = excluded.salt, iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext`,
    credentials.region, encrypted.accountHash, ENVELOPE_VERSION, encrypted.salt, encrypted.iv,
    encrypted.tag, encrypted.ciphertext);
}

async function updateSession(filename: string, credentials: GarminCredentials, saved: SavedSession,
    force: boolean, skipDecrypt = false): Promise<SessionWriteResult> {
    validateCredentials(credentials);
    let current: SavedSession | undefined;
    let existed = false;
    if (skipDecrypt) {
        const read = await openChecked(filename, sqlite3.OPEN_READONLY);
        try { existed = Boolean(await rowFor(read, credentials.region)); }
        finally { await read.close(); }
    } else {
        current = await loadGarminSession(filename, credentials);
        existed = Boolean(current);
    }
    if (!force && current && canonicalSession(current) === canonicalSession(saved)) {
        return { changed: false, created: false };
    }
    const encrypted = encryptSession(credentials, saved);
    const db = await openChecked(filename, sqlite3.OPEN_READWRITE);
    let committed = false;
    try {
        await db.exec('BEGIN IMMEDIATE');
        await writeEncrypted(db, credentials, encrypted);
        await integrityCheck(db);
        await db.exec('COMMIT');
        committed = true;
        return { changed: true, created: !existed };
    } catch (error) {
        if (!committed) await db.exec('ROLLBACK').catch(() => undefined);
        if (error instanceof SyncError) throw error;
        throw new SyncError('SESSION_DB_WRITE', `Cannot update the ${credentials.region} Garmin Session.`);
    } finally {
        await db.close();
    }
}

export function saveGarminSession(filename: string, credentials: GarminCredentials,
    saved: SavedSession): Promise<SessionWriteResult> {
    return updateSession(filename, credentials, saved, false);
}

export async function rekeyGarminSession(filename: string, current: GarminCredentials,
    newPassword: string): Promise<void> {
    if (!newPassword) throw new SyncError('CONFIG', 'The new Garmin password cannot be empty.');
    const saved = await loadGarminSession(filename, current);
    if (!saved) throw new SyncError('SESSION_MISSING', `No ${current.region} Garmin Session exists to re-encrypt.`);
    const next = { ...current, password: newPassword };
    await updateSession(filename, next, saved, true, true);
    await loadGarminSession(filename, next);
}

export function replaceGarminSession(filename: string, credentials: GarminCredentials,
    saved: SavedSession): Promise<SessionWriteResult> {
    return updateSession(filename, credentials, saved, true, true);
}

async function createSchema(db: Database): Promise<void> {
    await db.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        CREATE TABLE garmin_session (
            region TEXT PRIMARY KEY CHECK (region IN ('CN', 'GLOBAL')),
            account_hash TEXT NOT NULL CHECK (length(account_hash) = 64),
            version INTEGER NOT NULL CHECK (version = 1),
            salt BLOB NOT NULL CHECK (length(salt) = 16),
            iv BLOB NOT NULL CHECK (length(iv) = 12),
            tag BLOB NOT NULL CHECK (length(tag) = 16),
            ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0)
        ) WITHOUT ROWID;
        PRAGMA user_version = ${SCHEMA_VERSION};
    `);
}

export async function initializeGarminSessionDatabase(filename: string,
    entries: Array<{ credentials: GarminCredentials; saved: SavedSession }>): Promise<void> {
    const regions = new Set(entries.map(entry => entry.credentials.region));
    if (entries.length !== 2 || regions.size !== 2 || !regions.has('CN') || !regions.has('GLOBAL')) {
        throw new SyncError('SESSION_DB_INIT', 'Garmin Session initialization requires exactly CN and GLOBAL records.');
    }
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    let db: Database | undefined;
    try {
        db = await open({ filename: temp, driver: sqlite3.Database,
            mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE });
        await createSchema(db);
        await db.exec('BEGIN IMMEDIATE');
        for (const entry of entries) {
            await writeEncrypted(db, entry.credentials, encryptSession(entry.credentials, entry.saved));
        }
        await integrityCheck(db);
        await db.exec('COMMIT');
        await db.close();
        db = undefined;
        await fs.rename(temp, filename);
    } catch (error) {
        await db?.close().catch(() => undefined);
        await fs.rm(temp, { force: true }).catch(() => undefined);
        if (error instanceof SyncError) throw error;
        throw new SyncError('SESSION_DB_INIT', 'Cannot initialize the Garmin Session database.');
    }
}
