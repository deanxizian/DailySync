require('ts-node/register/transpile-only');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ActivitySynchronizer } = require('../../src/sync/engine');
const { emptyState, SLOTS } = require('../../src/sync/types');
const { validateState } = require('../../src/sync/state');
const { validateUploadIntent } = require('../../src/sync/upload-intent');

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const start = Date.parse('2025-04-06T03:00:00Z');

function activity(slot, id, offset = 0, overrides = {}) {
    return { slot, id, start: start + offset, sport: 'running', duration: 1800, distance: 5000, ...overrides };
}

function evidence(activity, tag = activity.id) {
    return { sha256: hash(tag), device: hash(`device-${tag}`), start: activity.start, sport: activity.sport,
        duration: activity.duration, distance: activity.distance };
}

class FakeAdapter {
    constructor(slot, items = []) {
        this.slot = slot;
        this.items = clone(items);
        this.evidences = new Map(items.map(item => [item.id, evidence(item)]));
        this.uploads = [];
        this.pages = [];
        this.downloads = [];
        this.identity = hash(slot);
        this.receipt = null;
        this.delay = false;
        this.pageSize = 2;
        this.serial = 0;
    }
    async connect() { return this.identity; }
    session() { return undefined; }
    setWriteGuard(guard) { this.guard = guard; }
    supports(item) { return item.sport === 'running'; }
    async page(cursor, window) {
        this.pages.push(window ? { cursor, window: clone(window) } : cursor);
        if (this.onPage) await this.onPage(cursor, window);
        const items = this.items.filter(item => !window || (item.start >= window.start && item.start <= window.end))
            .sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
        const batch = items.slice(cursor, cursor + this.pageSize);
        return { activities: clone(batch), next: batch.length ? cursor + batch.length : null };
    }
    async download(item, directory) {
        this.downloads.push(item.id);
        if (this.onDownload) await this.onDownload(item);
        const file = path.join(directory, 'original.fit');
        const proof = this.evidences.get(item.id) ?? evidence(item);
        await fs.writeFile(file, JSON.stringify({ item, evidence: proof }), { mode: 0o600, flag: 'wx' });
        return file;
    }
    async upload(file, task) {
        await this.guard?.();
        this.uploads.push(clone(task));
        if (this.onUpload) return this.onUpload(file, task);
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const id = `${this.slot}-${++this.serial}`;
        const item = { ...data.item, slot: this.slot, id };
        this.evidences.set(id, data.evidence);
        if (this.delay) this.delayed = item;
        else this.items.push(item);
        return this.receipt ?? (this.slot === 'coros-cn'
            ? { status: 'accepted', stage: 'submitted', taskId: `task-${this.serial}` }
            : { status: 'accepted', targetId: id });
    }
    async verify(task) {
        if (this.onVerify) return this.onVerify(task);
        if (this.delay) return { status: 'pending', taskId: `task-${this.serial}` };
        if (this.delayed) { this.items.push(this.delayed); this.delayed = undefined; }
        if (this.slot === 'coros-cn') return { status: 'accepted', stage: 'finished', taskId: `task-${this.serial}` };
        return task.receipt ?? { status: 'unknown' };
    }
}

async function harness(t, initial = {}, state = emptyState()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const adapters = Object.fromEntries(SLOTS.map(slot => [slot, new FakeAdapter(slot, initial[slot] ?? [])]));
    const context = { directory, state, adapters, checkpoints: [], published: [], cleared: 0, assertions: 0 };
    context.run = async (options = {}, overrides = {}) => {
        const engine = new ActivitySynchronizer({ adapters, state: context.state, directory,
            evidence: async file => JSON.parse(await fs.readFile(file, 'utf8')).evidence,
            wait: async () => {}, assertOwned: async () => { context.assertions++; },
            checkpoint: async value => { validateState(value); context.checkpoints.push(clone(value)); },
            publishIntent: async value => { validateUploadIntent(value); context.published.push(clone(value)); },
            clearIntent: async () => { context.cleared++; }, ...overrides },
        { apply: true, pollAttempts: 1, ...options });
        return engine.run();
    };
    return context;
}

module.exports = { activity, evidence, hash, clone, FakeAdapter, harness, start };
