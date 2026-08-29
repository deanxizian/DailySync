import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Activity, ActivityRecord, ActivityWindow, activityKey, Evidence, PlatformAdapter, ROUTES, Slot,
    SLOTS, SyncState, Transfer, transferKey, UploadIntent } from './types';
import { readEvidence } from './files';
import { sleep, SyncError } from './errors';
import { createUploadIntent } from './upload-intent';

export interface SyncEvent {
    route: string;
    source: string;
    status: 'planned' | 'uploaded' | 'matched' | 'existing' | 'preserved-deletion' | 'ignored' | 'review' | 'verifying' | 'failed' | 'unsupported' | 'deferred';
    targetId?: string;
    code?: string;
    candidates?: string[];
}

export function syncExitCode(events: SyncEvent[]): number {
    return events.some(event => ['failed', 'verifying', 'review', 'unsupported', 'deferred'].includes(event.status) ||
        ['UNRESOLVED_IMPORT', 'RUN_LIMIT'].includes(event.code ?? '')) ? 2 : 0;
}

export interface SyncOptions {
    apply: boolean;
    activityId?: string;
    sourceOffset?: number;
    sourceLimit?: number;
    retryFailed?: boolean;
    pollAttempts?: number;
    deadline?: number;
}

interface EngineDependencies {
    adapters: Record<Slot, PlatformAdapter>;
    state: SyncState;
    directory: string;
    checkpoint: (state: SyncState) => Promise<void>;
    publishIntent: (intent: UploadIntent) => Promise<void>;
    clearIntent: () => Promise<void>;
    assertOwned: () => Promise<void>;
    evidence?: (file: string) => Promise<Evidence>;
    wait?: (ms: number) => Promise<void>;
    emit?: (event: SyncEvent) => void;
}

function ownershipFailure(error: unknown): error is SyncError {
    return error instanceof SyncError && ['LOCK_LOST', 'STATE_SAVE', 'STATE_PUBLISH'].includes(error.code);
}

export async function scanAll(adapter: PlatformAdapter, deadline = Infinity, window?: ActivityWindow): Promise<Activity[]> {
    if (window && (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start > window.end)) {
        throw new SyncError('SCAN_INCOMPLETE', 'Activity scan window is invalid.');
    }
    const result: Activity[] = [];
    const ids = new Set<string>();
    const cursors = new Set<number>();
    let expectedTotal: number | undefined;
    let cursor = 0;
    for (;;) {
        if (Date.now() >= deadline) throw new SyncError('SCAN_INCOMPLETE', 'Time budget exhausted before a complete history scan.');
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
            if (page.activities.length) throw new SyncError('SCAN_INCOMPLETE', 'History scan ended without an explicit empty final page.');
            if (expectedTotal !== undefined && result.length !== expectedTotal) {
                throw new SyncError('SCAN_INCOMPLETE', 'Activity count changed during pagination; try again.');
            }
            return result;
        }
        if (!page.activities.length || !Number.isInteger(page.next) || page.next <= cursor) {
            throw new SyncError('SCAN_INCOMPLETE', 'Activity pagination did not advance.');
        }
        cursor = page.next;
    }
}

export function candidatesNear(source: Pick<Activity, 'start'>, target: Activity[]): Activity[] {
    // A different sport classification or an edited distance must not hide a potential duplicate.
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

function buildMappingIndex(state: SyncState): Map<string, ActivityRecord> {
    const index = new Map<string, ActivityRecord>();
    for (const record of Object.values(state.activities)) index.set(transferKey(record.canonical, record.activity.slot), record);
    return index;
}

function mergeCanonicalIndexed(state: SyncState, index: Map<string, ActivityRecord>, keep: string, remove: string): void {
    if (keep === remove) return;
    for (const slot of SLOTS) {
        if (index.has(transferKey(keep, slot)) && index.has(transferKey(remove, slot))) {
            throw new SyncError('MAPPING_CONFLICT', 'These activities already map to different records in the same account.');
        }
        if (state.transfers[transferKey(remove, slot)] && state.transfers[transferKey(keep, slot)]) {
            throw new SyncError('MAPPING_CONFLICT', 'Both activity groups already have a task for the same target. Resolve them explicitly.');
        }
    }
    for (const slot of SLOTS) {
        const oldKey = transferKey(remove, slot);
        const record = index.get(oldKey);
        if (record) {
            index.delete(oldKey);
            record.canonical = keep;
            index.set(transferKey(keep, slot), record);
        }
        const transfer = state.transfers[oldKey];
        if (!transfer) continue;
        delete state.transfers[oldKey];
        transfer.canonical = keep;
        state.transfers[transferKey(keep, transfer.target)] = transfer;
    }
}

export function mergeCanonical(state: SyncState, keep: string, remove: string): void {
    mergeCanonicalIndexed(state, buildMappingIndex(state), keep, remove);
}

export class ActivitySynchronizer {
    readonly events: SyncEvent[] = [];
    private readonly files = new Map<string, { file: string; evidence: Evidence }>();
    private readonly inventory: Record<Slot, Activity[]> = { 'garmin-cn': [], 'coros-cn': [] };
    private initialized = new Set<Slot>();
    private mappingIndex?: Map<string, ActivityRecord>;

    constructor(private readonly deps: EngineDependencies, private readonly options: SyncOptions) {
        if (options.apply) for (const slot of SLOTS) deps.adapters[slot].setWriteGuard?.(deps.assertOwned);
    }

    private event(route: string, source: Activity, status: SyncEvent['status'], extra: Partial<SyncEvent> = {}): void {
        const event = { route, source: activityKey(source.slot, source.id), status, ...extra };
        this.events.push(event);
        this.deps.emit?.(event);
    }

    private record(activity: Activity): ActivityRecord { return this.deps.state.activities[activityKey(activity.slot, activity.id)]; }

    private async save(): Promise<void> {
        if (!this.options.apply) return;
        for (const slot of this.initialized) {
            const session = this.deps.adapters[slot].session();
            if (session) this.deps.state.sessions[slot] = session;
        }
        await this.deps.checkpoint(this.deps.state);
    }

    private async rollbackBeforeImport(task: Transfer, error: unknown): Promise<never> {
        task.status = 'pending';
        task.code = undefined;
        task.receipt = undefined;
        task.beforeIds = undefined;
        await this.save();
        await this.deps.clearIntent();
        throw error;
    }

    private ingest(slot: Slot, activities: Activity[], countMissing: boolean, replaceInventory = true): void {
        const state = this.deps.state;
        // Remove run-local markers written by pre-release state schema revisions.
        delete (state as SyncState & { scans?: unknown }).scans;
        if (replaceInventory) this.inventory[slot] = [...activities].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        else {
            const inventory = new Map(this.inventory[slot].map(activity => [activity.id, activity]));
            for (const activity of activities) inventory.set(activity.id, activity);
            this.inventory[slot] = [...inventory.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        }
        const present = new Set(activities.map(activity => activity.id));
        for (const activity of activities) {
            const key = activityKey(slot, activity.id);
            let record = state.activities[key];
            if (!record) record = state.activities[key] = { activity, canonical: randomUUID(), missing: 0 };
            if (JSON.stringify(record.activity) !== JSON.stringify(activity)) record.evidence = undefined;
            record.activity = activity;
            record.missing = 0;
            this.mappingIndex?.set(transferKey(record.canonical, slot), record);
            delete (record as ActivityRecord & { lastMissingScan?: string }).lastMissingScan;
        }
        if (!countMissing) return;
        for (const record of Object.values(state.activities)) {
            if (record.activity.slot !== slot || present.has(record.activity.id)) continue;
            const importing = state.transfers[transferKey(record.canonical, slot)];
            if (importing && ['uploading', 'verifying'].includes(importing.status)) continue;
            record.missing = Math.min(2, record.missing + 1);
            delete (record as ActivityRecord & { lastMissingScan?: string }).lastMissingScan;
        }
    }

    async scan(): Promise<void> {
        for (const slot of SLOTS) {
            const adapter = this.deps.adapters[slot];
            const identity = await adapter.connect(this.deps.state.sessions[slot]);
            if (this.deps.state.accounts[slot] && this.deps.state.accounts[slot] !== identity) {
                throw new SyncError('ACCOUNT_CHANGED', `${slot} is not the account bound to the shared ledger.`);
            }
            this.deps.state.accounts[slot] = identity;
            this.initialized.add(slot);
        }
        const scans: Partial<Record<Slot, Activity[]>> = {};
        for (const slot of SLOTS) scans[slot] = await scanAll(this.deps.adapters[slot], this.options.deadline);
        // Only a complete source and target scan may change presence or deletion state.
        for (const slot of SLOTS) this.ingest(slot, scans[slot]!, true);
        this.mappingIndex = buildMappingIndex(this.deps.state);
        await this.save();
    }

    private async file(activity: Activity): Promise<{ file: string; evidence: Evidence }> {
        const key = activityKey(activity.slot, activity.id);
        const cached = this.files.get(key);
        if (cached) return cached;
        const directory = await fs.mkdtemp(path.join(this.deps.directory, 'fit-'));
        await fs.chmod(directory, 0o700);
        const file = await this.deps.adapters[activity.slot].download(activity, directory);
        const evidence = await (this.deps.evidence ?? readEvidence)(file);
        if (Math.abs(evidence.start - activity.start) > 60000) throw new SyncError('FIT_MISMATCH', 'Downloaded FIT does not match the activity UTC timestamp.');
        const result = { file, evidence };
        this.files.set(key, result);
        this.record(activity).evidence = evidence;
        return result;
    }

    private async evidence(activity: Activity): Promise<Evidence> {
        return this.record(activity).evidence ?? (await this.file(activity)).evidence;
    }

    private deadlineReached(): boolean {
        return Date.now() >= (this.options.deadline ?? Infinity);
    }

    private incompleteEvidence(error: unknown): boolean {
        return error instanceof SyncError &&
            ['DOWNLOAD', 'FIT_INVALID', 'FIT_MISMATCH', 'GARMIN_EXPORT_UNAVAILABLE'].includes(error.code);
    }

    private task(source: Activity, target: Slot): Transfer {
        const record = this.record(source);
        const key = transferKey(record.canonical, target);
        let transfer = this.deps.state.transfers[key];
        if (!transfer) {
            const attempt = randomUUID();
            transfer = this.deps.state.transfers[key] = { canonical: record.canonical, source: source.slot, sourceId: source.id,
                target, status: 'pending', attempt, filename: `dailysync_${attempt}.fit`, createdAt: Date.now() };
        }
        return transfer;
    }

    private mappedTarget(source: Activity, target: Slot): ActivityRecord | undefined {
        const canonical = this.record(source).canonical;
        this.mappingIndex ??= buildMappingIndex(this.deps.state);
        return this.mappingIndex.get(transferKey(canonical, target));
    }

    private mergeCanonical(keep: string, remove: string): void {
        this.mappingIndex ??= buildMappingIndex(this.deps.state);
        mergeCanonicalIndexed(this.deps.state, this.mappingIndex, keep, remove);
    }

    private async historicalMatch(source: Activity, target: Slot,
        currentWindow?: Activity[]): Promise<'matched' | 'review' | 'absent' | 'deferred'> {
        const candidates = currentWindow === undefined ? candidatesNearSorted(source, this.inventory[target]) :
            candidatesNear(source, currentWindow);
        if (this.deadlineReached()) return 'deferred';
        if (!candidates.length) return 'absent';
        let matches: Activity[] = [];
        let incomplete = false;
        try {
            const evidence = await this.evidence(source);
            if (this.deadlineReached()) return 'deferred';
            for (const candidate of candidates) {
                if (this.deadlineReached()) return 'deferred';
                if (sameRecording(evidence, await this.evidence(candidate))) matches.push(candidate);
                if (this.deadlineReached()) return 'deferred';
            }
        } catch (error) {
            if (!this.incompleteEvidence(error)) throw error;
            incomplete = true;
        }
        if (!incomplete && matches.length === 1) {
            try {
                this.mergeCanonical(this.record(source).canonical, this.record(matches[0]).canonical);
                const existingTask = this.deps.state.transfers[transferKey(this.record(source).canonical, target)];
                if (existingTask) {
                    existingTask.status = 'complete';
                    existingTask.code = undefined;
                    existingTask.beforeIds = undefined;
                    existingTask.candidates = undefined;
                    existingTask.receipt = { status: 'accepted', stage: 'finished', targetId: matches[0].id };
                }
                await this.save();
                return 'matched';
            } catch (error) {
                if (!(error instanceof SyncError) || error.code !== 'MAPPING_CONFLICT') throw error;
            }
        }
        const task = this.task(source, target);
        task.status = 'review';
        task.code = 'AMBIGUOUS_HISTORY';
        task.candidates = candidates.map(activity => activity.id);
        await this.save();
        return 'review';
    }

    private async verify(transfer: Transfer): Promise<boolean> {
        const source = this.deps.state.activities[activityKey(transfer.source, transfer.sourceId)];
        const adapter = this.deps.adapters[transfer.target];
        // Recovery must describe the bytes submitted, even if the source was edited or deleted later.
        const sourceEvidence = transfer.evidence;
        if (!sourceEvidence) throw new SyncError('STATE_INVALID', 'Outstanding import has no durable FIT evidence. Uploads stopped.');
        const rounds = this.options.pollAttempts ?? 6;
        for (let round = 0; round < rounds; round++) {
            if (this.deadlineReached()) return false;
            const receipt = await adapter.verify(transfer);
            transfer.receipt = { ...transfer.receipt, ...receipt, code: receipt.code };
            transfer.status = 'verifying';
            transfer.code = receipt.code;
            await this.save();
            if (receipt.status !== 'pending') {
                const fresh = await scanAll(adapter, this.options.deadline,
                    { start: sourceEvidence.start - 60000, end: sourceEvidence.start + 60000 });
                this.ingest(transfer.target, fresh, false, false);
                const candidates = candidatesNear(sourceEvidence, fresh).filter(activity =>
                    !receipt.targetId || receipt.targetId === activity.id);
                const matches: Activity[] = [];
                let incomplete = false;
                for (const candidate of candidates) {
                    if (this.deadlineReached()) {
                        transfer.code = 'RUN_LIMIT';
                        await this.save();
                        return false;
                    }
                    let evidence;
                    try { evidence = await this.evidence(candidate); }
                    catch (error) {
                        if (this.incompleteEvidence(error)) { incomplete = true; continue; }
                        throw error;
                    }
                    const confirmedImport = receipt.targetId === candidate.id || (receipt.stage === 'finished' &&
                        receipt.taskId && transfer.beforeIds && !transfer.beforeIds.includes(candidate.id));
                    if (sameRecording(sourceEvidence, evidence) || (confirmedImport && comparable(sourceEvidence, evidence))) matches.push(candidate);
                }
                if (!incomplete && matches.length === 1) {
                    try { this.mergeCanonical(source.canonical, this.record(matches[0]).canonical); }
                    catch (error) {
                        if (!(error instanceof SyncError) || error.code !== 'MAPPING_CONFLICT') throw error;
                        transfer.code = 'MAPPING_CONFLICT';
                        await this.save();
                        return false;
                    }
                    transfer.status = 'complete';
                    transfer.code = undefined;
                    transfer.beforeIds = undefined;
                    transfer.candidates = undefined;
                    transfer.receipt = { ...transfer.receipt, status: 'accepted', stage: 'finished', targetId: matches[0].id };
                    await this.save();
                    return true;
                }
                if (matches.length > 1) transfer.code = 'MULTIPLE_TARGETS';
                await this.save();
                const taskNotVisible = receipt.status === 'unknown' && receipt.code === 'COROS_TASK_NOT_VISIBLE';
                if ((receipt.status === 'unknown' && !taskNotVisible) || receipt.status === 'failed' || matches.length > 1) return false;
            }
            if (round + 1 < rounds) await (this.deps.wait ?? sleep)(5000);
        }
        return false;
    }

    async run(): Promise<SyncEvent[]> {
        await this.scan();
        for (const route of ROUTES) {
            const recovered = new Set<string>();
            // Recover intents even when the original activity has since been deleted at source.
            for (const task of Object.values(this.deps.state.transfers)) {
                if (task.source !== route.source || task.target !== route.target || !['uploading', 'verifying'].includes(task.status) ||
                    (this.options.activityId && task.sourceId !== this.options.activityId)) continue;
                const source = this.deps.state.activities[activityKey(task.source, task.sourceId)].activity;
                const complete = this.options.apply ? await this.verify(task) : false;
                this.event(route.name, source, complete ? 'matched' : 'verifying', { targetId: task.receipt?.targetId, code: task.code });
                recovered.add(task.sourceId);
            }
            let blocked = Object.values(this.deps.state.transfers).some(job => ['uploading', 'verifying'].includes(job.status) &&
                (job.target === route.source || job.target === route.target));
            const allSources = [...this.inventory[route.source]].sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
            if (this.options.activityId && !recovered.has(this.options.activityId) && !allSources.some(activity => activity.id === this.options.activityId)) {
                throw new SyncError('NOT_FOUND', 'The selected source activity was not found in the complete scan.');
            }
            const sourceOffset = this.options.sourceOffset ?? 0;
            const sources = this.options.activityId ? allSources : allSources.slice(sourceOffset,
                this.options.sourceLimit === undefined ? undefined : sourceOffset + this.options.sourceLimit);
            for (const source of sources) {
                if (this.options.activityId && source.id !== this.options.activityId) continue;
                if (recovered.has(source.id)) continue;
                const mapped = this.mappedTarget(source, route.target);
                if (mapped) {
                    this.event(route.name, source, mapped.missing ? 'preserved-deletion' : 'existing',
                        { targetId: mapped.activity.id, code: mapped.missing ? (mapped.missing >= 2 ? 'DELETED' : 'MISSING_UNCONFIRMED') : undefined });
                    continue;
                }
                let task = this.deps.state.transfers[transferKey(this.record(source).canonical, route.target)];
                if (task?.status === 'ignored') { this.event(route.name, source, 'ignored'); continue; }
                if (task?.status === 'failed' && !this.options.retryFailed) {
                    this.event(route.name, source, 'failed', { code: task.code }); continue;
                }
                if (blocked) { this.event(route.name, source, 'deferred', { code: 'UNRESOLVED_IMPORT' }); continue; }
                if (this.deadlineReached()) {
                    this.event(route.name, source, 'deferred', { code: 'RUN_LIMIT' }); continue;
                }
                const match = await this.historicalMatch(source, route.target);
                if (match === 'deferred') {
                    this.event(route.name, source, 'deferred', { code: 'RUN_LIMIT' }); continue;
                }
                if (match !== 'absent') {
                    task = this.deps.state.transfers[transferKey(this.record(source).canonical, route.target)];
                    this.event(route.name, source, match, { candidates: task?.candidates });
                    continue;
                }
                if (!this.deps.adapters[route.target].supports(source)) { this.event(route.name, source, 'unsupported'); continue; }
                if (this.deadlineReached()) {
                    this.event(route.name, source, 'deferred', { code: 'RUN_LIMIT' }); continue;
                }
                let downloaded;
                try { downloaded = await this.file(source); }
                catch (error) {
                    if (!this.incompleteEvidence(error)) throw error;
                    task = this.task(source, route.target);
                    task.status = 'review'; task.code = error.code;
                    await this.save();
                    this.event(route.name, source, 'review', { code: error.code });
                    continue;
                }
                if (this.deadlineReached()) {
                    this.event(route.name, source, 'deferred', { code: 'RUN_LIMIT' }); continue;
                }
                if (!this.options.apply) { this.event(route.name, source, 'planned'); continue; }
                const targetWindow = { start: downloaded.evidence.start - 60000, end: downloaded.evidence.start + 60000 };
                const freshTargets = await scanAll(this.deps.adapters[route.target], this.options.deadline, targetWindow);
                this.ingest(route.target, freshTargets, false, false);
                const freshMatch = await this.historicalMatch(source, route.target, freshTargets);
                if (freshMatch === 'deferred') {
                    this.event(route.name, source, 'deferred', { code: 'RUN_LIMIT' }); continue;
                }
                if (freshMatch !== 'absent') {
                    task = this.deps.state.transfers[transferKey(this.record(source).canonical, route.target)];
                    this.event(route.name, source, freshMatch, { candidates: task?.candidates });
                    continue;
                }
                task = this.task(source, route.target);
                task.status = 'pending'; task.code = undefined;
                task.receipt = undefined;
                task.evidence = { ...downloaded.evidence };
                // A preexisting activity can later be edited into the matching time window.
                task.beforeIds = freshTargets.map(activity => activity.id);
                const uploadPath = path.join(path.dirname(downloaded.file), task.filename);
                await fs.copyFile(downloaded.file, uploadPath);
                await fs.chmod(uploadPath, 0o600);
                await this.save();
                if (this.deadlineReached()) {
                    task.beforeIds = undefined;
                    task.code = 'RUN_LIMIT';
                    await this.save();
                    await fs.rm(uploadPath, { force: true });
                    this.event(route.name, source, 'deferred', { code: 'RUN_LIMIT' });
                    continue;
                }
                task.status = 'uploading';
                await this.save();
                try { await this.deps.publishIntent(createUploadIntent(this.deps.state, task)); }
                catch (error) { await this.rollbackBeforeImport(task, error); }
                try { await this.deps.assertOwned(); }
                catch (error) { await this.rollbackBeforeImport(task, error); }
                try { task.receipt = await this.deps.adapters[route.target].upload(uploadPath, task); }
                catch (error) {
                    if (ownershipFailure(error)) await this.rollbackBeforeImport(task, error);
                    task.receipt = { status: 'unknown', code: 'UPLOAD_OUTCOME_UNKNOWN' };
                }
                task.status = task.receipt.status === 'failed' ? 'failed' :
                    task.receipt.status === 'retryable' ? 'pending' : 'verifying';
                task.code = task.receipt.code;
                if (['failed', 'pending'].includes(task.status)) task.beforeIds = undefined;
                await this.save();
                if (['retryable', 'failed'].includes(task.receipt.status)) await this.deps.clearIntent();
                if (task.receipt.status === 'retryable') {
                    await fs.rm(uploadPath, { force: true });
                    this.event(route.name, source, 'deferred', { code: task.code });
                    if (task.code === 'RATE_LIMIT') break;
                    continue;
                }
                if (task.status === 'failed') {
                    this.event(route.name, source, 'failed', { code: task.code });
                    if (task.code === 'AUTH') throw new SyncError('AUTH', 'Authentication failed; further uploads stopped.');
                    continue;
                }
                const complete = await this.verify(task);
                this.event(route.name, source, complete ? 'uploaded' : 'verifying', { targetId: task.receipt.targetId, code: task.code });
                if (complete) await fs.rm(uploadPath, { force: true });
                else blocked = true;
            }
        }
        await this.save();
        return this.events;
    }

    async link(source: ActivityRecord, target: ActivityRecord): Promise<void> {
        this.mergeCanonical(source.canonical, target.canonical);
        for (const transfer of Object.values(this.deps.state.transfers)) {
            if (transfer.canonical !== source.canonical) continue;
            const mapped = Object.values(this.deps.state.activities).find(record => record.canonical === source.canonical && record.activity.slot === transfer.target);
            if (mapped) {
                transfer.status = 'complete'; transfer.code = undefined; transfer.candidates = undefined; transfer.beforeIds = undefined;
                transfer.receipt = { status: 'accepted', stage: 'finished', targetId: mapped.activity.id };
            }
        }
        await this.save();
    }

    async ignore(source: Activity, target: Slot): Promise<void> {
        const existing = this.deps.state.transfers[transferKey(this.record(source).canonical, target)];
        if (existing && ['uploading', 'verifying'].includes(existing.status)) {
            if (existing.receipt?.stage !== 'finished') {
                throw new SyncError('UNRESOLVED_IMPORT', 'Verify this outstanding COROS import before ignoring it.');
            }
            const liveCandidates = candidatesNear(existing.evidence ?? source, this.inventory[target]);
            if (liveCandidates.length) {
                throw new SyncError('UNRESOLVED_IMPORT', 'A nearby COROS activity still exists; link it before ignoring the import.');
            }
        }
        const task = existing ?? this.task(source, target);
        task.status = 'ignored'; task.code = 'MANUAL_IGNORE';
        await this.save();
    }
}
