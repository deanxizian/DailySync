import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Activity, ActivityWindow, activityKey, Evidence, ImportReceipt, PlatformAdapter, SavedSession, SyncRoute, Transfer } from './types';
import { ActivityFileFormat, activityFileFormat, readEvidence } from '../formats/files';
import { sleep, SyncError } from './errors';

export interface SyncEvent {
    route: SyncRoute;
    source: string;
    status: 'uploaded' | 'existing' | 'review' | 'verifying' | 'failed' | 'unsupported' | 'deferred';
    targetId?: string;
    code?: string;
    candidates?: string[];
}

export type SyncOutcome = 'success' | 'partial' | 'incomplete' | 'failed';

export function syncOutcome(events: SyncEvent[]): SyncOutcome {
    if (events.some(event => ['verifying', 'deferred'].includes(event.status))) return 'incomplete';
    if (events.some(event => event.status === 'failed')) {
        return events.some(event => event.status === 'uploaded') ? 'partial' : 'failed';
    }
    return events.some(event => ['review', 'unsupported'].includes(event.status)) ? 'partial' : 'success';
}

export function syncExitCode(_events: SyncEvent[]): number {
    // Item-level outcomes are reported as warnings. Errors that make the run itself
    // unreliable (authentication, incomplete scans, state failures, etc.) throw.
    return 0;
}

export interface SyncOptions {
    activityId?: string;
    transferLimit?: number;
    pollAttempts?: number;
}

interface EngineDependencies {
    source: PlatformAdapter;
    target: PlatformAdapter;
    sourceSession?: SavedSession;
    targetSession?: SavedSession;
    directory: string;
    evidence?: (file: string, expected?: Activity) => Promise<Evidence>;
    wait?: (ms: number) => Promise<void>;
    emit?: (event: SyncEvent) => void;
}

interface CandidateResult {
    status: 'absent' | 'existing' | 'review' | 'deferred';
    target?: Activity;
    code?: string;
    candidates?: string[];
}

interface ReconcileResult {
    status: 'complete' | 'verifying' | 'failed' | 'deferred';
    target?: Activity;
    code?: string;
    candidates?: string[];
}

interface DownloadedActivity {
    file: string;
    evidence: Evidence;
    format: ActivityFileFormat;
    summaryMatches: boolean;
}

const TERMINAL_IMPORT_CODES = new Set(['COROS_IMPORT_ERRORS', 'COROS_TASK_FAILED']);
const SYSTEMIC_IMPORT_CODES = new Set([
    'AUTH',
    'COROS_FILE_MISMATCH',
    'COROS_FILE_SIZE',
    'COROS_FILE_TYPE',
    'COROS_STAGING_FAILED',
    'COROS_TASK_UNRECOGNIZED',
    'GARMIN_UPLOAD_FILENAME',
    'GARMIN_UPLOAD_PREPARE',
    'GARMIN_WRITE_BLOCKED',
]);
const IMPORT_NOT_VISIBLE_CODES = new Set(['COROS_TASK_NOT_VISIBLE', 'GARMIN_UPLOAD_NOT_VISIBLE']);

export async function scanAll(adapter: PlatformAdapter, window?: ActivityWindow): Promise<Activity[]> {
    if (window && (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start > window.end)) {
        throw new SyncError('SCAN_INCOMPLETE', 'Activity scan window is invalid.');
    }
    const result: Activity[] = [];
    const ids = new Set<string>();
    const cursors = new Set<number>();
    let expectedTotal: number | undefined;
    let cursor = 0;
    for (;;) {
        if (cursors.has(cursor)) throw new SyncError('SCAN_INCOMPLETE', 'Activity pagination repeated a cursor.');
        cursors.add(cursor);
        const page = await adapter.page(cursor, window);
        if (!Array.isArray(page.activities)) throw new SyncError('SCAN_INCOMPLETE', 'Activity page is invalid.');
        if (page.total !== undefined) {
            if (!Number.isSafeInteger(page.total) || page.total < 0 ||
                (expectedTotal !== undefined && expectedTotal !== page.total)) {
                throw new SyncError('SCAN_INCOMPLETE', 'Activity count changed during pagination; try again.');
            }
            expectedTotal = page.total;
        }
        for (const activity of page.activities) {
            if (activity.slot !== adapter.slot || ids.has(activity.id)) {
                throw new SyncError('SCAN_INCOMPLETE', 'Activity pages overlap or changed during scanning; try again.');
            }
            ids.add(activity.id);
            result.push(activity);
        }
        if (expectedTotal !== undefined && result.length > expectedTotal) {
            throw new SyncError('SCAN_INCOMPLETE', 'Activity count changed during pagination; try again.');
        }
        if (page.next === null) {
            if (page.activities.length) throw new SyncError('SCAN_INCOMPLETE', 'Activity scan ended without an explicit empty final page.');
            if (expectedTotal !== undefined && result.length !== expectedTotal) {
                throw new SyncError('SCAN_INCOMPLETE', 'Activity count changed during pagination; try again.');
            }
            return result;
        }
        if (!page.activities.length || !Number.isSafeInteger(page.next) || page.next <= cursor) {
            throw new SyncError('SCAN_INCOMPLETE', 'Activity pagination did not advance.');
        }
        cursor = page.next;
    }
}

function candidatesNear(source: Pick<Activity, 'start'>, target: Activity[]): Activity[] {
    return target.filter(activity => Math.abs(activity.start - source.start) <= 60000);
}

function candidatesNearSorted(source: Pick<Activity, 'start'>, target: Activity[]): Activity[] {
    const minimum = source.start - 60000;
    const maximum = source.start + 60000;
    let low = 0;
    let high = target.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (target[middle]!.start < minimum) low = middle + 1;
        else high = middle;
    }
    const result: Activity[] = [];
    for (let index = low; index < target.length && target[index]!.start <= maximum; index++) result.push(target[index]!);
    return result;
}

function comparable(a: { start: number; sport: string; duration: number | null; distance: number | null },
    b: { start: number; sport: string; duration: number | null; distance: number | null }): boolean {
    if (Math.abs(a.start - b.start) > 2000 || a.sport !== b.sport || a.duration === null || b.duration === null ||
        Math.abs(a.duration - b.duration) > Math.max(5, Math.max(a.duration, b.duration) * 0.01)) return false;
    if (a.distance === null || b.distance === null) return a.distance === b.distance;
    return Math.abs(a.distance - b.distance) <= Math.max(20, Math.max(a.distance, b.distance) * 0.01);
}

function couldBeSameActivity(a: { start: number; sport: string; duration: number | null; distance: number | null },
    b: { start: number; sport: string; duration: number | null; distance: number | null }): boolean {
    // Duration and distance can be edited independently on either platform while
    // the original recording remains unchanged. Keep same-time/same-sport rows as
    // candidates and let file evidence prove whether they are the same recording.
    return Math.abs(a.start - b.start) <= 60000 && a.sport === b.sport;
}

function evidenceMatchesActivity(activity: Activity, evidence: Evidence): boolean {
    if (!evidenceIdentityMatches(activity, evidence)) return false;
    if (activity.duration !== null && (evidence.duration === null ||
        Math.abs(evidence.duration - activity.duration) > Math.max(5, Math.max(evidence.duration, activity.duration) * 0.01))) {
        return false;
    }
    return activity.distance === null || (evidence.distance !== null &&
        Math.abs(evidence.distance - activity.distance) <= Math.max(20, Math.max(evidence.distance, activity.distance) * 0.01));
}

function evidenceIdentityMatches(activity: Activity, evidence: Evidence): boolean {
    return Math.abs(evidence.start - activity.start) <= 60000 && evidence.sport === activity.sport;
}

export function sameRecording(a: Evidence, b: Evidence): boolean {
    return compareRecording(a, b) === 'same';
}

type RecordingComparison = 'same' | 'different' | 'incomparable';

function compareRecording(a: Evidence, b: Evidence): RecordingComparison {
    if (Math.abs(a.start - b.start) > 2000 || a.sport !== b.sport) return 'different';
    if (a.sha256 === b.sha256 || Boolean(a.device && a.device === b.device) ||
        Boolean(a.records && a.records === b.records)) return 'same';
    if (a.duration === null || b.duration === null || a.distance === null || b.distance === null) {
        return 'incomparable';
    }
    if (!comparable(a, b)) return 'different';
    // Distinct decoded track fingerprints can rule out another recording. Raw
    // byte hashes cannot: platforms may reserialize either FIT or TCX exports.
    return a.records && b.records ? 'different' : 'incomparable';
}

export function transferFor(source: Activity, evidence: Evidence, format: ActivityFileFormat = 'fit'): Transfer {
    const digest = createHash('sha256')
        .update(`${source.slot}\0${source.id}`)
        .digest('hex');
    return { sourceId: source.id, filename: `dailysync_${digest.slice(0, 32)}.${format}`, evidence: { ...evidence } };
}

export class ActivitySynchronizer {
    readonly events: SyncEvent[] = [];
    transferLimitReached = false;
    private readonly files = new Map<string, DownloadedActivity>();
    private targetInventory: Activity[] = [];
    private readonly route: SyncRoute;

    constructor(private readonly deps: EngineDependencies, private readonly options: SyncOptions = {}) {
        const route = `${deps.source.slot}-to-${deps.target.slot}`;
        const routes: SyncRoute[] = ['garmin-cn-to-garmin-global', 'garmin-global-to-garmin-cn',
            'garmin-cn-to-coros-cn', 'coros-cn-to-garmin-cn'];
        if (!routes.includes(route as SyncRoute)) {
            throw new SyncError('CONFIG', 'The selected synchronization direction is invalid.');
        }
        if (options.transferLimit !== undefined &&
            (!Number.isSafeInteger(options.transferLimit) || options.transferLimit <= 0)) {
            throw new SyncError('CONFIG', 'The transfer limit must be a positive integer.');
        }
        this.route = route as SyncRoute;
    }

    private event(source: Activity, status: SyncEvent['status'], extra: Partial<SyncEvent> = {}): void {
        const event: SyncEvent = { route: this.route, source: activityKey(source.slot, source.id), status, ...extra };
        this.events.push(event);
        this.deps.emit?.(event);
    }

    private evidenceUnavailable(error: unknown): error is SyncError {
        return error instanceof SyncError &&
            ['DOWNLOAD', 'ACTIVITY_FILE_INVALID', 'ACTIVITY_FILE_MISMATCH', 'FIT_INVALID', 'GPX_INVALID', 'GPX_UNSUPPORTED',
                'TCX_INVALID', 'GARMIN_EXPORT_UNAVAILABLE'].includes(error.code);
    }

    private async file(adapter: PlatformAdapter, activity: Activity): Promise<DownloadedActivity> {
        const key = activityKey(activity.slot, activity.id);
        const cached = this.files.get(key);
        if (cached) return cached;
        const directory = await fs.mkdtemp(path.join(this.deps.directory, 'activity-'));
        await fs.chmod(directory, 0o700);
        const file = await adapter.download(activity, directory);
        const format = activityFileFormat(file);
        const evidence = await (this.deps.evidence ?? readEvidence)(file, activity);
        if (!evidenceIdentityMatches(activity, evidence)) {
            throw new SyncError('ACTIVITY_FILE_MISMATCH',
                'Downloaded activity file does not match the activity start time or sport.');
        }
        const result = { file, evidence, format, summaryMatches: evidenceMatchesActivity(activity, evidence) };
        this.files.set(key, result);
        return result;
    }

    private mergeTargetInventory(activities: Activity[]): void {
        const inventory = new Map(this.targetInventory.map(activity => [activity.id, activity]));
        for (const activity of activities) inventory.set(activity.id, activity);
        this.targetInventory = [...inventory.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    }

    private async classify(source: Activity, candidates: Activity[], sourceFile?: DownloadedActivity): Promise<CandidateResult> {
        const plausible = candidates.filter(candidate => couldBeSameActivity(source, candidate));
        if (!plausible.length) return { status: 'absent' };
        const summaryMatches = plausible.filter(candidate => comparable(source, candidate));
        if (plausible.length === 1 && summaryMatches.length === 1) {
            return { status: 'existing', target: summaryMatches[0] };
        }

        let downloaded: DownloadedActivity;
        try {
            downloaded = sourceFile ?? await this.file(this.deps.source, source);
        }
        catch (error) {
            if (!this.evidenceUnavailable(error)) throw error;
            return { status: 'review', code: 'AMBIGUOUS_HISTORY', candidates: plausible.map(candidate => candidate.id) };
        }
        const evidenceSummaryMatches = plausible.filter(candidate => comparable(downloaded.evidence, candidate));
        if (plausible.length === 1 && downloaded.summaryMatches && evidenceSummaryMatches.length === 1) {
            return { status: 'existing', target: evidenceSummaryMatches[0] };
        }
        const evidenceMatches: Activity[] = [];
        let inconclusiveEvidence = false;
        for (const candidate of plausible) {
            try {
                const targetFile = await this.file(this.deps.target, candidate);
                const comparison = compareRecording(downloaded.evidence, targetFile.evidence);
                if (comparison === 'same') evidenceMatches.push(candidate);
                else if (comparison === 'incomparable') inconclusiveEvidence = true;
            } catch (error) {
                if (!this.evidenceUnavailable(error)) throw error;
                inconclusiveEvidence = true;
            }
        }
        if (evidenceMatches.length === 1 && !inconclusiveEvidence) {
            return { status: 'existing', target: evidenceMatches[0] };
        }
        if (!evidenceMatches.length && !inconclusiveEvidence) return { status: 'absent' };
        return { status: 'review', code: 'AMBIGUOUS_HISTORY', candidates: plausible.map(candidate => candidate.id) };
    }

    private async scopedTargets(evidence: Evidence): Promise<Activity[]> {
        const activities = await scanAll(this.deps.target,
            { start: evidence.start - 60000, end: evidence.start + 60000 });
        this.mergeTargetInventory(activities);
        return candidatesNear(evidence, activities);
    }

    private mergeReceipt(transfer: Transfer, receipt: ImportReceipt): ImportReceipt {
        transfer.receipt = { ...transfer.receipt, ...receipt, code: receipt.code };
        return transfer.receipt;
    }

    private throwIfSystemicImportFailure(code?: string): void {
        if (code && SYSTEMIC_IMPORT_CODES.has(code)) {
            throw new SyncError(code, 'The target import service or local transfer invariant failed.');
        }
    }

    private async reconcile(transfer: Transfer, initial?: ImportReceipt): Promise<ReconcileResult> {
        let receipt: ImportReceipt | undefined;
        if (initial) {
            receipt = this.mergeReceipt(transfer, initial);
            this.throwIfSystemicImportFailure(initial.code);
        }
        const rounds = this.options.pollAttempts ?? 6;
        for (let round = 0; round < rounds; round++) {
            receipt ??= this.mergeReceipt(transfer, await this.deps.target.verify(transfer));
            this.throwIfSystemicImportFailure(receipt.code);
            if (receipt.status === 'retryable') return { status: 'deferred', code: receipt.code ?? 'COROS_IMPORT_RETRY' };
            // The activity inventory is authoritative. COROS keeps only a bounded
            // import-task history, and a task can still say pending after the
            // activity has become visible.
            const candidates = await this.scopedTargets(transfer.evidence);
            const plausible = candidates.filter(candidate => couldBeSameActivity(transfer.evidence, candidate));
            const summaryMatches = plausible.filter(candidate => comparable(transfer.evidence, candidate));
            if (plausible.length === 1 && summaryMatches.length === 1) {
                return { status: 'complete', target: summaryMatches[0] };
            }
            const evidenceMatches: Activity[] = [];
            let inconclusiveEvidence = false;
            for (const candidate of plausible) {
                try {
                    const comparison = compareRecording(transfer.evidence,
                        (await this.file(this.deps.target, candidate)).evidence);
                    if (comparison === 'same') evidenceMatches.push(candidate);
                    else if (comparison === 'incomparable') inconclusiveEvidence = true;
                } catch (error) {
                    if (!this.evidenceUnavailable(error)) throw error;
                    inconclusiveEvidence = true;
                }
            }
            if (evidenceMatches.length === 1 && !inconclusiveEvidence) {
                return { status: 'complete', target: evidenceMatches[0] };
            }
            if ((summaryMatches.length > 1 && inconclusiveEvidence) || evidenceMatches.length > 1 ||
                (evidenceMatches.length === 1 && inconclusiveEvidence)) {
                const ambiguous = evidenceMatches.length > 1 && !inconclusiveEvidence ? evidenceMatches : plausible;
                return { status: 'verifying', code: 'MULTIPLE_TARGETS', candidates: ambiguous.map(item => item.id) };
            }
            if (receipt.status === 'failed') {
                return { status: 'failed', code: receipt.code ?? 'COROS_IMPORT_FAILED' };
            }
            if (receipt.status === 'unknown' && receipt.code && !IMPORT_NOT_VISIBLE_CODES.has(receipt.code)) {
                if (TERMINAL_IMPORT_CODES.has(receipt.code)) return { status: 'failed', code: receipt.code };
                return { status: 'verifying', code: receipt.code };
            }
            if (round + 1 < rounds) {
                await (this.deps.wait ?? sleep)(5000);
                receipt = undefined;
            }
        }
        return { status: 'verifying', code: transfer.receipt?.code ?? 'IMPORT_PENDING' };
    }

    private emitCandidate(source: Activity, result: CandidateResult): void {
        if (result.status === 'existing') this.event(source, 'existing', { targetId: result.target!.id });
        else if (result.status === 'review') this.event(source, 'review', { code: result.code, candidates: result.candidates });
        else if (result.status === 'deferred') this.event(source, 'deferred', { code: result.code });
    }

    private emitReconcile(source: Activity, result: ReconcileResult, completeStatus: 'uploaded' | 'existing'): void {
        if (result.status === 'complete') this.event(source, completeStatus, { targetId: result.target!.id });
        else if (result.status === 'failed') this.event(source, 'failed', { code: result.code });
        else if (result.status === 'deferred') this.event(source, 'deferred', { code: result.code });
        else this.event(source, 'verifying', { code: result.code, candidates: result.candidates });
    }

    async run(): Promise<SyncEvent[]> {
        await this.deps.source.connect(this.deps.sourceSession);
        await this.deps.target.connect(this.deps.targetSession);

        const sources = await scanAll(this.deps.source);
        this.targetInventory = (await scanAll(this.deps.target))
            .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        const orderedSources = [...sources].sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
        if (this.options.activityId && !orderedSources.some(activity => activity.id === this.options.activityId)) {
            throw new SyncError('NOT_FOUND', 'The selected source activity was not found.');
        }

        let transfers = 0;
        const unresolvedEvidence: Evidence[] = [];
        for (const source of orderedSources) {
            if (this.options.activityId && source.id !== this.options.activityId) continue;
            const existing = await this.classify(source, candidatesNearSorted(source, this.targetInventory));
            if (existing.status !== 'absent') {
                this.emitCandidate(source, existing);
                if (existing.status === 'deferred') break;
                continue;
            }
            if (!this.deps.target.supports(source)) {
                this.event(source, 'unsupported');
                continue;
            }

            if (transfers >= (this.options.transferLimit ?? Infinity)) {
                this.transferLimitReached = true;
                break;
            }

            let downloaded: DownloadedActivity;
            try { downloaded = await this.file(this.deps.source, source); }
            catch (error) {
                if (!this.evidenceUnavailable(error)) throw error;
                this.event(source, 'review', { code: error.code });
                continue;
            }
            if (!downloaded.summaryMatches) {
                this.event(source, 'review', { code: 'ACTIVITY_FILE_MISMATCH' });
                continue;
            }
            if (unresolvedEvidence.some(evidence => compareRecording(evidence, downloaded.evidence) !== 'different')) {
                this.event(source, 'verifying', { code: 'RELATED_UNRESOLVED_IMPORT' });
                continue;
            }
            const transfer = transferFor(source, downloaded.evidence, downloaded.format);
            const previous = await this.deps.target.verify(transfer);
            if (!(previous.status === 'unknown' && IMPORT_NOT_VISIBLE_CODES.has(previous.code ?? ''))) {
                const recovered = await this.reconcile(transfer, previous);
                this.emitReconcile(source, recovered, 'existing');
                if (recovered.status === 'verifying') unresolvedEvidence.push(downloaded.evidence);
                if (recovered.status === 'deferred') break;
                continue;
            }

            const freshTargets = await this.scopedTargets(downloaded.evidence);
            const fresh = await this.classify(source, freshTargets, downloaded);
            if (fresh.status !== 'absent') {
                this.emitCandidate(source, fresh);
                if (fresh.status === 'deferred') break;
                continue;
            }
            let receipt: ImportReceipt;
            transfers++;
            try { receipt = await this.deps.target.upload(downloaded.file, transfer); }
            catch (_) { receipt = { status: 'unknown', code: 'UPLOAD_OUTCOME_UNKNOWN' }; }
            this.mergeReceipt(transfer, receipt);
            if (receipt.status === 'failed') {
                this.throwIfSystemicImportFailure(receipt.code);
                this.event(source, 'failed', { code: receipt.code });
                continue;
            }
            if (receipt.status === 'retryable') {
                this.event(source, 'deferred', { code: receipt.code });
                break;
            }
            const imported = await this.reconcile(transfer);
            this.emitReconcile(source, imported, 'uploaded');
            if (imported.status === 'verifying') unresolvedEvidence.push(downloaded.evidence);
            if (imported.status === 'deferred') break;
        }
        return this.events;
    }
}
