require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { ActivitySynchronizer, scanAll, syncExitCode, syncOutcome, transferFor } = require('../src/core/engine');
const { SyncError } = require('../src/core/errors');
const { activity, evidence, hash, FakeAdapter, harness } = require('./helpers.cjs');

test('a missing Garmin activity uploads once and is skipped on the next stateless run', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    let events = await h.run();
    assert.ok(events.some(event => event.status === 'uploaded'));
    assert.equal(h.target.uploads.length, 1);

    events = await h.run();
    assert.ok(events.some(event => event.status === 'existing'));
    assert.equal(h.target.uploads.length, 1);
});

test('a missing COROS activity uploads to Garmin and is skipped on the next stateless run', async t => {
    const h = await harness(t, { 'coros-cn': [activity('coros-cn', 'c1')] }, 'coros-cn-to-garmin-cn');
    let events = await h.run();
    assert.deepEqual(events.map(event => [event.route, event.status]), [['coros-cn-to-garmin-cn', 'uploaded']]);
    assert.equal(h.target.saved.loginHash, hash('login'));
    assert.equal(h.target.uploads.length, 1);

    events = await h.run();
    assert.equal(events[0].status, 'existing');
    assert.equal(h.target.uploads.length, 1);
});

test('a unique summary match is treated as existing without downloading FIT files', async t => {
    const source = activity('garmin-cn', 'g1');
    const target = activity('coros-cn', 'c1');
    const h = await harness(t, { 'garmin-cn': [source], 'coros-cn': [target] });
    const events = await h.run();
    assert.deepEqual(events, [{ route: 'garmin-cn-to-coros-cn', source: 'garmin-cn:g1', status: 'existing', targetId: 'c1' }]);
    assert.deepEqual(h.source.downloads, []);
    assert.deepEqual(h.target.downloads, []);
    assert.equal(h.target.uploads.length, 0);
});

test('file evidence fills missing source summary fields for a unique existing match', async t => {
    const source = activity('garmin-cn', 'g1', 0, { duration: null, distance: null });
    const target = activity('coros-cn', 'c1');
    const h = await harness(t, { 'garmin-cn': [source], 'coros-cn': [target] });
    h.source.evidences.set(source.id, evidence({ ...source, duration: 1800, distance: 5000 }));
    const events = await h.run();
    assert.deepEqual(events, [{ route: 'garmin-cn-to-coros-cn', source: 'garmin-cn:g1', status: 'existing', targetId: 'c1' }]);
    assert.deepEqual(h.source.downloads, ['g1']);
    assert.deepEqual(h.target.downloads, []);
    assert.equal(h.target.uploads.length, 0);
});

test('FIT evidence resolves duplicate-looking history and ambiguous history is not uploaded', async t => {
    const source = activity('garmin-cn', 'g1');
    const a = activity('coros-cn', 'a');
    const b = activity('coros-cn', 'b');
    const matched = await harness(t, { 'garmin-cn': [source], 'coros-cn': [a, b] });
    matched.target.evidences.set('b', evidence(source));
    let events = await matched.run();
    assert.equal(events[0].status, 'existing');
    assert.equal(events[0].targetId, 'b');
    assert.equal(matched.target.uploads.length, 0);

    const ambiguous = await harness(t, { 'garmin-cn': [source], 'coros-cn': [a, b] });
    events = await ambiguous.run();
    assert.equal(events[0].status, 'review');
    assert.deepEqual(events[0].candidates, ['a', 'b']);
    assert.equal(ambiguous.target.uploads.length, 0);
});

test('an unrelated nearby activity does not make a missing activity ambiguous', async t => {
    const source = activity('garmin-cn', 'run');
    const nearbyRide = activity('coros-cn', 'ride', 30000, { sport: 'cycling', duration: 7200, distance: 50000 });
    const h = await harness(t, { 'garmin-cn': [source], 'coros-cn': [nearbyRide] });
    const events = await h.run();
    assert.equal(events[0].status, 'uploaded');
    assert.equal(h.target.uploads.length, 1);
    assert.deepEqual(h.target.downloads, []);
});

test('a transfer limit counts actual missing uploads and repeated full scans continue the migration', async t => {
    const sources = Array.from({ length: 105 }, (_, index) =>
        activity('garmin-cn', `source-${index}`, index * 86400000));
    const h = await harness(t, { 'garmin-cn': sources });

    let events = await h.run({ transferLimit: 100 });
    assert.equal(events.filter(event => event.status === 'uploaded').length, 100);
    assert.equal(h.target.uploads.length, 100);
    assert.ok(h.source.pages.includes(104));

    events = await h.run({ transferLimit: 100 });
    assert.equal(events.filter(event => event.status === 'existing').length, 100);
    assert.equal(events.filter(event => event.status === 'uploaded').length, 5);
    assert.equal(h.target.uploads.length, 105);
});

test('daily sync can select one activity and rejects an unknown activity ID', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1'), activity('garmin-cn', 'g2', 86400000)] });
    const events = await h.run({ activityId: 'g1' });
    assert.deepEqual(events.map(event => event.source), ['garmin-cn:g1']);
    await assert.rejects(h.run({ activityId: 'missing' }), { code: 'NOT_FOUND' });
});

test('complete scans reject repeated cursors, overlapping pages and unstable totals', async () => {
    const adapter = new FakeAdapter('garmin-cn', [activity('garmin-cn', 'one')]);
    adapter.page = async () => ({ activities: [activity('garmin-cn', 'one')], next: 0 });
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });

    adapter.page = async cursor => ({ activities: [activity('garmin-cn', 'one')], next: cursor + 1 });
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });

    adapter.page = async cursor => cursor === 0
        ? { activities: [activity('garmin-cn', 'one')], next: 1, total: 2 }
        : { activities: [], next: null, total: 1 };
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });
});

test('complete scans always reach the explicit final page', async () => {
    const adapter = new FakeAdapter('garmin-cn', [
        activity('garmin-cn', 'one'), activity('garmin-cn', 'two', 1), activity('garmin-cn', 'three', 2),
    ]);
    adapter.pageSize = 1;
    const rows = await scanAll(adapter);
    assert.equal(rows.length, 3);
    assert.deepEqual(adapter.pages, [0, 1, 2, 3]);
});

test('the import filename stays stable per source platform and activity ID', () => {
    const source = activity('garmin-cn', 'g1');
    const first = transferFor(source, evidence(source));
    const second = transferFor(source, evidence(source));
    const changed = transferFor(source, evidence(source, 'edited'));
    const other = transferFor(activity('garmin-cn', 'g2'), evidence(source));
    const reverse = transferFor(activity('coros-cn', 'g1'), evidence(source));
    const tcx = transferFor(source, evidence(source), 'tcx');
    assert.equal(first.filename, second.filename);
    assert.equal(first.filename, changed.filename);
    assert.notEqual(first.filename, other.filename);
    assert.notEqual(first.filename, reverse.filename);
    assert.match(first.filename, /^dailysync_[a-f0-9]{32}\.fit$/);
    assert.equal(tcx.filename, first.filename.replace(/\.fit$/, '.tcx'));
});

test('a finished COROS import task is recovered without uploading again', async t => {
    const source = activity('garmin-cn', 'g1');
    const target = activity('coros-cn', 'recovered');
    const h = await harness(t, { 'garmin-cn': [source] });
    const transfer = transferFor(source, evidence(source));
    h.target.evidences.set(target.id, evidence(source));
    h.target.tasks.set(transfer.filename, { taskId: 'old-task', status: 'finished', item: target });

    const events = await h.run();
    assert.equal(events[0].status, 'existing');
    assert.equal(events[0].targetId, target.id);
    assert.equal(h.target.uploads.length, 0);
});

test('a pending prior import blocks the batch instead of being uploaded twice', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source, activity('garmin-cn', 'g2', -86400000)] });
    const transfer = transferFor(source, evidence(source));
    h.target.tasks.set(transfer.filename, { taskId: 'pending-task', status: 'pending', item: activity('coros-cn', 'pending') });

    const events = await h.run();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'verifying');
    assert.equal(h.target.uploads.length, 0);
});

test('ambiguous prior COROS tasks block replay instead of starting another upload', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.target.onVerify = async () => ({ status: 'unknown', code: 'COROS_TASK_AMBIGUOUS' });

    const events = await h.run();
    assert.equal(events[0].status, 'verifying');
    assert.equal(events[0].code, 'COROS_TASK_AMBIGUOUS');
    assert.equal(h.target.uploads.length, 0);
});

test('an incomplete COROS task scan blocks replay instead of starting another upload', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.target.onVerify = async () => ({ status: 'unknown', code: 'COROS_TASK_SCAN_INCOMPLETE' });

    const events = await h.run();
    assert.equal(events[0].status, 'verifying');
    assert.equal(events[0].code, 'COROS_TASK_SCAN_INCOMPLETE');
    assert.equal(h.target.uploads.length, 0);
});

test('terminal COROS task failures do not block later activities', async t => {
    const failed = activity('garmin-cn', 'failed', 86400000);
    const next = activity('garmin-cn', 'next');
    const h = await harness(t, { 'garmin-cn': [failed, next] });
    const transfer = transferFor(failed, evidence(failed));
    h.target.tasks.set(transfer.filename, { taskId: 'failed-task', status: 'failed', item: activity('coros-cn', 'none') });
    const originalVerify = h.target.verify.bind(h.target);
    h.target.verify = async task => {
        const saved = h.target.tasks.get(task.filename);
        if (saved?.status === 'failed') return { status: 'unknown', taskId: saved.taskId, code: 'COROS_TASK_FAILED' };
        return originalVerify(task);
    };

    const events = await h.run();
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].code, 'COROS_TASK_FAILED');
    assert.ok(events.some(event => event.source === 'garmin-cn:next' && event.status === 'uploaded'));
    assert.equal(h.target.uploads.length, 1);
});

test('an upload response lost after submission is recovered by its stable filename', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.target.onUpload = async (file, transfer) => {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const item = { ...data.item, slot: 'coros-cn', id: 'from-lost-response' };
        h.target.evidences.set(item.id, data.evidence);
        h.target.tasks.set(transfer.filename, { taskId: 'task-lost', status: 'finished', item });
        return { status: 'unknown', code: 'COROS_IMPORT_UNKNOWN' };
    };
    const events = await h.run();
    assert.equal(events[0].status, 'uploaded');
    assert.equal(events[0].targetId, 'from-lost-response');
    assert.equal(h.target.uploads.length, 1);
});

test('post-import duplicate summaries are resolved with FIT evidence', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.target.onUpload = async (file, transfer) => {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const imported = { ...data.item, slot: 'coros-cn', id: 'imported' };
        const other = activity('coros-cn', 'other');
        const unrelated = activity('coros-cn', 'unrelated', 30000,
            { sport: 'cycling', duration: 7200, distance: 50000 });
        h.target.items.push(imported, other, unrelated);
        h.target.evidences.set(imported.id, data.evidence);
        h.target.evidences.set(other.id, evidence(other));
        h.target.onDownload = async item => {
            if (item.id === unrelated.id) throw new SyncError('DOWNLOAD', 'Unrelated activity cannot be exported.');
        };
        h.target.tasks.set(transfer.filename, { taskId: 'task-imported', status: 'finished', item: imported });
        return { status: 'accepted', stage: 'submitted', taskId: 'task-imported' };
    };

    const events = await h.run();
    assert.equal(events[0].status, 'uploaded');
    assert.equal(events[0].targetId, 'imported');
    assert.equal(h.target.uploads.length, 1);
});

test('an unknown upload outcome stops later uploads until a future scan can resolve it', async t => {
    const h = await harness(t, { 'garmin-cn': [
        activity('garmin-cn', 'new', 86400000), activity('garmin-cn', 'old'),
    ] });
    h.target.onUpload = async () => ({ status: 'unknown', code: 'COROS_IMPORT_UNKNOWN' });
    const events = await h.run();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'verifying');
    assert.equal(h.target.uploads.length, 1);
});

test('a pending asynchronous import is recovered on the next stateless run', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.target.delay = true;
    let events = await h.run();
    assert.equal(events[0].status, 'verifying');
    const filename = h.target.uploads[0].filename;
    h.target.finish(filename);
    events = await h.run();
    assert.equal(events[0].status, 'existing');
    assert.equal(h.target.uploads.length, 1);
});

test('retryable upload failures and rate limits stop the current batch', async t => {
    const h = await harness(t, { 'garmin-cn': [
        activity('garmin-cn', 'new', 86400000), activity('garmin-cn', 'old'),
    ] });
    h.target.onUpload = async () => ({ status: 'retryable', code: 'RATE_LIMIT' });
    const events = await h.run();
    assert.deepEqual(events.map(event => [event.status, event.code]), [['deferred', 'RATE_LIMIT']]);
    assert.equal(h.target.uploads.length, 1);
});

test('a target appearing after the initial scan is found before upload', async t => {
    const source = activity('garmin-cn', 'g1');
    const target = activity('coros-cn', 'late');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.source.onDownload = async () => h.target.items.push(target);
    const events = await h.run();
    assert.equal(events[0].status, 'existing');
    assert.equal(events[0].targetId, 'late');
    assert.equal(h.target.uploads.length, 0);
});

test('all four supported routes use the same stateless engine', async t => {
    for (const [route, sourceSlot] of [
        ['garmin-cn-to-garmin-global', 'garmin-cn'],
        ['garmin-global-to-garmin-cn', 'garmin-global'],
        ['garmin-cn-to-coros-cn', 'garmin-cn'],
        ['coros-cn-to-garmin-cn', 'coros-cn'],
    ]) {
        const h = await harness(t, { [sourceSlot]: [activity(sourceSlot, route)] }, route);
        const events = await h.run();
        assert.equal(events[0].route, route);
        assert.equal(events[0].status, 'uploaded');
    }
});

test('unsupported activities are reported without download or upload', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1', 0, { sport: 'garmin-unknown' })] });
    const events = await h.run();
    assert.equal(events[0].status, 'unsupported');
    assert.deepEqual(h.source.downloads, []);
    assert.equal(h.target.uploads.length, 0);
});

test('a downloaded recording with a mismatched summary is never uploaded', async t => {
    const source = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [source] });
    h.source.evidences.set(source.id, evidence({ ...source, sport: 'cycling' }));
    const events = await h.run();
    assert.deepEqual(events.map(event => [event.status, event.code]), [['review', 'ACTIVITY_FILE_MISMATCH']]);
    assert.equal(h.target.uploads.length, 0);
});

test('an unsupported activity already present in COROS is still recognized as existing', async t => {
    const source = activity('garmin-cn', 'g1', 0, { sport: 'rowing' });
    const target = activity('coros-cn', 'c1', 0, { sport: 'rowing' });
    const h = await harness(t, { 'garmin-cn': [source], 'coros-cn': [target] });
    const events = await h.run();
    assert.deepEqual(events, [{ route: 'garmin-cn-to-coros-cn', source: 'garmin-cn:g1', status: 'existing', targetId: 'c1' }]);
    assert.equal(h.target.uploads.length, 0);
});

test('any unresolved activity returns the attention exit code', () => {
    const base = { route: 'garmin-cn-to-coros-cn', source: 'garmin-cn:g1' };
    assert.equal(syncExitCode([{ ...base, status: 'existing' }]), 0);
    assert.equal(syncExitCode([{ ...base, status: 'uploaded' }]), 0);
    assert.equal(syncExitCode([{ ...base, status: 'review' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'unsupported' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'failed' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'failed' }, { ...base, status: 'existing' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'failed' }, { ...base, status: 'uploaded' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'verifying' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'deferred' }]), 2);
    assert.equal(syncOutcome([{ ...base, status: 'existing' }]), 'success');
    assert.equal(syncOutcome([{ ...base, status: 'unsupported' }]), 'partial');
    assert.equal(syncOutcome([{ ...base, status: 'failed' }]), 'failed');
    assert.equal(syncOutcome([{ ...base, status: 'failed' }, { ...base, status: 'uploaded' }]), 'partial');
    assert.equal(syncOutcome([{ ...base, status: 'deferred' }]), 'incomplete');
});

test('scanner errors retain their sanitized code', async () => {
    const adapter = new FakeAdapter('garmin-cn');
    adapter.page = async () => { throw new SyncError('TRANSPORT', 'test'); };
    await assert.rejects(scanAll(adapter), { code: 'TRANSPORT' });
});
