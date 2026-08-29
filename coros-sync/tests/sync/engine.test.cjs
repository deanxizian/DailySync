const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activity, evidence, clone, FakeAdapter, harness, start } = require('./helpers.cjs');
const { scanAll, sameRecording, ActivitySynchronizer, syncExitCode } = require('../../src/sync/engine');
const { activityKey, emptyState, transferKey } = require('../../src/sync/types');
const { SyncError } = require('../../src/sync/errors');
const { mergeUploadIntent } = require('../../src/sync/upload-intent');

test('preview scans both complete histories and never checkpoints or uploads', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    const events = await h.run({ apply: false });
    assert.equal(events.filter(event => event.status === 'planned').length, 1);
    assert.equal(h.checkpoints.length, 0);
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    assert.deepEqual(h.adapters['garmin-cn'].pages, [0, 1]);
    assert.deepEqual(h.adapters['coros-cn'].pages, [0]);
});

test('migration offsets are newest-first and single-page mode limits the source batch', async t => {
    const h = await harness(t, { 'garmin-cn': [
        activity('garmin-cn', 'old'), activity('garmin-cn', 'middle', 86400000), activity('garmin-cn', 'latest', 2 * 86400000),
    ] });
    const events = await h.run({ apply: false, sourceOffset: 1, sourceLimit: 1 });
    assert.deepEqual(events.filter(event => event.status === 'planned').map(event => event.source), ['garmin-cn:middle']);
    assert.equal(events.some(event => event.source === 'garmin-cn:old'), false);
    assert.equal(events.some(event => event.source === 'garmin-cn:latest'), false);
    assert.deepEqual(h.adapters['garmin-cn'].downloads, ['middle']);
});

test('only Garmin CN records flow to COROS and repeated runs are idempotent', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')],
        'coros-cn': [activity('coros-cn', 'coros-only', -86400000)] });
    const events = await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    assert.equal(h.adapters['garmin-cn'].uploads.length, 0);
    assert.equal(events.filter(event => event.status === 'uploaded').length, 1);
    assert.equal(Object.values(h.state.transfers).filter(task => task.status === 'complete').length, 1);
    const downloads = Object.values(h.adapters).map(adapter => adapter.downloads.length);
    await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    assert.deepEqual(Object.values(h.adapters).map(adapter => adapter.downloads.length), downloads);
});

test('later-added old Garmin records are found by full-history scans', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'recent')] });
    await h.run();
    h.adapters['garmin-cn'].items.push(activity('garmin-cn', 'old-late', -400 * 86400000));
    const events = await h.run();
    assert.ok(events.some(event => event.source === 'garmin-cn:old-late' && event.status === 'uploaded'));
});

test('historical FIT evidence links an existing COROS copy without uploading', async t => {
    const g = activity('garmin-cn', 'g1');
    const c = activity('coros-cn', 'c1');
    const h = await harness(t, { 'garmin-cn': [g], 'coros-cn': [c] });
    h.adapters['coros-cn'].evidences.set('c1', evidence(g));
    const events = await h.run();
    assert.ok(events.some(event => event.status === 'matched'));
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    assert.equal(h.state.activities['garmin-cn:g1'].canonical, h.state.activities['coros-cn:c1'].canonical);
});

test('unsupported upload sports still link to an existing historical recording', async t => {
    const g = activity('garmin-cn', 'g1', 0, { sport: 'rowing' });
    const c = activity('coros-cn', 'c1', 0, { sport: 'rowing' });
    const h = await harness(t, { 'garmin-cn': [g], 'coros-cn': [c] });
    h.adapters['coros-cn'].evidences.set('c1', evidence(g));
    const events = await h.run();
    assert.ok(events.some(event => event.status === 'matched'));
    assert.equal(events.some(event => event.status === 'unsupported'), false);
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
});

test('metadata resemblance without matching FIT evidence requires review', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')], 'coros-cn': [activity('coros-cn', 'c1')] });
    const events = await h.run();
    assert.ok(events.some(event => event.status === 'review' && event.candidates.includes('c1')));
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    const proof = evidence(activity('garmin-cn', 'g1'));
    assert.equal(sameRecording(proof, { ...proof, start: start + 86400000 }), false);
});

test('persisted reviews are re-evaluated when evidence or nearby activities change', async t => {
    const g = activity('garmin-cn', 'g1');
    const c = activity('coros-cn', 'c1');
    const recovered = await harness(t, { 'garmin-cn': [g], 'coros-cn': [c] });
    recovered.adapters['coros-cn'].onDownload = async () => {
        throw new SyncError('DOWNLOAD', 'Test temporary export failure.');
    };
    assert.ok((await recovered.run()).some(event => event.status === 'review'));
    recovered.adapters['coros-cn'].onDownload = undefined;
    recovered.adapters['coros-cn'].evidences.set('c1', evidence(g));
    assert.ok((await recovered.run()).some(event => event.status === 'matched'));
    assert.equal(recovered.adapters['coros-cn'].uploads.length, 0);

    const removed = await harness(t, { 'garmin-cn': [g], 'coros-cn': [c] });
    assert.ok((await removed.run()).some(event => event.status === 'review'));
    removed.adapters['coros-cn'].items = [];
    assert.ok((await removed.run()).some(event => event.status === 'uploaded'));
    assert.equal(removed.adapters['coros-cn'].uploads.length, 1);
});

test('an unreadable COROS candidate cannot become an unambiguous historical match', async t => {
    const g = activity('garmin-cn', 'g1');
    const h = await harness(t, { 'garmin-cn': [g], 'coros-cn': [activity('coros-cn', 'a'), activity('coros-cn', 'b')] });
    h.adapters['coros-cn'].evidences.set('a', evidence(g));
    h.adapters['coros-cn'].onDownload = async item => { if (item.id === 'b') throw new SyncError('FIT_INVALID', 'Test invalid FIT.'); };
    assert.ok((await h.run()).some(event => event.status === 'review'));
});

test('one unavailable COROS export becomes review evidence without blocking later activities', async t => {
    const first = activity('garmin-cn', 'g1');
    const later = activity('garmin-cn', 'g2', 86400000);
    const h = await harness(t, { 'garmin-cn': [first, later], 'coros-cn': [activity('coros-cn', 'c1')] });
    h.adapters['coros-cn'].onDownload = async item => {
        if (item.id === 'c1') throw new SyncError('DOWNLOAD', 'Test unavailable export.');
    };
    const events = await h.run();
    assert.ok(events.some(event => event.source === 'garmin-cn:g1' && event.status === 'review'));
    assert.ok(events.some(event => event.source === 'garmin-cn:g2' && event.status === 'uploaded'));
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
});

test('one permanently unavailable Garmin export is reviewed without blocking older activities', async t => {
    const unavailable = activity('garmin-cn', 'unavailable', 86400000);
    const older = activity('garmin-cn', 'older');
    const h = await harness(t, { 'garmin-cn': [unavailable, older] });
    h.adapters['garmin-cn'].onDownload = async item => {
        if (item.id === 'unavailable') throw new SyncError('GARMIN_EXPORT_UNAVAILABLE', 'Test missing export.');
    };
    const events = await h.run();
    assert.ok(events.some(event => event.source === 'garmin-cn:unavailable' &&
        event.status === 'review' && event.code === 'GARMIN_EXPORT_UNAVAILABLE'));
    assert.ok(events.some(event => event.source === 'garmin-cn:older' && event.status === 'uploaded'));
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
});

test('manual COROS deletion is preserved and never reuploaded', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    await h.run();
    const removed = h.adapters['coros-cn'].items[0];
    h.adapters['coros-cn'].items = [];
    let events = await h.run();
    assert.ok(events.some(event => event.status === 'preserved-deletion' && event.code === 'MISSING_UNCONFIRMED'));
    assert.equal(h.state.activities[activityKey('coros-cn', removed.id)].missing, 1);
    events = await h.run();
    assert.ok(events.some(event => event.status === 'preserved-deletion' && event.code === 'DELETED'));
    assert.equal(h.state.activities[activityKey('coros-cn', removed.id)].missing, 2);
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    const settled = clone(h.state);
    await h.run();
    assert.equal(JSON.stringify(h.state), JSON.stringify(settled));
});

test('one failed page prevents deletion inference and all writes', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    await h.run();
    h.adapters['coros-cn'].items = [];
    const before = clone(h.state);
    h.adapters['coros-cn'].onPage = () => { throw new SyncError('PROTOCOL', 'Test failed page.'); };
    await assert.rejects(h.run(), { code: 'PROTOCOL' });
    assert.deepEqual(h.state.activities, before.activities);
});

test('pagination has no 999-record ceiling and rejects repeated pages', async () => {
    const adapter = new FakeAdapter('garmin-cn', Array.from({ length: 1005 }, (_, i) => activity('garmin-cn', String(i), -i * 1000)));
    adapter.pageSize = 100;
    assert.equal((await scanAll(adapter)).length, 1005);
    adapter.page = async cursor => ({ activities: [activity('garmin-cn', 'same')], next: cursor + 1 });
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });
    adapter.page = async () => ({ activities: [], next: 1 });
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });

    adapter.page = async cursor => cursor === 0
        ? { activities: [activity('garmin-cn', 'one')], next: 1, total: 2 }
        : { activities: [], next: null, total: 1 };
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });

    adapter.page = async cursor => cursor === 0
        ? { activities: [activity('garmin-cn', 'one')], next: 1, total: 2 }
        : { activities: [], next: null, total: 2 };
    await assert.rejects(scanAll(adapter), { code: 'SCAN_INCOMPLETE' });
});

test('deadline expiry after scanning defers matching before any FIT download', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')],
        'coros-cn': [activity('coros-cn', 'c1')] });
    h.adapters['coros-cn'].onPage = async cursor => {
        if (cursor === 1) await new Promise(resolve => setTimeout(resolve, 40));
    };
    const events = await h.run({ apply: false, deadline: Date.now() + 20 });
    assert.ok(events.some(event => event.status === 'deferred' && event.code === 'RUN_LIMIT'));
    assert.deepEqual(h.adapters['garmin-cn'].downloads, []);
    assert.deepEqual(h.adapters['coros-cn'].downloads, []);
});

test('deadline is rechecked between historical FIT candidates', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')], 'coros-cn': [
        activity('coros-cn', 'a'), activity('coros-cn', 'b'),
    ] });
    h.adapters['coros-cn'].onDownload = async item => {
        if (item.id === 'a') await new Promise(resolve => setTimeout(resolve, 50));
    };
    const events = await h.run({ apply: false, deadline: Date.now() + 30 });
    assert.ok(events.some(event => event.status === 'deferred' && event.code === 'RUN_LIMIT'));
    assert.deepEqual(h.adapters['coros-cn'].downloads, ['a']);
});

test('deadline expiry during the source FIT download never starts an upload', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['garmin-cn'].onDownload = async () => new Promise(resolve => setTimeout(resolve, 50));
    const events = await h.run({ deadline: Date.now() + 30 });
    assert.ok(events.some(event => event.status === 'deferred' && event.code === 'RUN_LIMIT'));
    assert.deepEqual(h.adapters['garmin-cn'].downloads, ['g1']);
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    assert.equal(Object.keys(h.state.transfers).length, 0);
});

test('an empty final COROS scan that crosses the deadline creates no transfer', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].onPage = async (_cursor, window) => {
        if (window) await new Promise(resolve => setTimeout(resolve, 40));
    };
    const events = await h.run({ deadline: Date.now() + 20 });

    assert.ok(events.some(event => event.status === 'deferred' && event.code === 'RUN_LIMIT'));
    assert.equal(Object.keys(h.state.transfers).length, 0);
    assert.equal(h.published.length, 0);
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
});

test('incomplete runs return an attention exit code', () => {
    const base = { route: 'garmin-to-coros', source: 'garmin-cn:g1' };
    assert.equal(syncExitCode([{ ...base, status: 'deferred', code: 'RUN_LIMIT' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'deferred', code: 'UNRESOLVED_IMPORT' }]), 2);
    assert.equal(syncExitCode([{ ...base, status: 'existing' }]), 0);
});

test('upload followed by a failed COROS read is recovered without resending', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].onPage = () => {
        if (h.adapters['coros-cn'].uploads.length) throw new SyncError('TRANSPORT', 'Test disconnect.');
    };
    await assert.rejects(h.run(), { code: 'TRANSPORT' });
    h.state = clone(h.checkpoints.at(-1));
    h.adapters['coros-cn'].onPage = undefined;
    const events = await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    assert.ok(events.some(event => event.status === 'matched'));
});

test('post-import verification scans only the activity window and preserves the full target inventory', async t => {
    const oldSource = activity('garmin-cn', 'g-old', -10 * 86400000);
    const oldTarget = activity('coros-cn', 'c-old', -10 * 86400000);
    const history = Array.from({ length: 200 }, (_, index) =>
        activity('coros-cn', `history-${index}`, -(index + 20) * 86400000));
    history.push(oldTarget);
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g-new'), oldSource], 'coros-cn': history });
    h.adapters['garmin-cn'].evidences.set(oldSource.id, evidence(oldSource, 'old-recording'));
    h.adapters['coros-cn'].evidences.set(oldTarget.id, evidence(oldTarget, 'old-recording'));

    const events = await h.run();
    const scoped = h.adapters['coros-cn'].pages.filter(page => typeof page === 'object');
    assert.ok(scoped.length > 0 && scoped.length <= 4);
    assert.ok(h.adapters['coros-cn'].pages.filter(page => typeof page === 'number').length > 100);
    assert.ok(events.some(event => event.source === 'garmin-cn:g-new' && event.status === 'uploaded'));
    assert.ok(events.some(event => event.source === 'garmin-cn:g-old' && event.status === 'matched'));
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
});

test('a final scoped refresh catches a COROS recording that appeared after the initial scan', async t => {
    const oldSource = activity('garmin-cn', 'g-old');
    const newSource = activity('garmin-cn', 'g-new', 86400000);
    const nativeOld = activity('coros-cn', 'native-old');
    const h = await harness(t, { 'garmin-cn': [oldSource, newSource] });
    h.adapters['garmin-cn'].evidences.set(oldSource.id, evidence(oldSource, 'same-old-recording'));
    h.adapters['coros-cn'].evidences.set(nativeOld.id, evidence(nativeOld, 'same-old-recording'));
    let injected = false;
    h.adapters['coros-cn'].onVerify = async task => {
        if (!injected) {
            h.adapters['coros-cn'].items.push(nativeOld);
            injected = true;
        }
        return { status: 'accepted', stage: 'finished', taskId: task.receipt.taskId };
    };

    const events = await h.run();

    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    assert.ok(events.some(event => event.source === 'garmin-cn:g-old' && event.status === 'matched'));
    assert.equal(h.state.activities['garmin-cn:g-old'].canonical, h.state.activities['coros-cn:native-old'].canonical);
});

test('outstanding COROS imports reconcile after the Garmin source disappears', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].delay = true;
    await h.run();
    h.state = clone(h.checkpoints.at(-1));
    h.adapters['garmin-cn'].items = [];
    h.adapters['coros-cn'].delay = false;
    const events = await h.run();
    assert.ok(events.some(event => event.status === 'matched'));
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
});

test('asynchronous task IDs are never treated as COROS activity IDs', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].delay = true;
    let events = await h.run();
    assert.ok(events.some(event => event.status === 'verifying'));
    assert.equal(Object.values(h.state.activities).filter(item => item.activity.slot === 'coros-cn').length, 0);
    h.adapters['coros-cn'].delay = false;
    events = await h.run();
    assert.ok(events.some(event => event.status === 'matched'));
    const task = Object.values(h.state.transfers)[0];
    assert.notEqual(task.receipt.targetId, task.receipt.taskId);
});

test('a newly submitted COROS task is polled until it becomes visible', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].delay = true;
    let calls = 0;
    h.adapters['coros-cn'].onVerify = async task => {
        calls++;
        if (calls < 3) return { status: 'unknown', taskId: task.receipt.taskId, code: 'COROS_TASK_NOT_VISIBLE' };
        h.adapters['coros-cn'].items.push(h.adapters['coros-cn'].delayed);
        h.adapters['coros-cn'].delayed = undefined;
        return { status: 'accepted', stage: 'finished', taskId: task.receipt.taskId };
    };

    const events = await h.run({ pollAttempts: 3 });

    assert.equal(calls, 3);
    assert.ok(events.some(event => event.status === 'uploaded'));
    assert.equal(Object.values(h.state.transfers)[0].status, 'complete');
});

test('COROS verification diagnostics are persisted and emitted', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].delay = true;
    await h.run();
    h.adapters['coros-cn'].onVerify = async () => ({ status: 'unknown', taskId: 'task-1', code: 'COROS_TASK_FAILED' });
    const events = await h.run();
    const task = Object.values(h.state.transfers)[0];
    assert.equal(task.code, 'COROS_TASK_FAILED');
    assert.ok(events.some(event => event.status === 'verifying' && event.code === 'COROS_TASK_FAILED'));
});

test('unknown import outcomes do not automatically retry another Garmin source', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1'), activity('garmin-cn', 'g2', 86400000)] });
    h.adapters['coros-cn'].onUpload = async () => ({ status: 'unknown' });
    const events = await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    assert.ok(events.some(event => event.status === 'deferred' && event.code === 'UNRESOLVED_IMPORT'));
    await h.run({ retryFailed: true });
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
});

test('transient staging failures clear durable intents before retrying next run', async t => {
    const targets = [activity('coros-cn', 'old-a', -86400000), activity('coros-cn', 'old-b', -172800000)];
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')], 'coros-cn': targets });
    h.adapters['coros-cn'].onUpload = async () => {
        h.adapters['coros-cn'].onUpload = undefined;
        return { status: 'retryable', code: 'TRANSPORT' };
    };
    let events = await h.run();
    let task = Object.values(h.state.transfers)[0];
    assert.ok(events.some(event => event.status === 'deferred' && event.code === 'TRANSPORT'));
    assert.equal(task.status, 'pending');
    assert.equal(task.beforeIds, undefined);
    assert.equal(h.cleared, 1);
    events = await h.run();
    assert.ok(events.some(event => event.status === 'uploaded'));
    assert.equal(h.adapters['coros-cn'].uploads.length, 2);
    assert.equal(h.cleared, 1);

    const failed = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g2')], 'coros-cn': targets });
    failed.adapters['coros-cn'].onUpload = async () => ({ status: 'failed', code: 'COROS_STAGING_FAILED' });
    await failed.run();
    task = Object.values(failed.state.transfers)[0];
    assert.equal(task.status, 'failed');
    assert.equal(task.beforeIds, undefined);
    assert.equal(failed.cleared, 1);
});

test('a COROS rate limit stops the current batch after one staging attempt', async t => {
    const h = await harness(t, { 'garmin-cn': [
        activity('garmin-cn', 'older'), activity('garmin-cn', 'newer', 86400000),
    ] });
    h.adapters['coros-cn'].onUpload = async () => ({ status: 'retryable', code: 'RATE_LIMIT' });
    const events = await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
    assert.equal(events.filter(event => event.status === 'deferred' && event.code === 'RATE_LIMIT').length, 1);
    assert.equal(Object.keys(h.state.transfers).length, 1);
    assert.equal(h.cleared, 1);
});

test('checkpoint failure before COROS staging prevents the external write', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    await assert.rejects(h.run({}, { checkpoint: async state => {
        if (Object.values(state.transfers).some(task => task.status === 'uploading')) throw new SyncError('STATE_SAVE', 'Test failure.');
    } }), { code: 'STATE_SAVE' });
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
});

test('the upload intent is published before any COROS external write', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    let publishedAtUpload;
    h.adapters['coros-cn'].onUpload = async () => {
        publishedAtUpload = clone(h.published.at(-1));
        return { status: 'failed', code: 'TEST_STOP' };
    };
    await h.run();
    assert.equal(publishedAtUpload.transfer.status, 'uploading');
    assert.equal(Object.prototype.hasOwnProperty.call(publishedAtUpload, 'activities'), false);
    assert.equal(h.published.length, 1);
});

test('remote intent publication failure prevents the COROS external write', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    await assert.rejects(h.run({}, { publishIntent: async () => {
        throw new SyncError('STATE_PUBLISH', 'Test publication failure.');
    } }), { code: 'STATE_PUBLISH' });
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    const task = Object.values(h.state.transfers)[0];
    assert.equal(task.status, 'pending');
    assert.equal(task.beforeIds, undefined);
    assert.equal(h.cleared, 1);
});

test('checkpoint failure after COROS submission recovers from the published intent', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    let durableIntent;
    await assert.rejects(h.run({}, { checkpoint: async state => {
        if (Object.values(state.transfers).some(task => task.status === 'verifying')) throw new SyncError('STATE_SAVE', 'Test disconnect.');
    }, publishIntent: async intent => {
        durableIntent = clone(intent);
        assert.equal(intent.transfer.status, 'uploading');
    } }), { code: 'STATE_SAVE' });
    const durable = mergeUploadIntent(emptyState(), durableIntent);
    assert.equal(Object.values(durable.transfers)[0].status, 'uploading');
    h.state = durable;
    await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 1);
});

test('lost state lock prevents COROS submission after intent checkpoint', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    await assert.rejects(h.run({}, { assertOwned: async () => { throw new SyncError('LOCK_LOST', 'Test lock loss.'); } }), { code: 'LOCK_LOST' });
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    const task = Object.values(h.state.transfers)[0];
    assert.equal(task.status, 'pending');
    assert.equal(task.beforeIds, undefined);
    assert.equal(h.cleared, 1);
});

test('adapter writer-lock failure before import restores a retryable task', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    let assertions = 0;
    await assert.rejects(h.run({}, { assertOwned: async () => {
        if (++assertions === 2) throw new SyncError('LOCK_LOST', 'Test adapter lock loss.');
    } }), { code: 'LOCK_LOST' });
    assert.equal(h.adapters['coros-cn'].uploads.length, 0);
    const task = Object.values(h.state.transfers)[0];
    assert.equal(task.status, 'pending');
    assert.equal(task.beforeIds, undefined);
    assert.equal(h.cleared, 1);
});

test('account changes stop before upload', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    await h.run();
    h.adapters['coros-cn'].identity = 'a'.repeat(64);
    await assert.rejects(h.run(), { code: 'ACCOUNT_CHANGED' });
});

test('daily sync processes a backlog larger than the default Garmin page size in one run', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1'), activity('garmin-cn', 'g2', 86400000)] });
    const events = await h.run();
    assert.equal(h.adapters['coros-cn'].uploads.length, 2);
    assert.equal(events.some(event => event.code === 'RUN_LIMIT'), false);
    assert.equal(Object.values(h.state.transfers).filter(task => task.status === 'complete').length, 2);
});

test('mapped targets are indexed once for a no-op history scan', async t => {
    const count = 100;
    const sources = [];
    const targets = [];
    const state = emptyState();
    const records = {};
    for (let index = 0; index < count; index++) {
        const source = activity('garmin-cn', `g${index}`, index * 86400000);
        const target = activity('coros-cn', `c${index}`, index * 86400000);
        const canonical = `canonical_${index}`;
        sources.push(source);
        targets.push(target);
        records[`garmin-cn:${source.id}`] = { activity: source, canonical, missing: 0 };
        records[`coros-cn:${target.id}`] = { activity: target, canonical, missing: 0 };
    }
    let enumerations = 0;
    state.activities = new Proxy(records, {
        ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    });
    const h = await harness(t, { 'garmin-cn': sources, 'coros-cn': targets }, state);

    const events = await h.run({ apply: false });

    assert.equal(events.filter(event => event.status === 'existing').length, count);
    assert.ok(enumerations < 10, `activity records were enumerated ${enumerations} times`);
});

test('manual ignore persists and manual linking resolves a review', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')], 'coros-cn': [activity('coros-cn', 'c1')] });
    await h.run();
    const engine = new ActivitySynchronizer({ adapters: h.adapters, state: h.state, directory: h.directory,
        checkpoint: async () => {}, publishIntent: async () => {}, clearIntent: async () => {},
        assertOwned: async () => {} }, { apply: true });
    await engine.link(h.state.activities['garmin-cn:g1'], h.state.activities['coros-cn:c1']);
    const canonical = h.state.activities['garmin-cn:g1'].canonical;
    assert.equal(h.state.transfers[transferKey(canonical, 'coros-cn')].status, 'complete');

    const second = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g2', 86400000)] });
    await second.run({ apply: false });
    const ignoreEngine = new ActivitySynchronizer({ adapters: second.adapters, state: second.state, directory: second.directory,
        checkpoint: async () => {}, publishIntent: async () => {}, clearIntent: async () => {},
        assertOwned: async () => {} }, { apply: true });
    await ignoreEngine.ignore(second.state.activities['garmin-cn:g2'].activity, 'coros-cn');
    assert.ok((await second.run()).some(event => event.status === 'ignored'));
    assert.equal(second.adapters['coros-cn'].uploads.length, 0);
});

test('manual ignore can abandon a finished import only after its target is absent', async t => {
    const h = await harness(t, { 'garmin-cn': [activity('garmin-cn', 'g1')] });
    h.adapters['coros-cn'].delay = true;
    await h.run();
    const source = h.state.activities['garmin-cn:g1'];
    const task = h.state.transfers[transferKey(source.canonical, 'coros-cn')];
    const engine = new ActivitySynchronizer({ adapters: h.adapters, state: h.state, directory: h.directory,
        checkpoint: async () => {}, publishIntent: async () => {}, clearIntent: async () => {},
        assertOwned: async () => {} }, { apply: true });
    await engine.scan();
    await assert.rejects(engine.ignore(source.activity, 'coros-cn'), { code: 'UNRESOLVED_IMPORT' });
    task.receipt = { ...task.receipt, status: 'accepted', stage: 'finished' };
    await engine.ignore(source.activity, 'coros-cn');
    assert.equal(task.status, 'ignored');
    assert.equal(task.code, 'MANUAL_IGNORE');
});
