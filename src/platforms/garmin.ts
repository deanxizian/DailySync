import { createHash } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { garminAccountHash } from '../core/account';
import { Activity, ActivityWindow, GarminSlot, ImportReceipt, PlatformAdapter, SavedSession, Transfer } from '../core/types';
import { finiteNumber, remoteId, sleep, SyncError } from '../core/errors';
import { extractGarminActivity, MAX_ACTIVITY_BYTES } from '../formats/files';

const { GarminConnect } = require('@gooin/garmin-connect');
const { canonicalSport } = require('../core/sports.js') as { canonicalSport: (value: unknown) => string };
const DAY_MS = 24 * 60 * 60 * 1000;

export type GarminRegion = 'CN' | 'GLOBAL';

interface GarminRegionConfig {
    slot: GarminSlot;
    domain: 'garmin.cn' | 'garmin.com';
    apiHost: 'connectapi.garmin.cn' | 'connectapi.garmin.com';
    label: string;
}

const REGIONS: Record<GarminRegion, GarminRegionConfig> = {
    CN: { slot: 'garmin-cn', domain: 'garmin.cn', apiHost: 'connectapi.garmin.cn', label: 'Garmin CN' },
    GLOBAL: { slot: 'garmin-global', domain: 'garmin.com', apiHost: 'connectapi.garmin.com', label: 'Garmin Global' },
};

export interface GarminAdapterOptions {
    region: GarminRegion;
    username: string;
    password: string;
    client?: any;
    wait?: (milliseconds: number) => Promise<void>;
    pageSize?: number;
    writable?: boolean;
}

function utcDay(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

export function normalizeGarmin(row: any, slot: GarminSlot = 'garmin-cn'): Activity {
    const text = row?.startTimeGMT;
    let start = typeof row?.beginTimestamp === 'number' ? row.beginTimestamp : NaN;
    if (typeof text === 'string') start = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    if (!Number.isFinite(start) || start <= 0 || typeof row?.activityType?.typeKey !== 'string') {
        throw new SyncError('PROTOCOL', 'Garmin activity has no unambiguous UTC start time or activity type.');
    }
    const sport = canonicalSport(row.activityType.typeKey);
    if (!sport) throw new SyncError('PROTOCOL', 'Garmin activity type is invalid.');
    return { slot, id: remoteId(row.activityId), start, sport,
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

export class GarminAdapter implements PlatformAdapter {
    readonly slot: GarminSlot;
    private readonly client: any;
    private readonly loginHash: string;
    private readonly config: GarminRegionConfig;
    private readonly wait: (milliseconds: number) => Promise<void>;
    private readonly pageSize: number;
    private readonly writable: boolean;
    private loginInProgress = false;
    private connected = false;

    constructor(private readonly options: GarminAdapterOptions) {
        this.config = REGIONS[options.region];
        this.slot = this.config.slot;
        this.wait = options.wait ?? sleep;
        this.pageSize = options.pageSize ?? 100;
        this.writable = options.writable ?? false;
        if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) {
            throw new SyncError('CONFIG', 'Garmin page size must be a positive integer.');
        }
        this.loginHash = garminAccountHash(this.slot, options.username);
        this.client = options.client ?? quietSync(() => new GarminConnect({
            username: options.username,
            password: options.password,
        }, this.config.domain));
        const http = this.client.client?.client;
        if (!http) return;
        http.defaults.timeout = 60000;
        http.defaults.maxContentLength = MAX_ACTIVITY_BYTES;
        http.defaults.maxBodyLength = MAX_ACTIVITY_BYTES;
        http.interceptors.response.eject(0);
        http.interceptors.request.use(async (config: any) => {
            const method = String(config.method ?? 'get').toLowerCase();
            let oauthRefresh = false;
            let activityUpload = false;
            let passwordLogin = false;
            try {
                const url = new URL(String(config.url));
                const safeUrl = url.protocol === 'https:' && !url.username && !url.password && !url.port;
                oauthRefresh = method === 'post' && safeUrl && url.hostname === this.config.apiHost &&
                    url.pathname === '/oauth-service/oauth/exchange/user/2.0';
                activityUpload = this.writable && method === 'post' && safeUrl && url.hostname === this.config.apiHost &&
                    ['/upload-service/upload/.fit', '/upload-service/upload/.tcx'].includes(url.pathname);
                passwordLogin = this.loginInProgress && safeUrl &&
                    (url.hostname === this.config.domain || url.hostname.endsWith(`.${this.config.domain}`));
            } catch (_) {}
            if (!['get', 'head'].includes(method) && !oauthRefresh && !activityUpload && !passwordLogin) {
                throw new SyncError('GARMIN_WRITE_BLOCKED', 'Garmin permits only login, OAuth refresh and activity upload writes.');
            }
            return config;
        });
        http.interceptors.response.use(undefined, async (error: any) => {
            if (error instanceof SyncError) throw error;
            const request = error?.config;
            const status = error?.response?.status;
            if (status === 401 && request && ['get', 'head'].includes(String(request.method).toLowerCase()) &&
                !request._dailySyncRefreshed && this.client.client.oauth2Token) {
                request._dailySyncRefreshed = true;
                await this.client.client.refreshOauth2Token();
                return http.request(request);
            }
            const sanitized: any = new Error(Number.isInteger(status) ? `ERROR: (${status}), Garmin request failed.` : 'Garmin request failed.');
            if (Number.isInteger(status)) {
                sanitized.response = { status, headers: { 'retry-after': error.response.headers?.['retry-after'] } };
            }
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
                    if (delay > 120000) throw new SyncError('RATE_LIMIT', `${this.config.label} requested a long retry delay.`);
                    await this.wait(Math.max(1000 * 2 ** attempt, Number.isFinite(delay) ? delay : 0));
                    continue;
                }
                if (activityExport && status !== undefined && status >= 400 && status < 500 &&
                    ![401, 403, 408, 425, 429].includes(status)) {
                    throw new SyncError('GARMIN_EXPORT_UNAVAILABLE',
                        `${this.config.label} activity export is permanently unavailable (HTTP ${status}).`);
                }
                throw new SyncError(status === 401 || status === 403 ? 'GARMIN_SESSION_INVALID' : 'GARMIN_READ',
                    `${this.config.label} request failed${status ? ` (HTTP ${status})` : ''}.`);
            }
        }
    }

    private async passwordLogin(): Promise<any> {
        if (!this.options.password) throw new SyncError('CONFIG', `${this.config.label} password is required.`);
        this.loginInProgress = true;
        try { await quiet(() => this.client.login(this.options.username, this.options.password)); }
        catch (error) {
            const status = httpStatus(error);
            if (status === 429) throw new SyncError('RATE_LIMIT', `${this.config.label} password login was rate limited.`);
            if (status === 401 || status === 403) throw new SyncError('AUTH', `${this.config.label} password login was rejected.`);
            throw new SyncError('GARMIN_LOGIN', `${this.config.label} password login failed or requires interactive verification.`);
        } finally {
            this.loginInProgress = false;
        }
        return this.read<any>(() => this.client.getUserProfile());
    }

    async connect(saved?: SavedSession): Promise<string> {
        if (!this.options.username || !this.options.password) {
            throw new SyncError('CONFIG', `${this.config.label} username and password are required.`);
        }
        let profile: any;
        if (saved) {
            if (saved.loginHash !== this.loginHash) {
                throw new SyncError('ACCOUNT_CHANGED', `${this.config.label} saved session belongs to a different account.`);
            }
            await this.client.loadToken(saved.token.oauth1, saved.token.oauth2);
            try { profile = await this.read<any>(() => this.client.getUserProfile()); }
            catch (error) {
                if (!(error instanceof SyncError) || error.code !== 'GARMIN_SESSION_INVALID') throw error;
                profile = await this.passwordLogin();
            }
        } else {
            profile = await this.passwordLogin();
        }
        const identity = remoteId(profile?.profileId ?? profile?.displayName ?? profile?.userName);
        this.connected = true;
        return createHash('sha256').update(`${this.slot}:${identity}`).digest('hex');
    }

    exportSession(): SavedSession | undefined {
        if (!this.connected) return undefined;
        try {
            const token = this.client.exportToken();
            if (!token?.oauth1 || !token?.oauth2) return undefined;
            return { loginHash: this.loginHash, token: { oauth1: token.oauth1, oauth2: token.oauth2 } };
        } catch (_) {
            return undefined;
        }
    }

    async page(cursor: number, window?: ActivityWindow): Promise<{ activities: Activity[]; next: number | null }> {
        if (window && (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start > window.end)) {
            throw new SyncError('PROTOCOL', 'Garmin activity window is invalid.');
        }
        const startDate = window ? utcDay(window.start - DAY_MS) : undefined;
        const endDate = window ? utcDay(window.end + DAY_MS) : undefined;
        const rows = await this.read<any>(() => this.client.getActivities(cursor, this.pageSize,
            undefined, undefined, undefined, undefined, undefined, startDate, endDate));
        if (!Array.isArray(rows)) throw new SyncError('PROTOCOL', 'Garmin activity page is not a list.');
        return { activities: rows.map((row: any) => normalizeGarmin(row, this.slot)),
            next: rows.length ? cursor + rows.length : null };
    }

    async download(activity: Activity, directory: string): Promise<string> {
        await this.read(() => this.client.downloadOriginalActivityData({ activityId: activity.id }, directory), true);
        const archive = path.join(directory, `${activity.id}.zip`);
        await fs.chmod(archive, 0o600);
        return extractGarminActivity(archive, directory, activity);
    }

    supports(): boolean { return this.writable; }

    async upload(file: string, transfer: Transfer): Promise<ImportReceipt> {
        if (!this.writable) throw new SyncError('GARMIN_WRITE_BLOCKED', `${this.config.label} adapter is read-only.`);
        const format = path.extname(transfer.filename).slice(1).toLowerCase();
        if (!/^dailysync_[a-f0-9]{32}\.(?:fit|tcx)$/.test(transfer.filename) ||
            path.extname(file).slice(1).toLowerCase() !== format) {
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
            await quiet(() => this.client.uploadActivity(staged, format));
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
        if (!this.writable) return { status: 'failed', code: 'GARMIN_WRITE_BLOCKED' };
        if (!transfer.receipt) return { status: 'unknown', code: 'GARMIN_UPLOAD_NOT_VISIBLE' };
        if (transfer.receipt.status === 'accepted') return { ...transfer.receipt, stage: 'finished' };
        if (transfer.receipt.status === 'duplicate') return { ...transfer.receipt, stage: 'finished' };
        if (transfer.receipt.status === 'unknown' && transfer.receipt.code === 'GARMIN_UPLOAD_UNKNOWN') {
            return { ...transfer.receipt, status: 'pending' };
        }
        return { ...transfer.receipt };
    }
}
