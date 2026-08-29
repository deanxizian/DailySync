import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { activityKey, emptyState, ROUTES, SLOTS, SyncState, transferKey } from './types';
import { SyncError } from './errors';
import { DEFAULT_AES_KEY } from './garmin-db';

const CryptoJS = require('crypto-js');
export const STATE_TABLE = 'coros_sync_state';

export function validateState(state: SyncState): void {
    const fail = () => { throw new SyncError('STATE_INVALID', 'Shared state schema or activity mappings are invalid.'); };
    const object = (value: any) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
    const id = (value: any) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    const hash = (value: any) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const metric = (value: any) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const summary = (value: any) => object(value) && Number.isFinite(value.start) && value.start > 0 &&
        typeof value.sport === 'string' && value.sport.length > 0 && metric(value.duration) && metric(value.distance);
    const evidence = (value: any) => summary(value) && hash(value.sha256) &&
        (value.device === undefined || hash(value.device)) && (value.records === undefined || hash(value.records));
    if (!state || state.version !== 1 || ![state.accounts, state.activities, state.transfers, state.sessions].every(object)) fail();
    for (const [slot, identity] of Object.entries(state.accounts)) {
        if (!SLOTS.includes(slot as any) || typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity!)) fail();
    }
    const canonicalSlots = new Map<string, string>();
    for (const [key, record] of Object.entries(state.activities)) {
        const activity = record?.activity;
        if (!summary(activity) || !SLOTS.includes(activity.slot) || !id(activity.id) ||
            !id(record.canonical) || !Number.isInteger(record.missing) || record.missing < 0 ||
            (record.evidence !== undefined && !evidence(record.evidence)) ||
            key !== activityKey(activity.slot, activity.id) || !state.accounts[activity.slot]) fail();
        const canonicalSlot = transferKey(record.canonical, activity.slot);
        if (canonicalSlots.has(canonicalSlot)) fail();
        canonicalSlots.set(canonicalSlot, activity.id);
    }
    for (const [key, transfer] of Object.entries(state.transfers)) {
        if (!transfer || !ROUTES.some(route => route.source === transfer.source && route.target === transfer.target) ||
            key !== transferKey(transfer.canonical, transfer.target) ||
            !['pending', 'uploading', 'verifying', 'complete', 'failed', 'review', 'ignored'].includes(transfer.status)) fail();
        const source = state.activities[activityKey(transfer.source, transfer.sourceId)];
        if (!source || source.canonical !== transfer.canonical || !/^[a-f0-9-]{36}$/.test(transfer.attempt) ||
            transfer.filename !== `dailysync_${transfer.attempt}.fit` || !Number.isFinite(transfer.createdAt) || transfer.createdAt <= 0 ||
            (transfer.evidence !== undefined && !evidence(transfer.evidence)) ||
            (['uploading', 'verifying'].includes(transfer.status) && (!transfer.evidence || !Array.isArray(transfer.beforeIds)))) fail();
        for (const list of [transfer.beforeIds, transfer.candidates]) if (list !== undefined && (!Array.isArray(list) || !list.every(id))) fail();
        if (transfer.receipt && (!['accepted', 'pending', 'duplicate', 'failed', 'retryable', 'unknown'].includes(transfer.receipt.status) ||
            (transfer.receipt.stage !== undefined && !['submitted', 'finished'].includes(transfer.receipt.stage)) ||
            (transfer.receipt.targetId !== undefined && !id(transfer.receipt.targetId)) ||
            (transfer.receipt.taskId !== undefined && !id(transfer.receipt.taskId)))) fail();
        if (transfer.status === 'complete' &&
            canonicalSlots.get(transferKey(transfer.canonical, transfer.target)) !== transfer.receipt?.targetId) fail();
    }
    for (const [slot, saved] of Object.entries(state.sessions)) {
        if (slot !== 'garmin-cn' || !saved || !hash(saved.loginHash) ||
            !object(saved.token?.oauth1) || !object(saved.token?.oauth2)) fail();
    }
}

function decryptState(payload: string, aesKey: string): SyncState {
    try {
        const plaintext = CryptoJS.AES.decrypt(payload, aesKey).toString(CryptoJS.enc.Utf8);
        const state = JSON.parse(plaintext);
        validateState(state);
        return state;
    } catch (_) {
        throw new SyncError('STATE_INVALID', 'Cannot decrypt or validate COROS sync state in db/garmin.db. No uploads are allowed.');
    }
}

function serializeState(state: SyncState): string {
    validateState(state);
    return JSON.stringify(state);
}

export class GarminDbState {
    private savedState?: string;

    private constructor(private readonly db: Database, private readonly writable: boolean, private readonly aesKey: string) {}

    static async open(filename: string, writable: boolean, aesKey = process.env.AESKEY || DEFAULT_AES_KEY): Promise<GarminDbState> {
        let db: Database | undefined;
        try {
            db = await open({ filename, driver: sqlite3.Database,
                mode: writable ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY });
            await db.exec('PRAGMA busy_timeout = 5000');
            const check = await db.get('PRAGMA integrity_check');
            if (!check || Object.values(check)[0] !== 'ok') throw new Error();
            if (writable) {
                await db.exec(`
                    PRAGMA journal_mode = DELETE;
                    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        payload TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                `);
            }
            return new GarminDbState(db, writable, aesKey);
        } catch (_) {
            await db?.close();
            throw new SyncError('GARMIN_DB_INVALID', 'Cannot open a valid db/garmin.db for COROS sync state.');
        }
    }

    async load(): Promise<SyncState | undefined> {
        try {
            const table = await this.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", STATE_TABLE);
            if (!table) return undefined;
            const row = await this.db.get(`SELECT payload FROM ${STATE_TABLE} WHERE id = 1`);
            if (!row) return undefined;
            if (typeof row.payload !== 'string') throw new Error();
            const state = decryptState(row.payload, this.aesKey);
            this.savedState = JSON.stringify(state);
            return state;
        } catch (error) {
            if (error instanceof SyncError) throw error;
            throw new SyncError('STATE_INVALID', 'Cannot read COROS sync state from db/garmin.db. No uploads are allowed.');
        }
    }

    async save(state: SyncState): Promise<void> {
        if (!this.writable) throw new SyncError('STATE_SAVE', 'A read-only preview cannot update db/garmin.db.');
        const serialized = serializeState(state);
        if (serialized === this.savedState) return;
        const payload = CryptoJS.AES.encrypt(serialized, this.aesKey).toString();
        await this.db.exec('BEGIN IMMEDIATE');
        try {
            await this.db.run(`
                INSERT INTO ${STATE_TABLE} (id, payload, updated_at) VALUES (1, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
            `, payload);
            await this.db.exec('COMMIT');
            this.savedState = serialized;
        } catch (_) {
            await this.db.exec('ROLLBACK');
            throw new SyncError('STATE_SAVE', 'Cannot save COROS sync state to db/garmin.db. Further uploads stopped.');
        }
    }

    async close(): Promise<void> {
        await this.db.close();
    }
}
