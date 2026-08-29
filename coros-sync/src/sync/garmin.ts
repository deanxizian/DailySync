import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Activity, ImportReceipt, PlatformAdapter, SavedSession, Transfer } from './types';
import { finiteNumber, remoteId, sleep, SyncError } from './errors';
import { extractSingleFit, MAX_FIT_BYTES } from './files';

const { GarminConnect } = require('@gooin/garmin-connect');
const UNUSED_PASSWORD = 'dailysync-read-only';

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

export class GarminCnReadOnlyAdapter implements PlatformAdapter {
    readonly slot = 'garmin-cn' as const;
    private readonly client: any;
    private readonly loginHash: string;

    constructor(private readonly username: string, client?: any, private readonly wait = sleep, private readonly pageSize = 100) {
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
            try {
                const url = new URL(String(config.url));
                oauthRefresh = method === 'post' && url.protocol === 'https:' && url.hostname === 'connectapi.garmin.cn' &&
                    url.pathname === '/oauth-service/oauth/exchange/user/2.0' && !url.username && !url.password && !url.port;
            } catch (_) {}
            if (!['get', 'head'].includes(method) && !oauthRefresh) {
                throw new SyncError('GARMIN_READ_ONLY', 'The COROS bridge cannot write to Garmin or perform password login.');
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
        if (!saved) throw new SyncError('GARMIN_SESSION_MISSING', 'Garmin CN session is missing from the encrypted bridge state.');
        if (saved.loginHash !== this.loginHash) throw new SyncError('ACCOUNT_CHANGED', 'garmin.db session does not match GARMIN_USERNAME.');
        await this.client.loadToken(saved.token.oauth1, saved.token.oauth2);
        const profile = await this.read<any>(() => this.client.getUserProfile());
        const identity = remoteId(profile?.profileId ?? profile?.displayName);
        return createHash('sha256').update(`garmin-cn:${identity}`).digest('hex');
    }

    session(): SavedSession { return { loginHash: this.loginHash, token: this.client.exportToken() }; }

    async page(cursor: number): Promise<{ activities: Activity[]; next: number | null }> {
        const rows = await this.read<any>(() => this.client.getActivities(cursor, this.pageSize));
        if (!Array.isArray(rows)) throw new SyncError('PROTOCOL', 'Garmin activity page is not a list.');
        return { activities: rows.map(normalizeGarmin), next: rows.length ? cursor + rows.length : null };
    }

    async download(activity: Activity, directory: string): Promise<string> {
        await this.read(() => this.client.downloadOriginalActivityData({ activityId: activity.id }, directory), true);
        const archive = path.join(directory, `${activity.id}.zip`);
        await fs.chmod(archive, 0o600);
        return extractSingleFit(archive, path.join(directory, 'original.fit'));
    }

    supports(): boolean { return false; }

    async upload(_file: string, _transfer: Transfer): Promise<ImportReceipt> {
        throw new SyncError('GARMIN_READ_ONLY', 'The COROS bridge cannot upload to Garmin.');
    }

    async verify(): Promise<ImportReceipt> { return { status: 'failed', code: 'GARMIN_READ_ONLY' }; }
}
