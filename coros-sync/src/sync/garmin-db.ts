import fs from 'fs/promises';
import path from 'path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { SavedSession } from './types';
import { garminLoginHash } from './garmin';
import { SyncError } from './errors';

const CryptoJS = require('crypto-js');
export const DEFAULT_AES_KEY = 'LSKDAJALSD';

function sessionToken(value: unknown): SavedSession['token'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const token = value as any;
    if (!token.oauth1 || typeof token.oauth1 !== 'object' || Array.isArray(token.oauth1) ||
        !token.oauth2 || typeof token.oauth2 !== 'object' || Array.isArray(token.oauth2) ||
        typeof token.oauth1.oauth_token !== 'string' || typeof token.oauth1.oauth_token_secret !== 'string' ||
        typeof token.oauth2.access_token !== 'string') throw new Error();
    return { oauth1: token.oauth1, oauth2: token.oauth2 };
}

export async function readGarminCnSession(root: string, username: string,
    aesKey = process.env.AESKEY || DEFAULT_AES_KEY): Promise<SavedSession> {
    if (!username) throw new SyncError('CONFIG', 'GARMIN_USERNAME is required to read the CN session from garmin.db.');
    const filename = path.join(root, 'db', 'garmin.db');
    try {
        const stat = await fs.stat(filename);
        if (!stat.isFile() || stat.size < 100) throw new Error();
    } catch (_) {
        throw new SyncError('GARMIN_DB_MISSING', 'db/garmin.db is missing; the bridge will not perform password login.');
    }
    let db;
    try {
        db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
        const row = await db.get('SELECT user, session FROM garmin_session WHERE region = ? AND user = ? ORDER BY id DESC LIMIT 1', 'CN', username);
        if (!row || row.user !== username || typeof row.session !== 'string') {
            throw new SyncError('GARMIN_SESSION_MISSING', 'garmin.db has no CN session for GARMIN_USERNAME.');
        }
        const plaintext = CryptoJS.AES.decrypt(row.session, aesKey).toString(CryptoJS.enc.Utf8);
        const token = sessionToken(JSON.parse(plaintext));
        return { loginHash: garminLoginHash(username), token };
    } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('GARMIN_DB_INVALID', 'Cannot read or decrypt the CN session in garmin.db.');
    } finally {
        await db?.close();
    }
}
