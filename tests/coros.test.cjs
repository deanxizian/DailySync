require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const JSZip = require('jszip');
const { CorosAdapter, normalizeCoros, validDownloadUrl } = require('../src/platforms/coros');
const { scanAll } = require('../src/core/engine');
const { safeError } = require('../src/core/errors');
const { activity, hash, start } = require('./helpers.cjs');

const success = data => ({ status: 200, data: { result: '0000', data } });
const row = { labelId: '9223372036854775800', startTime: start / 1000, sportType: 100, totalTime: 1800, distance: 5000 };

function fixture(handler, extras = {}) {
    const calls = [], waits = [];
    let logins = 0;
    const http = { request: async config => {
        calls.push(config);
        const result = await handler?.(config);
        if (result) return result;
        if (config.url.endsWith('/account/login')) return success({ accessToken: `test-token-${++logins}` });
        if (config.url.endsWith('/account/query')) return success({ userId: 'user1' });
        if (config.url.endsWith('/activity/query')) return success({ count: 0, dataList: [] });
        throw new Error(`Unexpected test request: ${new URL(config.url).pathname}`);
    } };
    const adapter = new CorosAdapter({ username: 'test@example.invalid', password: 'private-test-password', http,
        wait: async delay => { waits.push(delay); }, ...extras });
    return { adapter, calls, waits };
}

async function uploadFixture(t, handler, extras = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-coros-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { makeFit } = await import('./fit-fixture.mjs');
    const bytes = makeFit();
    assert.ok(bytes.length < 20 * 1024);
    const file = path.join(directory, 'sample.fit');
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const attempt = randomUUID().replace(/-/g, '');
    const transfer = { sourceId: 'g1', filename: `dailysync_${attempt}.fit`,
        evidence: { sha256: createHash('sha256').update(bytes).digest('hex'), start, sport: 'running', duration: 1800, distance: 5000 } };
    const sts = { Region: 'oss-cn-shenzhen', Bucket: 'coros-test', AccessKeyId: 'test-access-key',
        AccessKeySecret: 'test-secret', SecurityToken: 'test-sts-token' };
    const staged = [], removed = [];
    const f = fixture(async config => {
        const result = await handler?.(config);
        if (result) return result;
        if (config.url.endsWith('/api/proxy/oss/sts')) return { status: 200, data: { code: 200,
            data: { credentials: `${Buffer.from(JSON.stringify(sts)).toString('base64')}9y78gpoERW4lBNYL` } } };
        if (config.url.endsWith('/activity/fit/import')) return success({ id: 'task123' });
        if (config.url.endsWith('/activity/fit/getImportSportList')) return success([{ id: 'task123', originalFilename: transfer.filename,
            status: 2, errorSize: 0, finishSize: 1 }]);
    }, { ossFactory: options => ({
        put: async (object, data, settings) => { staged.push({ options, object, data, settings }); },
        delete: async object => { removed.push(object); },
    }), ...extras });
    await f.adapter.connect();
    return { ...f, directory, file, bytes, transfer, sts, staged, removed };
}

test('COROS login uses protocol MD5, China cookies and memory-only tokens', async () => {
    const f = fixture();
    assert.equal(await f.adapter.connect(), hash('coros-cn:user1'));
    const login = f.calls[0];
    assert.equal(login.url, 'https://teamcnapi.coros.com/account/login');
    assert.equal(login.data.accountType, 2);
    assert.equal(login.data.pwd, createHash('md5').update('private-test-password').digest('hex'));
    assert.ok(!JSON.stringify(login).includes('private-test-password'));
    assert.equal(f.calls[1].headers.accesstoken, 'test-token-1');
    assert.equal(f.calls[1].headers.cookie, 'CPL-coros-region=2; CPL-coros-token=test-token-1');
});

test('COROS pagination preserves int64 IDs, UTC time and an explicit empty end page', async () => {
    const f = fixture(config => config.url.endsWith('/activity/query')
        ? config.params.pageNumber === 1
            ? { status: 200, data: `{"result":"0000","data":{"count":1,"pageNumber":1,"totalPage":1,"dataList":[{"labelId":9223372036854775800,"startTime":${start / 1000},"sportType":100,"totalTime":1800,"distance":5000}]}}` }
            : success({ count: 1, pageNumber: 2, totalPage: 1 })
        : undefined);
    await f.adapter.connect();
    const first = await f.adapter.page(0), last = await f.adapter.page(20);
    assert.equal(first.next, 20);
    assert.deepEqual(first, { activities: [{ ...activity('coros-cn', row.labelId), sportCode: 100 }], next: 20, total: 1 });
    assert.deepEqual(last, { activities: [], next: null, total: 1 });
    assert.deepEqual(f.calls.at(-2).params, { modeList: '', pageNumber: 1, size: 20 });
    assert.throws(() => normalizeCoros({ ...row, labelId: Number(row.labelId) }), { code: 'PROTOCOL' });
    assert.throws(() => normalizeCoros({ ...row, startTime: 'local-time' }), { code: 'PROTOCOL' });
    assert.throws(() => normalizeCoros({ ...row, sportType: true }), { code: 'PROTOCOL' });
});

test('COROS full scans accept an omitted list only after the echoed last page', async () => {
    const f = fixture(config => config.url.endsWith('/activity/query')
        ? config.params.pageNumber === 1
            ? success({ count: 1, pageNumber: 1, totalPage: 1, dataList: [row] })
            : success({ count: 1, pageNumber: 2, totalPage: 1 })
        : undefined);
    await f.adapter.connect();
    const activities = await scanAll(f.adapter);
    assert.equal(activities.length, 1);
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/activity/query')).map(call => call.params.pageNumber), [1, 2]);
});

test('COROS pagination treats cursors as activity offsets for migration starts', async () => {
    const page = [
        { ...row, labelId: 'offset20' },
        { ...row, labelId: 'offset21', startTime: start / 1000 - 1 },
    ];
    const f = fixture(config => config.url.endsWith('/activity/query')
        ? success({ count: 22, pageNumber: 2, totalPage: 2, dataList: page }) : undefined);
    await f.adapter.connect();
    const result = await f.adapter.page(21);
    assert.deepEqual(result.activities.map(item => item.id), ['offset21']);
    assert.equal(result.next, 40);
    assert.equal(f.calls.at(-1).params.pageNumber, 2);
});

test('COROS verification windows become bounded China calendar-day queries', async () => {
    const f = fixture(config => config.url.endsWith('/activity/query') ? success({ count: 0 }) : undefined);
    await f.adapter.connect();
    const start = Date.parse('2025-04-06T16:30:00Z');
    await f.adapter.page(40, { start, end: start + 60000 });
    const query = f.calls.find(call => call.url.endsWith('/activity/query')).params;
    assert.deepEqual(query, { modeList: '', pageNumber: 3, size: 20, startDay: '20250406', endDay: '20250408' });
});

test('COROS accepts the empty-account response that omits dataList', async () => {
    const f = fixture(config => config.url.endsWith('/activity/query') ? success({ count: 0 }) : undefined);
    await f.adapter.connect();
    assert.deepEqual(await f.adapter.page(0), { activities: [], next: null, total: 0 });
});

test('COROS malformed or rejected pages are never interpreted as an empty history', async () => {
    for (const data of [{ result: '0000', data: null }, { result: '0000', data: { count: 1 } },
        { result: '0000', data: { count: 1, pageNumber: 1, totalPage: 1 } },
        { result: '0000', data: { count: 1, pageNumber: 3, totalPage: 1 } },
        { result: '0000', data: { count: 0, dataList: {} } },
        { result: '0000', data: { dataList: [] } }, { result: 'changed' }]) {
        const f = fixture(config => config.url.endsWith('/activity/query') ? { status: 200, data } : undefined);
        await f.adapter.connect();
        await assert.rejects(f.adapter.page(0), error => ['PROTOCOL', 'COROS_REJECTED'].includes(error.code));
    }
});

test('COROS read expiry gets only one automatic re-login and rechecks account identity', async () => {
    let pages = 0;
    const f = fixture(config => config.url.endsWith('/activity/query') && ++pages === 1
        ? { status: 200, data: { result: '1019' } } : undefined);
    await f.adapter.connect();
    await f.adapter.page(0);
    assert.equal(f.calls.filter(call => call.url.endsWith('/account/login')).length, 2);
    assert.equal(f.calls.at(-1).headers.accesstoken, 'test-token-2');
    const rejected = fixture(config => config.url.endsWith('/activity/query') ? { status: 401 } : undefined);
    await rejected.adapter.connect();
    await assert.rejects(rejected.adapter.page(0), { code: 'AUTH' });
    assert.equal(rejected.calls.filter(call => call.url.endsWith('/account/login')).length, 2);
    let profiles = 0;
    const changed = fixture(config => config.url.endsWith('/account/query') ? success({ userId: ++profiles === 1 ? 'user1' : 'user2' })
        : config.url.endsWith('/activity/query') ? { status: 200, data: { result: '1019' } } : undefined);
    await changed.adapter.connect();
    await assert.rejects(changed.adapter.page(0), { code: 'ACCOUNT_CHANGED' });
});

test('COROS captcha or failed password login stops without bypass or secret-bearing logs', async () => {
    const f = fixture(() => ({ status: 200, data: { result: 'captcha', message: 'private-test-password', data: { challenge: true } } }));
    await assert.rejects(f.adapter.connect(), error => error.code === 'AUTH' && !safeError(error).includes('private-test-password'));
    assert.equal(f.calls.length, 1);
    const injected = fixture(config => config.url.endsWith('/account/login') ? success({ accessToken: 'token;unsafe' }) : undefined);
    await assert.rejects(injected.adapter.connect(), { code: 'AUTH' });
});

test('COROS reads honor bounded Retry-After and stop on persistent throttling', async () => {
    let reads = 0;
    const f = fixture(config => config.url.endsWith('/activity/query') && ++reads === 1
        ? { status: 429, headers: { 'retry-after': '4' } } : undefined);
    await f.adapter.connect();
    await f.adapter.page(0);
    assert.deepEqual(f.waits, [4000]);
    const long = fixture(config => config.url.endsWith('/activity/query') ? { status: 429, headers: { 'retry-after': '300' } } : undefined);
    await long.adapter.connect();
    await assert.rejects(long.adapter.page(0), { code: 'RATE_LIMIT' });
    assert.equal(long.waits.length, 0);
    const persistent = fixture(config => config.url.endsWith('/activity/query')
        ? { status: 429, headers: { 'retry-after': '1' } } : undefined);
    await persistent.adapter.connect();
    await assert.rejects(persistent.adapter.page(0), { code: 'RATE_LIMIT' });
    assert.deepEqual(persistent.waits, [1000, 2000, 4000]);
    const failed = fixture(config => config.url.endsWith('/activity/query') ? { status: 503 } : undefined);
    await failed.adapter.connect();
    await assert.rejects(failed.adapter.page(0), { code: 'HTTP' });
    assert.deepEqual(failed.waits, [1000, 2000, 4000]);
});

test('COROS download isolates auth headers and disallows redirect or unrelated hosts', async t => {
    const f = await uploadFixture(t, config => config.url.endsWith('/activity/detail/download')
        ? success({ fileUrl: 'https://coros-test.oss-cn-shenzhen.aliyuncs.com/original.fit?signature=test' })
        : config.url.includes('/original.fit') ? { status: 200, data: Buffer.alloc(100, 1) } : undefined);
    const downloaded = await f.adapter.download(normalizeCoros(row), f.directory);
    assert.equal((await fs.stat(downloaded)).mode & 0o777, 0o600);
    assert.deepEqual(f.calls.at(-1).headers, {});
    assert.equal(f.calls.at(-1).maxRedirects, 0);
    assert.deepEqual(f.calls.at(-2).params, { labelId: row.labelId, sportType: 100, fileType: 4 });
    for (const url of ['http://coros.com/file', 'https://coros.com.attacker.invalid/file', 'https://user:pass@coros.com/file', 'https://coros.com:444/file']) {
        assert.throws(() => validDownloadUrl(url), { code: 'DOWNLOAD_URL' });
    }
    const redirect = fixture(config => config.url.endsWith('/activity/detail/download') ? success({ fileUrl: 'https://coros.com/test.fit' })
        : config.url.endsWith('/test.fit') ? { status: 302, headers: { location: 'https://other.invalid/' } } : undefined);
    await redirect.adapter.connect();
    await assert.rejects(redirect.adapter.download(normalizeCoros(row), f.directory), { code: 'DOWNLOAD' });
});

test('COROS per-activity export rejection is recoverable but service failures still stop', async t => {
    for (const response of [{ status: 404 }, { status: 200, data: { result: 'EXPORT_NOT_AVAILABLE' } },
        success({ fileUrl: 'https://untrusted.invalid/original.fit' })]) {
        const unavailable = await uploadFixture(t, config => config.url.endsWith('/activity/detail/download') ? response : undefined);
        await assert.rejects(unavailable.adapter.download(normalizeCoros(row), unavailable.directory), { code: 'DOWNLOAD' });
    }
    const outage = await uploadFixture(t, config => config.url.endsWith('/activity/detail/download') ? { status: 503 } : undefined);
    await assert.rejects(outage.adapter.download(normalizeCoros(row), outage.directory), { code: 'HTTP' });
    assert.deepEqual(outage.waits, [1000, 2000, 4000]);
});

test('COROS stages one unchanged FIT in OSS and submits timezone 32 and original-file metadata', async t => {
    const f = await uploadFixture(t);
    const receipt = await f.adapter.upload(f.file, f.transfer);
    assert.deepEqual(receipt, { status: 'accepted', stage: 'submitted', taskId: 'task123' });
    assert.equal(receipt.targetId, undefined);
    const md5 = createHash('md5').update(f.bytes).digest('hex');
    const staged = f.staged[0];
    assert.equal(staged.options.secure, true);
    assert.equal(staged.options.stsToken, f.sts.SecurityToken);
    assert.equal(staged.object, `fit_zip/user1/${md5}.zip`);
    assert.deepEqual(staged.settings.headers, { 'x-oss-forbid-overwrite': 'true' });
    assert.deepEqual(staged.settings.meta, {
        'dailysync-sha256': createHash('sha256').update(staged.data).digest('hex'),
        'dailysync-filename': f.transfer.filename,
    });
    const zip = await JSZip.loadAsync(staged.data);
    const files = Object.values(zip.files).filter(item => !item.dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, `${md5}/${f.transfer.filename}`);
    assert.deepEqual(await files[0].async('nodebuffer'), f.bytes);
    await f.adapter.upload(f.file, f.transfer);
    assert.deepEqual(f.staged[1].data, staged.data);
    const form = f.calls.find(call => call.url.endsWith('/activity/fit/import')).data.getBuffer().toString();
    const metadata = JSON.parse(/name="jsonParameter"\r\n\r\n([^\r\n]+)/.exec(form)[1]);
    assert.deepEqual(metadata, { source: 1, timezone: 32, bucket: f.sts.Bucket, md5, size: f.bytes.length,
        object: staged.object, serviceName: 'aliyun', oriFileName: f.transfer.filename });
    f.transfer.receipt = receipt;
    assert.deepEqual(await f.adapter.verify(f.transfer), { status: 'accepted', stage: 'finished', taskId: 'task123' });
    assert.equal(f.adapter.supports(activity('garmin-cn', 'walk', 0, { sport: 'walking' })), true);
    assert.equal(f.adapter.supports(activity('garmin-cn', 'g', 0, { sport: 'garmin-unknown' })), false);
});

test('COROS stages validated TCX with its deterministic original filename', async t => {
    const f = await uploadFixture(t);
    const file = path.join(f.directory, 'sample.tcx');
    await fs.rename(f.file, file);
    f.transfer.filename = f.transfer.filename.replace(/\.fit$/, '.tcx');
    const receipt = await f.adapter.upload(file, f.transfer);
    assert.equal(receipt.status, 'accepted');
    const zip = await JSZip.loadAsync(f.staged[0].data);
    const files = Object.values(zip.files).filter(item => !item.dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].name.endsWith(`/${f.transfer.filename}`), true);
    const form = f.calls.find(call => call.url.endsWith('/activity/fit/import')).data.getBuffer().toString();
    assert.equal(form.includes(`"oriFileName":"${f.transfer.filename}"`), true);
});

test('COROS import timeout is not replayed and filename recovers the task without a response ID', async t => {
    const f = await uploadFixture(t, config => {
        if (config.url.endsWith('/activity/fit/import')) throw new Error('Test lost response with private-token');
    });
    f.transfer.receipt = await f.adapter.upload(f.file, f.transfer);
    assert.equal(f.transfer.receipt.status, 'unknown');
    assert.equal(f.calls.filter(call => call.url.endsWith('/activity/fit/import')).length, 1);
    assert.equal((await f.adapter.verify(f.transfer)).taskId, 'task123');
    assert.equal(JSON.stringify(f.transfer.receipt).includes('private-token'), false);
});

test('COROS write auth rejection stops without retrying login or import POST', async t => {
    const f = await uploadFixture(t, config => config.url.endsWith('/activity/fit/import') ? { status: 200, data: { result: '1019' } } : undefined);
    assert.deepEqual(await f.adapter.upload(f.file, f.transfer), { status: 'failed', code: 'AUTH' });
    assert.equal(f.calls.filter(call => call.url.endsWith('/account/login')).length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/activity/fit/import')).length, 1);
    assert.deepEqual(f.removed, [f.staged[0].object]);
});

test('COROS import throttling remains retryable without replaying the write', async t => {
    const f = await uploadFixture(t, config => config.url.endsWith('/activity/fit/import')
        ? { status: 429, headers: { 'retry-after': '30' } } : undefined);
    assert.deepEqual(await f.adapter.upload(f.file, f.transfer), { status: 'retryable', code: 'RATE_LIMIT' });
    assert.equal(f.calls.filter(call => call.url.endsWith('/activity/fit/import')).length, 1);
    assert.deepEqual(f.removed, [f.staged[0].object]);
    assert.deepEqual(f.waits, []);
});

test('COROS definitive import rejection removes the staged object', async t => {
    const f = await uploadFixture(t, config => config.url.endsWith('/activity/fit/import')
        ? { status: 200, data: { result: 'unsupported-import' } } : undefined);
    assert.deepEqual(await f.adapter.upload(f.file, f.transfer), { status: 'failed', code: 'COROS_REJECTED' });
    assert.equal(f.calls.filter(call => call.url.endsWith('/activity/fit/import')).length, 1);
    assert.deepEqual(f.removed, [f.staged[0].object]);
});

test('COROS never retries when a rejected import cannot remove its staged object', async t => {
    const f = await uploadFixture(t, config => config.url.endsWith('/activity/fit/import')
        ? { status: 429, headers: { 'retry-after': '30' } } : undefined, {
        ossFactory: () => ({ put: async () => {}, delete: async () => { throw new Error('cleanup failed'); } }),
    });
    assert.deepEqual(await f.adapter.upload(f.file, f.transfer),
        { status: 'unknown', code: 'COROS_STAGING_CLEANUP_UNKNOWN' });
});

test('COROS task status distinguishes pending, finished, partial errors and missing jobs', async t => {
    let tasks = [];
    const f = await uploadFixture(t, config => config.url.endsWith('/activity/fit/getImportSportList') ? success(tasks) : undefined);
    f.transfer.receipt = { status: 'accepted', taskId: 'task123' };
    for (const status of [0, 1, 3]) {
        tasks = [{ id: 'task123', status }];
        assert.equal((await f.adapter.verify(f.transfer)).status, 'pending');
    }
    tasks = [{ id: 'task123', status: 2, errorSize: 1, finishSize: 1 }];
    assert.equal((await f.adapter.verify(f.transfer)).code, 'COROS_IMPORT_ERRORS');
    for (const completed of [
        { id: 'task123', status: 2 },
        { id: 'task123', status: 2, errorSize: 0, finishSize: 2 },
    ]) {
        tasks = [completed];
        assert.deepEqual(await f.adapter.verify(f.transfer), { status: 'accepted', stage: 'finished', taskId: 'task123' });
    }
    tasks = [];
    assert.equal((await f.adapter.verify(f.transfer)).code, 'COROS_TASK_NOT_VISIBLE');
    tasks = [{ id: 'task123', status: 2 }, { id: 'task123', status: 2 }];
    assert.equal((await f.adapter.verify(f.transfer)).code, 'COROS_TASK_AMBIGUOUS');
    tasks = {};
    await assert.rejects(f.adapter.verify(f.transfer), { code: 'PROTOCOL' });
});

test('COROS verification expands beyond the ten newest import tasks', async t => {
    const requested = [];
    const f = await uploadFixture(t, config => {
        if (!config.url.endsWith('/activity/fit/getImportSportList')) return undefined;
        requested.push(config.data.size);
        const tasks = Array.from({ length: config.data.size === 10 ? 10 : 12 }, (_, index) => ({
            id: index === 11 ? 'task123' : `other-${index}`,
            originalFilename: `other-${index}.fit`, status: 2, errorSize: 0, finishSize: 1,
        }));
        return success(tasks);
    });
    f.transfer.receipt = { status: 'accepted', taskId: 'task123' };
    assert.deepEqual(await f.adapter.verify(f.transfer), { status: 'accepted', stage: 'finished', taskId: 'task123' });
    assert.deepEqual(requested, [10, 100]);
});

test('COROS caps preflight task scans at the supported maximum', async t => {
    const requested = [];
    const f = await uploadFixture(t, config => {
        if (!config.url.endsWith('/activity/fit/getImportSportList')) return undefined;
        requested.push(config.data.size);
        return success(Array.from({ length: config.data.size }, (_, index) => ({
            id: `other-${index}`, originalFilename: `other-${index}.fit`, status: 2, errorSize: 0, finishSize: 1,
        })));
    });
    assert.deepEqual(await f.adapter.verify(f.transfer),
        { status: 'unknown', code: 'COROS_TASK_NOT_VISIBLE' });
    assert.deepEqual(requested, [10, 100]);
});

test('COROS treats a saturated post-submission task query as incomplete', async t => {
    const requested = [];
    const f = await uploadFixture(t, config => {
        if (!config.url.endsWith('/activity/fit/getImportSportList')) return undefined;
        requested.push(config.data.size);
        return success(Array.from({ length: config.data.size }, (_, index) => ({
            id: `other-${index}`, originalFilename: `other-${index}.fit`, status: 2, errorSize: 0, finishSize: 1,
        })));
    });
    f.transfer.receipt = { status: 'unknown', code: 'COROS_IMPORT_UNKNOWN' };
    assert.deepEqual(await f.adapter.verify(f.transfer),
        { status: 'unknown', code: 'COROS_TASK_SCAN_INCOMPLETE' });
    assert.deepEqual(requested, [10, 100]);
});

test('COROS failed staging or invalid files never submit an import', async t => {
    const f = await uploadFixture(t);
    assert.equal((await f.adapter.upload(f.file, { ...f.transfer, filename: 'activity.gpx' })).code, 'COROS_FILE_TYPE');
    const small = path.join(f.directory, 'small.fit'); await fs.writeFile(small, Buffer.alloc(10));
    assert.equal((await f.adapter.upload(small, f.transfer)).code, 'COROS_FILE_SIZE');
    const changed = path.join(f.directory, 'changed.fit'); await fs.writeFile(changed, Buffer.alloc(100));
    assert.equal((await f.adapter.upload(changed, f.transfer)).code, 'COROS_FILE_MISMATCH');

    const malformed = await uploadFixture(t, config => config.url.endsWith('/api/proxy/oss/sts')
        ? { status: 200, data: { code: 200, data: { credentials: Buffer.from('{}').toString('base64') } } } : undefined);
    assert.equal((await malformed.adapter.upload(malformed.file, malformed.transfer)).code, 'COROS_STAGING_FAILED');
    assert.equal(malformed.staged.length, 0);
    assert.equal(malformed.calls.some(call => call.url.endsWith('/activity/fit/import')), false);
});

test('COROS transient staging failures remain safe to retry before import submission', async t => {
    const unavailable = await uploadFixture(t, config => config.url.endsWith('/api/proxy/oss/sts')
        ? { status: 503 } : undefined);
    assert.deepEqual(await unavailable.adapter.upload(unavailable.file, unavailable.transfer),
        { status: 'retryable', code: 'HTTP' });
    assert.equal(unavailable.calls.filter(call => call.url.endsWith('/api/proxy/oss/sts')).length, 4);
    assert.equal(unavailable.calls.some(call => call.url.endsWith('/activity/fit/import')), false);

    const throttled = await uploadFixture(t, config => config.url.endsWith('/api/proxy/oss/sts')
        ? { status: 429, headers: { 'retry-after': '300' } } : undefined);
    assert.deepEqual(await throttled.adapter.upload(throttled.file, throttled.transfer),
        { status: 'retryable', code: 'RATE_LIMIT' });
    assert.equal(throttled.calls.some(call => call.url.endsWith('/activity/fit/import')), false);
});

test('COROS recovers an existing import task without resubmitting its staging object', async t => {
    let puts = 0, deletes = 0;
    const existing = await uploadFixture(t, undefined, {
        ossFactory: () => ({
            put: async () => {
                puts++;
                throw Object.assign(new Error('Object exists'), { status: 409, code: 'FileAlreadyExists' });
            },
            head: async () => { throw new Error('head must not run when the task exists'); },
            delete: async () => { deletes++; },
        }),
    });
    assert.deepEqual(await existing.adapter.upload(existing.file, existing.transfer),
        { status: 'accepted', stage: 'finished', taskId: 'task123' });
    assert.equal(puts, 1);
    assert.equal(deletes, 0);
    assert.equal(existing.calls.some(call => call.url.endsWith('/activity/fit/import')), false);
});

test('COROS removes and restages only an orphan object after a complete task scan', async t => {
    let puts = 0, deletes = 0, packedSha256;
    let orphan;
    orphan = await uploadFixture(t, config => config.url.endsWith('/activity/fit/getImportSportList')
        ? success([]) : undefined, {
        ossFactory: () => ({
            put: async (_object, data) => {
                packedSha256 = createHash('sha256').update(data).digest('hex');
                if (++puts === 1) throw Object.assign(new Error('Object exists'),
                    { status: 409, code: 'FileAlreadyExists' });
            },
            head: async () => ({ status: 200, meta: {
                'dailysync-sha256': packedSha256,
                'dailysync-filename': orphan.transfer.filename,
            }, res: { headers: { 'last-modified': new Date(Date.now() - 16 * 60 * 1000).toUTCString() } } }),
            delete: async () => { deletes++; },
        }),
    });
    assert.deepEqual(await orphan.adapter.upload(orphan.file, orphan.transfer),
        { status: 'accepted', stage: 'submitted', taskId: 'task123' });
    assert.equal(puts, 2);
    assert.equal(deletes, 1);
    assert.equal(orphan.calls.filter(call => call.url.endsWith('/activity/fit/import')).length, 1);
});

test('COROS keeps an existing object when the task scan is saturated', async t => {
    let puts = 0, deletes = 0;
    const saturated = await uploadFixture(t, config => config.url.endsWith('/activity/fit/getImportSportList')
        ? success(Array.from({ length: config.data.size }, (_, index) => ({ id: `other-${index}`,
            originalFilename: `other-${index}.fit`, status: 2, errorSize: 0, finishSize: 1 }))) : undefined, {
        ossFactory: () => ({
            put: async () => {
                puts++;
                throw Object.assign(new Error('Object exists'), { status: 409, code: 'FileAlreadyExists' });
            },
            head: async () => { throw new Error('head must not run after an incomplete task scan'); },
            delete: async () => { deletes++; },
        }),
    });
    assert.deepEqual(await saturated.adapter.upload(saturated.file, saturated.transfer),
        { status: 'unknown', code: 'COROS_TASK_SCAN_INCOMPLETE' });
    assert.equal(puts, 1);
    assert.equal(deletes, 0);
    assert.equal(saturated.calls.some(call => call.url.endsWith('/activity/fit/import')), false);
});

test('COROS leaves a recent unmatched staging object untouched', async t => {
    let deletes = 0, packedSha256;
    let recent;
    recent = await uploadFixture(t, config => config.url.endsWith('/activity/fit/getImportSportList')
        ? success([]) : undefined, {
        ossFactory: () => ({
            put: async (_object, data) => {
                packedSha256 = createHash('sha256').update(data).digest('hex');
                throw Object.assign(new Error('Object exists'), { status: 409, code: 'FileAlreadyExists' });
            },
            head: async () => ({ status: 200, meta: {
                'dailysync-sha256': packedSha256,
                'dailysync-filename': recent.transfer.filename,
            }, res: { headers: { 'last-modified': new Date().toUTCString() } } }),
            delete: async () => { deletes++; },
        }),
    });
    assert.deepEqual(await recent.adapter.upload(recent.file, recent.transfer),
        { status: 'unknown', code: 'COROS_OBJECT_EXISTS' });
    assert.equal(deletes, 0);
    assert.equal(recent.calls.some(call => call.url.endsWith('/activity/fit/import')), false);
});
