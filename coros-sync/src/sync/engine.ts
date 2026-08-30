import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Activity, ActivityWindow, activityKey, Evidence, ImportReceipt, PlatformAdapter, SavedSession, SyncRoute, Transfer } from './types';
import { readEvidence } from './files';
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

export function syncExitCode(events: SyncEvent[]): number {
    return ['incomplete', 'failed'].includes(syncOutcome(events)) ? 2 : 0;
}

export interface SyncOptions {
    activityId?: string;
    sourceOffset?: number;
    sourceLimit?: number;
    pollAttempts?: number;
    deadline?: number;
}

interface EngineDependencies {
    source: PlatformAdapter;
    target: PlatformAdapter;
    sourceSession?: SavedSession;
    targetSession?: SavedSession;
    directory: string;
    evidence?: (file: string) => Promise<Evidence>;
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

const TERMINAL_IMPORT_CODES = new Set(['COROS_IMPORT_ERRORS', 'COROS_TASK_FAILED', 'COROS_TASK_UNRECOGNIZED']);
const IMPORT_NOT_VISIBLE_CODES = new Set(['COROS_TASK_NOT_VISIBLE', 'GARMIN_UPLOAD_NOT_VISIBLE']);

export async function scanAll(adapter: PlatformAdapter, deadline = Infinity, window?: ActivityWindow,
    initialCursor = 0, limit?: number): Promise<Activity[]> {
    if (window && (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start > window.end)) {
        throw new SyncError('SCAN_INCOMPLETE', 'Activity scan window is invalid.');
    }
    if (!Number.isSafeInteger(initialCursor) || initialCursor < 0 ||
        (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))) {
        throw new SyncError('SCAN_INCOMPLETE', 'Activity scan range is invalid.');
    }
    const result: Activity[] = [];
    const ids = new Set<string>();
    const cursors = new Set<number>();
    let expectedTotal: number | undefined;
    let cursor = initialCursor;
    for (;;) {
        if (Date.now() >= deadline) throw new SyncError('SCAN_INCOMPLETE', 'Time budget exhausted before the activity scan completed.');
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
            if (limit !== undefined && result.length === limit) return result;
        }
        if (expectedTotal !== undefined && initialCursor === 0 && result.length > expectedTotal) {
            throw new SyncError('SCAN_INCOMPLETE', 'Activity count changed during pagination; try again.');
        }
        if (page.next === null) {
            if (page.activities.length) throw new SyncError('SCAN_INCOMPLETE', 'Activity scan ended without an explicit empty final page.');
            if (expectedTotal !== undefined && initialCursor === 0 && result.length !== expectedTotal) {
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

export function candidatesNear(source: Pick<Activity, 'start'>, target: Activity[]): Activity[] {
    return target.filter(activity => Math.abs(activity.start - source.start) <= 60000);
}

function candidatesNearSorted(source: Pick<Activity, 'start'>, target: Activity[]): Activity[] {
    const minimum = source.start - 60000;
    const maximum = source.start + 60000;
    let low = 0;
    let high = target.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (target[middle].start < minimum) low = middle + 1;
        else high = middle;
    }
    const result: Activity[] = [];
    for (let index = low; index < target.length && target[index].start <= maximum; index++) result.push(target[index]);
    return result;
}

function comparable(a: { start: number; sport: string; duration: number | null; distance: number | null },
    b: { start: number; sport: string; duration: number | null; distance: number | null }): boolean {
    if (Math.abs(a.start - b.start) > 2000 || a.sport !== b.sport || a.duration === null || b.duration === null ||
        Math.abs(a.duration - b.duration) > Math.max(5, Math.max(a.duration, b.duration) * 0.01)) return false;
    if (a.distance === null || b.distance === null) return a.distance === b.distance;
    return Math.abs(a.distance - b.distance) <= Math.max(20, Math.max(a.distance, b.distance) * 0.01);
}

export function sameRecording(a: Evidence, b: Evidence): boolean {
    if (!comparable(a, b)) return false;
    return a.sha256 === b.sha256 || Boolean(a.device && a.device === b.device) || Boolean(a.records && a.records === b.records);
}

export function transferFor(source: Activity, evidence: Evidence): Transfer {
    const digest = createHash('sha256')
        .update(`${source.slot}\0${source.id}`)
        .digest('hex');
    return { sourceId: source.id, filename: `dailysync_${digest.slice(0, 32)}.fit`, evidence: { ...evidence } };
}

export class ActivitySynchronizer {
    readonly events: SyncEvent[] = [];
    private readonly files = new Map<string, { file: string; evidence: Evidence }>();
    private targetInventory: Activity[] = [];
    private readonly route: SyncRoute;

    constructor(private readonly deps: EngineDependencies, private readonly options: SyncOptions = {}) {
        if (deps.source.slot === 'garmin-cn' && deps.target.slot === 'coros-cn') this.route = 'garmin-to-coros';
        else if (deps.source.slot === 'coros-cn' && deps.target.slot === 'garmin-cn') this.route = 'coros-to-garmin';
        else throw new SyncError('CONFIG', 'The selected synchronization direction is invalid.');
    }

    private event(source: Activity, status: SyncEvent['status'], extra: Partial<SyncEvent> = {}): void {
        const event: SyncEvent = { route: this.route, source: activityKey(source.slot, source.id), status, ...extra };
        this.events.push(event);
        this.deps.emit?.(event);
    }

    private deadlineReached(): boolean {
        return Date.now() >= (this.options.deadline ?? Infinity);
    }

    private evidenceUnavailable(error: unknown): error is SyncError {
        return error instanceof SyncError &&
            ['DOWNLOAD', 'FIT_INVALID', 'FIT_MISMATCH', 'GARMIN_EXPORT_UNAVAILABLE'].includes(error.code);
    }

    private async file(adapter: PlatformAdapter, activity: Activity): Promise<{ file: string; evidence: Evidence }> {
        const key = activityKey(activity.slot, activity.id);
        const cached = this.files.get(key);
        if (cached) return cached;
        const directory = await fs.mkdtemp(path.join(this.deps.directory, 'fit-'));
        await fs.chmod(directory, 0o700);
        const file = await adapter.download(activity, directory);
        const evidence = await (this.deps.evidence ?? readEvidence)(file);
        if (Math.abs(evidence.start - activity.start) > 60000) {
            throw new SyncError('FIT_MISMATCH', 'Downloaded FIT does not match the activity UTC timestamp.');
        }
        const result = { file, evidence };
        this.files.set(key, result);
        return result;
    }

    private mergeTargetInventory(activities: Activity[]): void {
        const inventory = new Map(this.targetInventory.map(activity => [activity.id, activity]));
        for (const activity of activities) inventory.set(activity.id, activity);
        this.targetInventory = [...inventory.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    }

    private async classify(source: Activity, candidates: Activity[], sourceEvidence?: Evidence): Promise<CandidateResult> {
        if (this.deadlineReached()) return { status: 'deferred', code: 'RUN_LIMIT' };
        if (!candidates.length) return { status: 'absent' };
        const summaryMatches = candidates.filter(candidate => comparable(source, candidate));
        if (summaryMatches.length === 1) return { status: 'existing', target: summaryMatches[0] };

        try {
            const proof = sourceEvidence ?? (await this.file(this.deps.source, source)).evidence;
            const evidenceMatches: Activity[] = [];
            for (const candidate of candidates) {
                if (this.deadlineReached()) return { status: 'deferred', code: 'RUN_LIMIT' };
                const targetEvidence = (await this.file(this.deps.target, candidate)).evidence;
                if (sameRecording(proof, targetEvidence)) evidenceMatches.push(candidate);
            }
            if (evidenceMatches.length === 1) return { status: 'existing', target: evidenceMatches[0] };
        } catch (error) {
            if (!this.evidenceUnavailable(error)) throw error;
        }
        return { status: 'review', code: 'AMBIGUOUS_HISTORY', candidates: candidates.map(candidate => candidate.id) };
    }

    private async scopedTargets(evidence: Evidence): Promise<Activity[]> {
        const activities = await scanAll(this.deps.target, this.options.deadline,
            { start: evidence.start - 60000, end: evidence.start + 60000 });
        this.mergeTargetInventory(activities);
        return candidatesNear(evidence, activities);
    }

    private mergeReceipt(transfer: Transfer, receipt: ImportReceipt): ImportReceipt {
        transfer.receipt = { ...transfer.receipt, ...receipt, code: receipt.code };
        return transfer.receipt;
    }

    private async reconcile(transfer: Transfer, initial?: ImportReceipt): Promise<ReconcileResult> {
        if (initial) this.mergeReceipt(transfer, initial);
        const rounds = this.options.pollAttempts ?? 6;
        for (let round = 0; round < rounds; round++) {
            if (this.deadlineReached()) return { status: 'deferred', code: 'RUN_LIMIT' };
            const receipt = this.mergeReceipt(transfer, await this.deps.target.verify(transfer));
            if (receipt.status === 'failed') return { status: 'failed', code: receipt.code ?? 'COROS_IMPORT_FAILED' };
            if (receipt.status === 'retryable') return { status: 'deferred', code: receipt.code ?? 'COROS_IMPORT_RETRY' };
            if (receipt.status !== 'pending') {
                const candidates = await this.scopedTargets(transfer.evidence);
                const summaryMatches = candidates.filter(candidate => comparable(transfer.evidence, candidate));
                if (summaryMatches.length === 1) return { status: 'complete', target: summaryMatches[0] };
                const evidenceMatches: Activity[] = [];
                let evidenceUnavailable = false;
                for (const candidate of candidates) {
                    try {
                        if (sameRecording(transfer.evidence, (await this.file(this.deps.target, candidate)).evidence)) {
                            evidenceMatches.push(candidate);
                        }
                    } catch (error) {
                        if (!this.evidenceUnavailable(error)) throw error;
                        evidenceUnavailable = true;
                    }
                }
                if (evidenceMatches.length === 1 && !evidenceUnavailable) {
                    return { status: 'complete', target: evidenceMatches[0] };
                }
                if (summaryMatches.length > 1 || evidenceMatches.length > 1) {
                    const ambiguous = evidenceMatches.length > 1 ? evidenceMatches : summaryMatches;
                    return { status: 'verifying', code: 'MULTIPLE_TARGETS', candidates: ambiguous.map(item => item.id) };
                }
                if (receipt.status === 'unknown' && receipt.code && !IMPORT_NOT_VISIBLE_CODES.has(receipt.code)) {
                    return { status: TERMINAL_IMPORT_CODES.has(receipt.code) ? 'failed' : 'verifying', code: receipt.code };
                }
            }
            if (round + 1 < rounds) await (this.deps.wait ?? sleep)(5000);
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

        const sources = await scanAll(this.deps.source, this.options.deadline, undefined,
            this.options.sourceOffset ?? 0, this.options.sourceLimit);
        this.targetInventory = (await scanAll(this.deps.target, this.options.deadline))
            .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        const orderedSources = [...sources].sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
        if (this.options.activityId && !orderedSources.some(activity => activity.id === this.options.activityId)) {
            throw new SyncError('NOT_FOUND', 'The selected source activity was not found.');
        }

        for (const source of orderedSources) {
            if (this.options.activityId && source.id !== this.options.activityId) continue;
            if (this.deadlineReached()) {
                this.event(source, 'deferred', { code: 'RUN_LIMIT' });
                break;
            }
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

            let downloaded: { file: string; evidence: Evidence };
            try { downloaded = await this.file(this.deps.source, source); }
            catch (error) {
                if (!this.evidenceUnavailable(error)) throw error;
                this.event(source, 'review', { code: error.code });
                continue;
            }
            if (this.deadlineReached()) {
                this.event(source, 'deferred', { code: 'RUN_LIMIT' });
                break;
            }

            const transfer = transferFor(source, downloaded.evidence);
            const previous = await this.deps.target.verify(transfer);
            if (!(previous.status === 'unknown' && IMPORT_NOT_VISIBLE_CODES.has(previous.code ?? ''))) {
                const recovered = await this.reconcile(transfer, previous);
                this.emitReconcile(source, recovered, 'existing');
                if (recovered.status === 'verifying' || recovered.status === 'deferred') break;
                continue;
            }

            const freshTargets = await this.scopedTargets(downloaded.evidence);
            const fresh = await this.classify(source, freshTargets, downloaded.evidence);
            if (fresh.status !== 'absent') {
                this.emitCandidate(source, fresh);
                if (fresh.status === 'deferred') break;
                continue;
            }
            if (this.deadlineReached()) {
                this.event(source, 'deferred', { code: 'RUN_LIMIT' });
                break;
            }

            let receipt: ImportReceipt;
            try { receipt = await this.deps.target.upload(downloaded.file, transfer); }
            catch (_) { receipt = { status: 'unknown', code: 'UPLOAD_OUTCOME_UNKNOWN' }; }
            this.mergeReceipt(transfer, receipt);
            if (receipt.status === 'failed') {
                this.event(source, 'failed', { code: receipt.code });
                if (receipt.code === 'AUTH') throw new SyncError('AUTH', 'Target authentication failed; uploads stopped.');
                continue;
            }
            if (receipt.status === 'retryable') {
                this.event(source, 'deferred', { code: receipt.code });
                break;
            }
            const imported = await this.reconcile(transfer);
            this.emitReconcile(source, imported, 'uploaded');
            if (imported.status === 'verifying' || imported.status === 'deferred') break;
        }
        return this.events;
    }
}
