import axios, { AxiosRequestConfig } from 'axios';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import FormData from 'form-data';
import JSZip from 'jszip';
import { Activity, ActivityWindow, ImportReceipt, PlatformAdapter, Transfer } from '../core/types';
import { finiteNumber, remoteId, sleep, SyncError } from '../core/errors';
import { MAX_ACTIVITY_BYTES, MIN_ACTIVITY_BYTES } from '../formats/files';

const JSONbig = require('json-bigint')({ storeAsString: true, protoAction: 'error', constructorAction: 'error' });
const OSS = require('ali-oss');
const BASE = 'https://teamcnapi.coros.com';
const HUB = 'https://t.coros.com';
const STS_MARKER = '9y78gpoERW4lBNYL';
const AUTH_CODES = new Set(['1019', 'ACCESS_TOKEN_IS_INVALID']);
const SPORTS: Record<number, string> = {
    100: 'running', 101: 'running', 102: 'running', 103: 'running', 104: 'hiking', 105: 'climbing',
    200: 'cycling', 201: 'cycling', 202: 'cycling', 203: 'cycling', 204: 'cycling', 205: 'cycling', 299: 'cycling',
    300: 'swimming', 301: 'swimming', 400: 'cardio', 401: 'cardio', 402: 'strength',
    800: 'climbing', 801: 'climbing', 802: 'climbing', 900: 'walking',
};
const IMPORT_SPORTS = new Set(['running', 'cycling', 'hiking', 'walking', 'climbing', 'swimming', 'strength', 'cardio']);
const IMPORT_TASK_SCAN_SIZES = [10, 100];
const ACTIVITY_PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const ORPHAN_OBJECT_GRACE_MS = 15 * 60 * 1000;

function chinaDay(timestamp: number): string {
    return new Date(timestamp + CHINA_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

class CorosHttpError extends SyncError {
    constructor(public readonly status: number) {
        super('HTTP', `COROS returned HTTP ${status}.`);
    }
}

export interface HttpTransport {
    request(config: AxiosRequestConfig): Promise<{ status: number; data: any; headers?: Record<string, any> }>;
}

interface CorosOptions {
    username: string;
    password: string;
    http?: HttpTransport;
    ossFactory?: (options: Record<string, any>) => {
        put: (key: string, data: Buffer, options: any) => Promise<unknown>;
        head: (key: string) => Promise<{ status?: unknown; meta?: Record<string, unknown> | null;
            res?: { headers?: Record<string, unknown> } }>;
        delete: (key: string) => Promise<unknown>;
    };
    wait?: (milliseconds: number) => Promise<void>;
}

function objectAlreadyExists(error: any): boolean {
    return error?.status === 409 || error?.statusCode === 409 || error?.code === 'FileAlreadyExists';
}

function positiveNumber(value: unknown): number | null {
    const number = finiteNumber(value);
    return number !== null && number > 0 ? number : null;
}

export function normalizeCoros(row: any): Activity {
    const start = finiteNumber(row?.startTime);
    const sportCode = finiteNumber(row?.sportType);
    if (!start || start > 100000000000 || sportCode === null || !Number.isInteger(sportCode)) {
        throw new SyncError('PROTOCOL', 'COROS activity timestamp or sport type is invalid.');
    }
    return { slot: 'coros-cn', id: remoteId(row.labelId), start: start * 1000,
        sport: SPORTS[sportCode] ?? `coros-${sportCode}`, sportCode,
        // workoutTime matches the FIT timer duration; totalTime includes pauses.
        // Older imported rows use zero to mean that a summary field is unavailable.
        duration: positiveNumber(row.workoutTime) ?? positiveNumber(row.totalTime),
        distance: positiveNumber(row.distance) };
}

export function validDownloadUrl(value: unknown): string {
    try {
        const url = new URL(String(value));
        const allowed = ['coros.com', 'coros.com.cn', 'aliyuncs.com'];
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
            !allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error();
        return url.href;
    } catch (_) {
        throw new SyncError('DOWNLOAD_URL', 'COROS returned an unexpected download host or URL.');
    }
}

export class CorosAdapter implements PlatformAdapter {
    readonly slot = 'coros-cn' as const;
    private token = '';
    private userId = '';
    private relogins = 0;
    private readonly http: HttpTransport;
    private readonly wait: (milliseconds: number) => Promise<void>;

    constructor(private readonly options: CorosOptions) {
        this.http = options.http ?? axios.create();
        this.wait = options.wait ?? sleep;
    }

    private headers(): Record<string, string> {
        return { origin: HUB, referer: `${HUB}/`, accesstoken: this.token,
            cookie: `CPL-coros-region=2; CPL-coros-token=${this.token}`,
            YFHeader: JSON.stringify({ userId: this.userId, language: 'en-US' }) };
    }

    private async raw(config: AxiosRequestConfig, retryRead: boolean): Promise<any> {
        for (let attempt = 0; ; attempt++) {
            let response;
            try {
                response = await this.http.request({ timeout: 30000, maxRedirects: 0, maxContentLength: MAX_ACTIVITY_BYTES,
                    maxBodyLength: MAX_ACTIVITY_BYTES, validateStatus: () => true, transformResponse: [value => value], ...config });
            } catch (_) {
                if (retryRead && attempt < 3) { await this.wait(1000 * 2 ** attempt); continue; }
                throw new SyncError('TRANSPORT', 'COROS request did not return a usable response.');
            }
            if (retryRead && (response.status === 429 || response.status >= 500) && attempt < 3) {
                const retry = response.headers?.['retry-after'];
                const seconds = Number(retry);
                const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(retry)) - Date.now();
                if (delay > 120000) throw new SyncError('RATE_LIMIT', 'COROS requested a long retry delay; resume in a later run.');
                await this.wait(Math.max(1000 * 2 ** attempt, Number.isFinite(delay) ? delay : 0));
                continue;
            }
            if (response.status === 429) {
                throw new SyncError('RATE_LIMIT', 'COROS rate limit persisted after bounded retries; resume in a later run.');
            }
            if (response.status === 401 || response.status === 403) throw new SyncError('AUTH', 'COROS authentication was rejected.');
            if (response.status < 200 || response.status >= 300) throw new CorosHttpError(response.status);
            try { return typeof response.data === 'string' ? JSONbig.parse(response.data) : response.data; }
            catch (_) { throw new SyncError('PROTOCOL', 'COROS response was not valid JSON.'); }
        }
    }

    private async login(): Promise<void> {
        const result = await this.raw({ url: `${BASE}/account/login`, method: 'POST',
            headers: { origin: HUB, referer: `${HUB}/`, 'content-type': 'application/json' },
            data: { account: this.options.username, accountType: 2,
                pwd: createHash('md5').update(this.options.password).digest('hex') } }, false);
        if (result?.result !== '0000' || typeof result.data?.accessToken !== 'string' || !result.data.accessToken ||
            result.data.accessToken.length > 4096 || /[\x00-\x20\x7f;,]/.test(result.data.accessToken)) {
            throw new SyncError('AUTH', 'COROS password login failed or requires an interactive verification.');
        }
        this.token = result.data.accessToken;
    }

    private async api(endpoint: string, method: 'GET' | 'POST', data?: any, params?: any, read = true): Promise<any> {
        const perform = () => this.raw({ url: `${BASE}${endpoint}`, method, data, params,
            headers: { ...this.headers(), ...(data instanceof FormData ? data.getHeaders() : {}) } }, read);
        let result;
        try { result = await perform(); }
        catch (error) {
            if (!(error instanceof SyncError) || error.code !== 'AUTH' || !read || this.relogins >= 1) throw error;
            result = { result: '1019' };
        }
        if (AUTH_CODES.has(result?.result) && read && this.relogins < 1) {
            this.relogins++;
            await this.login();
            const profile = await this.api('/account/query', 'GET');
            if (this.userId && remoteId(profile?.userId) !== this.userId) throw new SyncError('ACCOUNT_CHANGED', 'COROS account changed during login.');
            result = await perform();
        }
        if (AUTH_CODES.has(result?.result)) throw new SyncError('AUTH', 'COROS session expired; no write was retried.');
        if (result?.result !== '0000') throw new SyncError('COROS_REJECTED', 'COROS rejected the request or changed its response contract.');
        return result.data;
    }

    async connect(): Promise<string> {
        if (!this.options.username || !this.options.password) throw new SyncError('CONFIG', 'COROS_USERNAME and COROS_PASSWORD are required.');
        await this.login();
        const profile = await this.api('/account/query', 'GET');
        this.userId = remoteId(profile?.userId);
        return createHash('sha256').update(`coros-cn:${this.userId}`).digest('hex');
    }

    async page(cursor: number, window?: ActivityWindow): Promise<{ activities: Activity[]; next: number | null; total: number }> {
        const pageNumber = Math.floor(cursor / ACTIVITY_PAGE_SIZE) + 1;
        const pageOffset = cursor % ACTIVITY_PAGE_SIZE;
        const params: Record<string, string | number> = { modeList: '', pageNumber, size: ACTIVITY_PAGE_SIZE };
        if (window) {
            if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start > window.end) {
                throw new SyncError('PROTOCOL', 'COROS activity window is invalid.');
            }
            // Training Hub filters calendar days. Include one day on each side for activities recorded outside UTC+8.
            params.startDay = chinaDay(window.start - DAY_MS);
            params.endDay = chinaDay(window.end + DAY_MS);
        }
        const data = await this.api('/activity/query', 'GET', undefined, params);
        const total = finiteNumber(data?.count);
        if (total === null || !Number.isSafeInteger(total)) {
            throw new SyncError('PROTOCOL', 'COROS activity page is missing a stable total count; scan is incomplete.');
        }
        if (data?.dataList === undefined) {
            const pageNumber = finiteNumber(data?.pageNumber);
            const totalPages = finiteNumber(data?.totalPage);
            const pastLastPage = pageNumber !== null && totalPages !== null &&
                Number.isSafeInteger(pageNumber) && Number.isSafeInteger(totalPages) &&
                pageNumber === Math.floor(cursor / ACTIVITY_PAGE_SIZE) + 1 && pageNumber > totalPages;
            if (total === 0 || pastLastPage) return { activities: [], next: null, total };
        }
        if (!Array.isArray(data?.dataList)) throw new SyncError('PROTOCOL', 'COROS activity page is missing dataList; scan is incomplete.');
        const activities = data.dataList.slice(pageOffset).map(normalizeCoros);
        return { activities, next: activities.length ? pageNumber * ACTIVITY_PAGE_SIZE : null, total };
    }

    async download(activity: Activity, directory: string): Promise<string> {
        let url: string;
        try {
            const data = await this.api('/activity/detail/download', 'POST', undefined,
                { labelId: activity.id, sportType: activity.sportCode, fileType: 4 });
            url = validDownloadUrl(data?.fileUrl);
        } catch (error) {
            const unavailable = error instanceof SyncError && (['COROS_REJECTED', 'DOWNLOAD_URL'].includes(error.code) ||
                (error instanceof CorosHttpError && [400, 404, 410, 422].includes(error.status)));
            if (!unavailable) throw error;
            throw new SyncError('DOWNLOAD', 'COROS original FIT export is unavailable for this activity.');
        }
        const filename = path.join(directory, 'original.fit');
        try {
            // Use a separate request without authentication headers, including on redirects.
            const response = await this.http.request({ url, method: 'GET', responseType: 'arraybuffer',
                timeout: 60000, maxRedirects: 0, maxContentLength: MAX_ACTIVITY_BYTES, validateStatus: () => true, headers: {} });
            if (response.status !== 200) throw new Error();
            const bytes = Buffer.from(response.data);
            if (bytes.length > MAX_ACTIVITY_BYTES || bytes.length < MIN_ACTIVITY_BYTES) throw new Error();
            await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
            return filename;
        } catch (_) {
            throw new SyncError('DOWNLOAD', 'COROS original FIT download failed.');
        }
    }

    supports(activity: Activity): boolean { return IMPORT_SPORTS.has(activity.sport); }

    async upload(file: string, transfer: Transfer): Promise<ImportReceipt> {
        let staging!: {
            client: {
                put: (key: string, data: Buffer, options: any) => Promise<unknown>;
                head: (key: string) => Promise<{ status?: unknown; meta?: Record<string, unknown> | null;
                    res?: { headers?: Record<string, unknown> } }>;
                delete: (key: string) => Promise<unknown>;
            };
            object: string;
            packed: Buffer;
            packedSha256: string;
            metadata: Record<string, string | number>;
        };
        try {
            const extension = path.extname(transfer.filename).toLowerCase();
            if (!/^dailysync_[a-f0-9]{32}\.(?:fit|tcx)$/.test(transfer.filename) ||
                path.extname(file).toLowerCase() !== extension) {
                return { status: 'failed', code: 'COROS_FILE_TYPE' };
            }
            const bytes = await fs.readFile(file);
            if (bytes.length < MIN_ACTIVITY_BYTES || bytes.length > MAX_ACTIVITY_BYTES) {
                return { status: 'failed', code: 'COROS_FILE_SIZE' };
            }
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            if (!transfer.evidence || transfer.evidence.sha256 !== sha256) {
                return { status: 'failed', code: 'COROS_FILE_MISMATCH' };
            }
            const stsResult = await this.raw({ url: `${HUB}/api/proxy/oss/sts`, method: 'GET',
                params: { bucket: 'coros-oss', service: 'aliyun', v: 2 },
                headers: { cookie: this.headers().cookie, referer: `${HUB}/` } }, true);
            if (stsResult?.code !== 200 || typeof stsResult.data?.credentials !== 'string') {
                throw new SyncError('COROS_STAGING_PROTOCOL', 'COROS returned invalid temporary storage credentials.');
            }
            const parts = stsResult.data.credentials.split(STS_MARKER);
            if (parts.length !== 2) throw new SyncError('COROS_STAGING_PROTOCOL', 'COROS temporary credentials have an invalid marker.');
            const encoded = parts.join('');
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
                throw new SyncError('COROS_STAGING_PROTOCOL', 'COROS temporary credentials are not valid Base64.');
            }
            const decoded = Buffer.from(encoded, 'base64').toString();
            let sts: any;
            try { sts = JSON.parse(decoded); }
            catch (_) { throw new SyncError('COROS_STAGING_PROTOCOL', 'COROS temporary credentials are not valid JSON.'); }
            if (!/^(oss-)?cn-[a-z0-9-]+$/.test(sts.Region) || !/^[a-z0-9-]{3,63}$/.test(sts.Bucket) ||
                !['AccessKeyId', 'AccessKeySecret', 'SecurityToken'].every(key => typeof sts[key] === 'string' && sts[key])) {
                throw new SyncError('COROS_STAGING_PROTOCOL', 'COROS temporary storage credentials are incomplete.');
            }
            const md5 = createHash('md5').update(bytes).digest('hex');
            const object = `fit_zip/${this.userId}/${md5}.zip`;
            const zip = new JSZip();
            zip.file(`${md5}/${transfer.filename}`, bytes,
                { date: new Date(Date.UTC(1980, 0, 1)), createFolders: false });
            const packed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
            const packedSha256 = createHash('sha256').update(packed).digest('hex');
            const factory = this.options.ossFactory ?? (options => new OSS(options));
            const client = factory({ region: sts.Region, bucket: sts.Bucket, accessKeyId: sts.AccessKeyId,
                accessKeySecret: sts.AccessKeySecret, stsToken: sts.SecurityToken, secure: true, timeout: 60000 });
            staging = { client, object, packed, packedSha256,
                metadata: { bucket: sts.Bucket, md5, size: bytes.length, object,
                    serviceName: 'aliyun', oriFileName: transfer.filename } };
        } catch (error) {
            if (!(error instanceof SyncError) || ['TRANSPORT', 'HTTP', 'RATE_LIMIT'].includes(error.code)) {
                return { status: 'retryable', code: error instanceof SyncError ? error.code : 'COROS_STAGING_RETRY' };
            }
            return { status: 'failed', code: error instanceof SyncError && error.code === 'AUTH' ? 'AUTH' : 'COROS_STAGING_FAILED' };
        }
        const put = () => staging.client.put(staging.object, staging.packed, {
                headers: { 'x-oss-forbid-overwrite': 'true' },
                meta: { 'dailysync-sha256': staging.packedSha256, 'dailysync-filename': transfer.filename },
            });
        try {
            await put();
        } catch (error) {
            if (objectAlreadyExists(error)) {
                let recovered: ImportReceipt;
                try {
                    recovered = await this.verify({ ...transfer,
                        receipt: { status: 'unknown', code: 'COROS_OBJECT_EXISTS' } });
                } catch (verifyError) {
                    if (verifyError instanceof SyncError && verifyError.code === 'AUTH') {
                        return { status: 'failed', code: 'AUTH' };
                    }
                    return { status: 'retryable', code: verifyError instanceof SyncError
                        ? verifyError.code : 'COROS_STAGING_VERIFY_RETRY' };
                }
                if (!(recovered.status === 'unknown' && recovered.code === 'COROS_TASK_NOT_VISIBLE')) {
                    return recovered;
                }
                let metadata;
                try { metadata = await staging.client.head(staging.object); }
                catch (_) { return { status: 'retryable', code: 'COROS_STAGING_VERIFY_RETRY' }; }
                const modified = Date.parse(String(metadata.res?.headers?.['last-modified'] ?? ''));
                const orphaned = metadata.status === 200 && metadata.meta?.['dailysync-sha256'] === staging.packedSha256 &&
                    metadata.meta?.['dailysync-filename'] === transfer.filename && Number.isFinite(modified) &&
                    Date.now() - modified >= ORPHAN_OBJECT_GRACE_MS;
                if (!orphaned) return { status: 'unknown', code: 'COROS_OBJECT_EXISTS' };
                // The task scan and aged matching metadata together identify an interrupted pre-submission object.
                try { await staging.client.delete(staging.object); }
                catch (_) { return { status: 'unknown', code: 'COROS_STAGING_CLEANUP_UNKNOWN' }; }
                try { await put(); }
                catch (retryError) {
                    return { status: objectAlreadyExists(retryError) ? 'unknown' : 'retryable',
                        code: objectAlreadyExists(retryError) ? 'COROS_OBJECT_EXISTS' : 'COROS_STAGING_RETRY' };
                }
            } else {
                return { status: 'retryable', code: error instanceof SyncError ? error.code : 'COROS_STAGING_RETRY' };
            }
        }
        const form = new FormData();
        // Training Hub encodes timezone in quarter-hours: UTC+8 is 32, even on a UTC runner.
        form.append('jsonParameter', JSON.stringify({ source: 1, timezone: 32, ...staging.metadata }));
        try {
            const data = await this.api('/activity/fit/import', 'POST', form, undefined, false);
            return { status: 'accepted', stage: 'submitted', taskId: remoteId(data?.id) };
        } catch (error) {
            const rejected = error instanceof SyncError && ['AUTH', 'RATE_LIMIT', 'COROS_REJECTED'].includes(error.code);
            if (rejected) {
                try { await staging.client.delete(staging.object); }
                catch (_) { return { status: 'unknown', code: 'COROS_STAGING_CLEANUP_UNKNOWN' }; }
                return { status: error.code === 'RATE_LIMIT' ? 'retryable' : 'failed', code: error.code };
            }
            return { status: 'unknown', code: 'COROS_IMPORT_UNKNOWN' };
        }
    }

    async verify(transfer: Transfer): Promise<ImportReceipt> {
        let matches: any[] = [];
        let saturated = false;
        for (const size of IMPORT_TASK_SCAN_SIZES) {
            const tasks = await this.api('/activity/fit/getImportSportList', 'POST', { size });
            if (!Array.isArray(tasks) || tasks.length > size) throw new SyncError('PROTOCOL', 'COROS import task list is invalid.');
            saturated = tasks.length === size;
            matches = tasks.filter(task => transfer.receipt?.taskId
                ? remoteId(task.id) === transfer.receipt.taskId
                : task.originalFilename === transfer.filename);
            if (matches.length || !saturated) break;
        }
        // Preflight also has the complete activity inventory and deterministic OSS key as duplicate guards.
        // Once a submission starts, a saturated task list cannot prove its outcome.
        if (!matches.length) return { ...transfer.receipt, status: 'unknown',
            code: saturated && transfer.receipt ? 'COROS_TASK_HISTORY_LIMIT' : 'COROS_TASK_NOT_VISIBLE' };
        if (matches.length > 1) return { ...transfer.receipt, status: 'unknown', code: 'COROS_TASK_AMBIGUOUS' };
        const task = matches[0];
        const taskId = remoteId(task.id);
        if ([0, 1, 3].includes(task.status)) return { status: 'pending', taskId };
        if (task.status === 2 && task.errorSize > 0) return { status: 'unknown', taskId, code: 'COROS_IMPORT_ERRORS' };
        if (task.status === 2 && !task.errorSize) return { status: 'accepted', stage: 'finished', taskId };
        if (task.status < 0) return { status: 'unknown', taskId, code: 'COROS_TASK_FAILED' };
        return { status: 'unknown', taskId, code: 'COROS_TASK_UNRECOGNIZED' };
    }
}
