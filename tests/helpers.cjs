require('ts-node/register/transpile-only');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ActivitySynchronizer } = require('../src/core/engine');

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const start = Date.parse('2025-04-06T03:00:00Z');

function activity(slot, id, offset = 0, overrides = {}) {
    return { slot, id, start: start + offset, sport: 'running', duration: 1800, distance: 5000, ...overrides };
}

function evidence(item, tag = item.id) {
    return { sha256: hash(tag), device: hash(`device-${tag}`), records: hash(`records-${tag}`),
        start: item.start, sport: item.sport, duration: item.duration, distance: item.distance };
}

class FakeAdapter {
    constructor(slot, items = []) {
        this.slot = slot;
        this.items = clone(items);
        this.evidences = new Map(items.map(item => [item.id, evidence(item)]));
        this.uploads = [];
        this.pages = [];
        this.downloads = [];
        this.tasks = new Map();
        this.identity = hash(slot);
        this.pageSize = 2;
        this.serial = 0;
    }
    async connect(saved) { this.saved = saved; return this.identity; }
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
    async upload(file, transfer) {
        this.uploads.push(clone(transfer));
        if (this.onUpload) return this.onUpload(file, transfer);
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const id = `${this.slot}-${++this.serial}`;
        const item = { ...data.item, slot: this.slot, id };
        this.evidences.set(id, data.evidence);
        const taskId = `task-${this.serial}`;
        this.tasks.set(transfer.filename, { taskId, status: this.delay ? 'pending' : 'finished', item });
        if (!this.delay) this.items.push(item);
        return { status: 'accepted', stage: 'submitted', taskId };
    }
    async verify(transfer) {
        if (this.onVerify) return this.onVerify(transfer);
        const task = this.tasks.get(transfer.filename);
        if (!task) return { status: 'unknown', code: this.slot === 'coros-cn'
            ? 'COROS_TASK_NOT_VISIBLE' : 'GARMIN_UPLOAD_NOT_VISIBLE' };
        if (task.status === 'pending') return { status: 'pending', taskId: task.taskId };
        if (!this.items.some(item => item.id === task.item.id)) this.items.push(task.item);
        return { status: 'accepted', stage: 'finished', taskId: task.taskId };
    }
    finish(filename) {
        const task = this.tasks.get(filename);
        if (task) task.status = 'finished';
    }
}

async function harness(t, initial = {}, route = 'garmin-cn-to-coros-cn') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const adapters = {
        'garmin-cn': new FakeAdapter('garmin-cn', initial['garmin-cn'] ?? []),
        'garmin-global': new FakeAdapter('garmin-global', initial['garmin-global'] ?? []),
        'coros-cn': new FakeAdapter('coros-cn', initial['coros-cn'] ?? []),
    };
    const routes = {
        'garmin-cn-to-garmin-global': ['garmin-cn', 'garmin-global'],
        'garmin-global-to-garmin-cn': ['garmin-global', 'garmin-cn'],
        'garmin-cn-to-coros-cn': ['garmin-cn', 'coros-cn'],
        'coros-cn-to-garmin-cn': ['coros-cn', 'garmin-cn'],
    };
    const [sourceSlot, targetSlot] = routes[route];
    const source = adapters[sourceSlot];
    const target = adapters[targetSlot];
    const context = { directory, source, target, adapters };
    context.run = async (options = {}, overrides = {}) => {
        const garminSession = { loginHash: hash('login'), token: { oauth1: {}, oauth2: {} } };
        const engine = new ActivitySynchronizer({ source, target, directory,
            sourceSession: source.slot.startsWith('garmin-') ? garminSession : undefined,
            targetSession: target.slot.startsWith('garmin-') ? garminSession : undefined,
            evidence: async file => JSON.parse(await fs.readFile(file, 'utf8')).evidence,
            wait: async () => {}, ...overrides }, { pollAttempts: 2, ...options });
        return engine.run();
    };
    return context;
}

module.exports = { activity, evidence, hash, clone, FakeAdapter, harness, start };
