import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_AES_KEY } from './garmin-db';
import { SyncError } from './errors';
import { validateState } from './state';
import { activityKey, emptyState, SLOTS, SyncState, transferKey, UploadIntent } from './types';

const CryptoJS = require('crypto-js');

export const UPLOAD_INTENT_PATH = 'coros-sync/.upload-intent.enc';
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_ENCRYPTED_BYTES = 512 * 1024;

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

export function validateUploadIntent(intent: UploadIntent): void {
    const fail = () => { throw new SyncError('STATE_INVALID', 'The durable COROS upload intent is invalid.'); };
    if (!intent || intent.version !== 1 || !intent.accounts || !intent.source || !intent.transfer) fail();
    for (const slot of SLOTS) {
        if (typeof intent.accounts[slot] !== 'string' || !/^[a-f0-9]{64}$/.test(intent.accounts[slot])) fail();
    }
    if (Object.keys(intent.accounts).length !== SLOTS.length || intent.source.missing !== 0 ||
        intent.transfer.status !== 'uploading' || intent.transfer.receipt !== undefined) fail();
    const state = emptyState();
    state.accounts = clone(intent.accounts);
    state.activities[activityKey(intent.source.activity.slot, intent.source.activity.id)] = clone(intent.source);
    state.transfers[transferKey(intent.transfer.canonical, intent.transfer.target)] = clone(intent.transfer);
    validateState(state);
}

export function createUploadIntent(state: SyncState, transfer: UploadIntent['transfer']): UploadIntent {
    const source = state.activities[activityKey(transfer.source, transfer.sourceId)];
    const accounts = Object.fromEntries(SLOTS.map(slot => [slot, state.accounts[slot]])) as Record<typeof SLOTS[number], string>;
    const intent: UploadIntent = { version: 1, accounts, source: clone(source), transfer: clone(transfer) };
    validateUploadIntent(intent);
    return intent;
}

function encryptedPayload(intent: UploadIntent, aesKey: string): string {
    validateUploadIntent(intent);
    const serialized = JSON.stringify(intent);
    if (Buffer.byteLength(serialized) > MAX_PLAINTEXT_BYTES) {
        throw new SyncError('STATE_PUBLISH', 'The COROS upload intent is too large to publish safely.');
    }
    return CryptoJS.AES.encrypt(serialized, aesKey).toString();
}

function effectiveAesKey(aesKey?: string): string {
    return aesKey || process.env.AESKEY || DEFAULT_AES_KEY;
}

export async function writeUploadIntent(root: string, intent: UploadIntent,
    aesKey?: string): Promise<void> {
    const filename = path.join(root, UPLOAD_INTENT_PATH);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(temporary, encryptedPayload(intent, effectiveAesKey(aesKey)),
            { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (error instanceof SyncError) throw error;
        throw new SyncError('STATE_PUBLISH', 'Cannot write the durable COROS upload intent.');
    }
}

export async function readUploadIntent(root: string,
    aesKey?: string): Promise<UploadIntent | undefined> {
    const filename = path.join(root, UPLOAD_INTENT_PATH);
    let payload: string;
    try { payload = await fs.readFile(filename, 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new SyncError('STATE_INVALID', 'Cannot read the durable COROS upload intent.');
    }
    try {
        if (Buffer.byteLength(payload) > MAX_ENCRYPTED_BYTES) throw new Error();
        const plaintext = CryptoJS.AES.decrypt(payload, effectiveAesKey(aesKey)).toString(CryptoJS.enc.Utf8);
        if (!plaintext || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw new Error();
        const intent = JSON.parse(plaintext) as UploadIntent;
        validateUploadIntent(intent);
        return intent;
    } catch (_) {
        throw new SyncError('STATE_INVALID', 'Cannot decrypt or validate the durable COROS upload intent.');
    }
}

export function mergeUploadIntent(state: SyncState, intent: UploadIntent): SyncState {
    validateState(state);
    validateUploadIntent(intent);
    for (const slot of SLOTS) {
        const current = state.accounts[slot];
        if (current && current !== intent.accounts[slot]) {
            throw new SyncError('STATE_INVALID', 'The durable upload intent belongs to a different account.');
        }
        state.accounts[slot] = intent.accounts[slot];
    }

    const sourceKey = activityKey(intent.source.activity.slot, intent.source.activity.id);
    const currentSource = state.activities[sourceKey];
    if (currentSource && currentSource.canonical !== intent.source.canonical) {
        throw new SyncError('STATE_INVALID', 'The durable upload intent conflicts with the saved activity mapping.');
    }
    if (!currentSource) state.activities[sourceKey] = clone(intent.source);
    else if (!currentSource.evidence && intent.source.evidence) currentSource.evidence = clone(intent.source.evidence);

    const taskKey = transferKey(intent.transfer.canonical, intent.transfer.target);
    const currentTask = state.transfers[taskKey];
    if (currentTask && currentTask.attempt !== intent.transfer.attempt) {
        throw new SyncError('STATE_INVALID', 'The durable upload intent conflicts with a different transfer attempt.');
    }
    if (!currentTask || currentTask.status === 'pending') state.transfers[taskKey] = clone(intent.transfer);
    validateState(state);
    return state;
}

export async function clearUploadIntent(root: string): Promise<void> {
    try { await fs.unlink(path.join(root, UPLOAD_INTENT_PATH)); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new SyncError('STATE_SAVE', 'Cannot clear the durable COROS upload intent.');
        }
    }
}
