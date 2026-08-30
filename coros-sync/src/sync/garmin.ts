import { createHash } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Activity, ActivityWindow, ImportReceipt, PlatformAdapter, SavedSession, Transfer } from './types';
import { finiteNumber, remoteId, sleep, SyncError } from './errors';
import { extractSingleFit, MAX_FIT_BYTES } from './files';

const { GarminConnect } = require('@gooin/garmin-connect');
const UNUSED_PASSWORD = 'dailysync-read-only';
const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function chinaDay(timestamp: number): string {
    return new Date(timestamp + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

export function garminLoginHash(username: string): string {
    return createHash('sha256').update(`garmin-cn:${username.trim().toLowerCase()}`).digest('hex');
}

function sportFamily(type: string): string {
    if (/running/.test(type)) return 'running';
    if (/cycling|biking/.test(type)) return 'cycling';
    if (/swimming/.test(type)) return 'swimming';
    return ({ hiking: 'hiking', walking: 'walking', strength_training: 'strength',
        cardio_training: 'cardio', indoor_cardio: 'cardio', fitness_equipment: 'cardio', indoor_climbing: 'climbing',
        rock_climbing: 'climbing', bouldering: 'climbing' } as Record<string, string>)[type] ?? `garmin-${type}`;
}

export function normalizeGarmin(row: any): Activity {
    const text = row?.startTimeGMT;
    let start = typeof row?.beginTimestamp === 'number' ? row.beginTimestamp : NaN;
    if (typeof text === 'string') start = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    if (!Number.isFinite(start) || start <= 0 || typeof row?.activityType?.typeKey !== 'string') {
        throw new SyncError('PROTOCOL', 'Garmin activity has no unambiguous UTC start time or activity type.');
    }
    return { slot: 'garmin-cn', id: remoteId(row.activityId), start, sport: sportFamily(row.activityType.typeKey),
        duration: finiteNumber(row.duration), distance: finiteNumber(row.distance) };
}

function httpStatus(error: any): number | undefined {
    const status = error?.response?.status;
    if (Number.isInteger(status)) return status;
    const match = typeof error?.message === 'string' ? /^ERROR: \((\d{3})\)/.exec(error.message) : null;
    return match ? Number(match[1]) : undefined;
}

async function quiet<T>(action: () => Promise<T>): Promise<T> {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try { return await action(); }
    finally { Object.assign(console, saved); }
}

function quietSync<T>(action: () => T): T {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try { return action(); }
    finally { Object.assign(console, saved); }
}

class GarminCnAdapter implements PlatformAdapter {
    readonly slot = 'garmin-cn' as const;
    private readonly client: any;
    private readonly loginHash: string;

    constructor(private readonly username: string, client?: any, private readonly wait = sleep,
        private readonly pageSize = 100, private readonly writable = false) {
        if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new SyncError('CONFIG', 'Garmin page size must be a positive integer.');
        this.loginHash = garminLoginHash(username);
        // The SDK requires a non-empty constructor value even when an existing OAuth session is loaded.
        this.client = client ?? quietSync(() => new GarminConnect({ username, password: UNUSED_PASSWORD }, 'garmin.cn'));
        const http = this.client.client?.client;
        if (!http) return;
        http.defaults.timeout = 60000;
        http.defaults.maxContentLength = MAX_FIT_BYTES;
        http.defaults.maxBodyLength = MAX_FIT_BYTES;
        // This owned client permits reads plus the OAuth exchange needed to keep an existing session alive.
        http.interceptors.response.eject(0);
        http.interceptors.request.use(async (config: any) => {
            const method = String(config.method ?? 'get').toLowerCase();
            let oauthRefresh = false;
            let activityUpload = false;
            try {
                const url = new URL(String(config.url));
                oauthRefresh = method === 'post' && url.protocol === 'https:' && url.hostname === 'connectapi.garmin.cn' &&
                    url.pathname === '/oauth-service/oauth/exchange/user/2.0' && !url.username && !url.password && !url.port;
                activityUpload = this.writable && method === 'post' && url.protocol === 'https:' &&
                    url.hostname === 'connectapi.garmin.cn' && url.pathname === '/upload-service/upload/.fit' &&
                    !url.username && !url.password && !url.port;
            } catch (_) {}
            if (!['get', 'head'].includes(method) && !oauthRefresh && !activityUpload) {
                throw new SyncError('GARMIN_READ_ONLY', 'The COROS bridge permits only FIT activity uploads and OAuth refreshes.');
            }
            return config;
        });
        http.interceptors.response.use(undefined, async (error: any) => {
            if (error instanceof SyncError) throw error;
            const request = error?.config;
            const status = error?.response?.status;
            if (status === 401 && request && ['get', 'head'].includes(String(request.method).toLowerCase()) &&
                !request._corosBridgeRefreshed && this.client.client.oauth2Token) {
                request._corosBridgeRefreshed = true;
                await this.client.client.refreshOauth2Token();
                return http.request(request);
            }
            const sanitized: any = new Error(Number.isInteger(status) ? `ERROR: (${status}), Garmin request failed.` : 'Garmin request failed.');
            if (Number.isInteger(status)) sanitized.response = { status, headers: { 'retry-after': error.response.headers?.['retry-after'] } };
            throw sanitized;
        });
    }

    private async read<T>(action: () => Promise<T>, activityExport = false): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try { return await quiet(action); }
            catch (error) {
                if (error instanceof SyncError) throw error;
                const status = httpStatus(error);
                if (attempt < 3 && (status === undefined || [408, 425, 429].includes(status ?? 0) || (status ?? 0) >= 500)) {
                    const retry = (error as any)?.response?.headers?.['retry-after'];
                    const seconds = Number(retry);
                    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(retry)) - Date.now();
                    if (delay > 120000) throw new SyncError('RATE_LIMIT', 'Garmin requested a long retry delay.');
                    await this.wait(Math.max(1000 * 2 ** attempt, Number.isFinite(delay) ? delay : 0));
                    continue;
                }
                if (activityExport && status !== undefined && status >= 400 && status < 500 &&
                    ![401, 403, 408, 425, 429].includes(status)) {
                    throw new SyncError('GARMIN_EXPORT_UNAVAILABLE',
                        `Garmin activity export is permanently unavailable (HTTP ${status}).`);
                }
                throw new SyncError(status === 401 || status === 403 ? 'GARMIN_SESSION_INVALID' : 'GARMIN_READ',
                    `Garmin CN session read failed${status ? ` (HTTP ${status})` : ''}; password login was not attempted.`);
            }
        }
    }

    async connect(saved?: SavedSession): Promise<string> {
        if (!this.username) throw new SyncError('CONFIG', 'GARMIN_USERNAME is required to select the CN session in garmin.db.');
        if (!saved) throw new SyncError('GARMIN_SESSION_MISSING', 'Garmin CN session is missing from db/garmin.db.');
        if (saved.loginHash !== this.loginHash) throw new SyncError('ACCOUNT_CHANGED', 'garmin.db session does not match GARMIN_USERNAME.');
        await this.client.loadToken(saved.token.oauth1, saved.token.oauth2);
        const profile = await this.read<any>(() => this.client.getUserProfile());
        const identity = remoteId(profile?.profileId ?? profile?.displayName);
        return createHash('sha256').update(`garmin-cn:${identity}`).digest('hex');
    }

    async page(cursor: number, window?: ActivityWindow): Promise<{ activities: Activity[]; next: number | null }> {
        if (window && (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start > window.end)) {
            throw new SyncError('PROTOCOL', 'Garmin activity window is invalid.');
        }
        const startDate = window ? chinaDay(window.start - DAY_MS) : undefined;
        const endDate = window ? chinaDay(window.end + DAY_MS) : undefined;
        const rows = await this.read<any>(() => this.client.getActivities(cursor, this.pageSize,
            undefined, undefined, undefined, undefined, undefined, startDate, endDate));
        if (!Array.isArray(rows)) throw new SyncError('PROTOCOL', 'Garmin activity page is not a list.');
        return { activities: rows.map(normalizeGarmin), next: rows.length ? cursor + rows.length : null };
    }

    async download(activity: Activity, directory: string): Promise<string> {
        await this.read(() => this.client.downloadOriginalActivityData({ activityId: activity.id }, directory), true);
        const archive = path.join(directory, `${activity.id}.zip`);
        await fs.chmod(archive, 0o600);
        return extractSingleFit(archive, path.join(directory, 'original.fit'));
    }

    supports(): boolean { return this.writable; }

    async upload(file: string, transfer: Transfer): Promise<ImportReceipt> {
        if (!this.writable) throw new SyncError('GARMIN_READ_ONLY', 'The COROS bridge cannot upload through a read-only Garmin adapter.');
        if (!/^dailysync_[a-f0-9]{32}\.fit$/.test(transfer.filename)) {
            return { status: 'failed', code: 'GARMIN_UPLOAD_FILENAME' };
        }
        const staged = path.join(path.dirname(file), transfer.filename);
        try {
            await fs.copyFile(file, staged, constants.COPYFILE_EXCL);
            await fs.chmod(staged, 0o600);
        } catch (_) {
            return { status: 'failed', code: 'GARMIN_UPLOAD_PREPARE' };
        }
        try {
            await quiet(() => this.client.uploadActivity(staged, 'fit'));
            return { status: 'accepted', stage: 'finished' };
        } catch (error) {
            if (error instanceof SyncError) return { status: 'failed', code: error.code };
            const status = httpStatus(error);
            if (status === 409) return { status: 'duplicate', stage: 'finished' };
            if (status === 401 || status === 403) return { status: 'failed', code: 'AUTH' };
            if (status !== undefined && [408, 425, 429].includes(status)) {
                return { status: 'retryable', code: status === 429 ? 'RATE_LIMIT' : 'GARMIN_UPLOAD_RETRY' };
            }
            if (status !== undefined && status >= 400 && status < 500) {
                return { status: 'failed', code: 'GARMIN_IMPORT_REJECTED' };
            }
            return { status: 'unknown', code: 'GARMIN_UPLOAD_UNKNOWN' };
        } finally {
            await fs.rm(staged, { force: true }).catch(() => {});
        }
    }

    async verify(transfer: Transfer): Promise<ImportReceipt> {
        if (!this.writable) return { status: 'failed', code: 'GARMIN_READ_ONLY' };
        if (!transfer.receipt) return { status: 'unknown', code: 'GARMIN_UPLOAD_NOT_VISIBLE' };
        if (transfer.receipt.status === 'accepted') return { ...transfer.receipt, stage: 'finished' };
        if (transfer.receipt.status === 'duplicate') return { ...transfer.receipt, stage: 'finished' };
        if (transfer.receipt.status === 'unknown' && transfer.receipt.code === 'GARMIN_UPLOAD_UNKNOWN') {
            return { ...transfer.receipt, status: 'pending' };
        }
        return { ...transfer.receipt };
    }
}

export class GarminCnReadOnlyAdapter extends GarminCnAdapter {
    constructor(username: string, client?: any, wait = sleep, pageSize = 100) {
        super(username, client, wait, pageSize, false);
    }
}

export class GarminCnUploadAdapter extends GarminCnAdapter {
    constructor(username: string, client?: any, wait = sleep, pageSize = 100) {
        super(username, client, wait, pageSize, true);
    }
}
