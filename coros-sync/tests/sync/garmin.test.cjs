require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const JSZip = require('jszip');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const CryptoJS = require('crypto-js');
const { GarminConnect } = require('@gooin/garmin-connect');
const { GarminCnReadOnlyAdapter, normalizeGarmin, garminLoginHash } = require('../../src/sync/garmin');
const { readGarminCnSession } = require('../../src/sync/garmin-db');
const { safeError } = require('../../src/sync/errors');
const { activity, hash, start } = require('./helpers.cjs');

const username = 'test@example.invalid';
const tokens = { oauth1: { oauth_token: 'test-oauth1', oauth_token_secret: 'test-secret' },
    oauth2: { access_token: 'test-oauth2', expires_at: 1700000000 } };
const profile = { profileId: 123, displayName: 'display-name' };
const row = { activityId: 321, startTimeGMT: '2025-04-06 03:00:00', startTimeLocal: '2025-04-06 11:00:00',
    activityType: { typeKey: 'trail_running' }, duration: 1800, distance: 5000 };

function fixture(handler, pageSize) {
    const calls = [], waits = [];
    const f = { calls, waits, logins: 0, refreshes: 0 };
    const log = console.log;
    console.log = () => {};
    try { f.client = new GarminConnect({ username, password: 'must-not-be-used' }, 'garmin.cn'); }
    finally { console.log = log; }
    const client = f.client;
    client.login = async () => { f.logins++; throw new Error('Password login must never be called'); };
    f.adapter = new GarminCnReadOnlyAdapter(username, client, async delay => { waits.push(delay); }, pageSize);
    client.client.refreshOauth2Token = async () => {
        f.refreshes++;
        client.loadToken(tokens.oauth1, { ...tokens.oauth2, access_token: 'refreshed' });
    };
    client.client.client.defaults.adapter = async config => {
        calls.push(config);
        const response = await handler?.(config, f) ?? { status: 200, data: profile };
        const result = { config, statusText: 'Test response', headers: {}, ...response };
        if (result.status >= 400) throw Object.assign(new Error('private response body'), { isAxiosError: true, config, response: result });
        return result;
    };
    f.saved = { loginHash: garminLoginHash(username), token: tokens };
    return f;
}

test('Garmin CN normalization uses UTC, stable sport families and lossless IDs', () => {
    assert.deepEqual(normalizeGarmin(row), activity('garmin-cn', '321'));
    assert.equal(normalizeGarmin({ ...row, startTimeGMT: '2025-04-06T11:00:00+08:00' }).start, start);
    assert.equal(normalizeGarmin({ ...row, startTimeGMT: undefined, beginTimestamp: start }).start, start);
    assert.equal(normalizeGarmin({ ...row, activityType: { typeKey: 'indoor_cardio' } }).sport, 'cardio');
    assert.throws(() => normalizeGarmin({ ...row, startTimeGMT: undefined }), { code: 'PROTOCOL' });
    assert.throws(() => normalizeGarmin({ ...row, activityId: Number.MAX_SAFE_INTEGER + 1 }), { code: 'PROTOCOL' });
});

test('Garmin adapter requires an existing database session and never calls password login', async () => {
    const f = fixture();
    assert.equal(await f.adapter.connect(f.saved), hash('garmin-cn:123'));
    assert.equal(f.logins, 0);
    await assert.rejects(f.adapter.connect(), { code: 'GARMIN_SESSION_MISSING' });
    await assert.rejects(f.adapter.connect({ ...f.saved, loginHash: hash('another-user') }), { code: 'ACCOUNT_CHANGED' });
    assert.equal(f.logins, 0);
    const source = await fs.readFile(path.resolve(__dirname, '../../src/sync/garmin.ts'), 'utf8');
    assert.equal(source.includes('.login('), false);
    assert.equal(source.includes('GARMIN_PASSWORD'), false);
});

test('Garmin reads pages and refuses malformed history responses', async () => {
    let rows = [row];
    const f = fixture(() => ({ status: 200, data: rows }));
    assert.deepEqual(await f.adapter.page(0), { activities: [activity('garmin-cn', '321')], next: 1 });
    assert.equal(f.calls[0].params.start, 0);
    assert.equal(f.calls[0].params.limit, 100);
    rows = [];
    assert.deepEqual(await f.adapter.page(1), { activities: [], next: null });
    rows = null;
    await assert.rejects(f.adapter.page(0), { code: 'PROTOCOL' });
    assert.equal(f.logins, 0);

    const paged = fixture(() => ({ status: 200, data: [] }), 10);
    await paged.adapter.page(20);
    assert.equal(paged.calls[0].params.start, 20);
    assert.equal(paged.calls[0].params.limit, 10);
});

test('Garmin refreshes an existing OAuth session but never falls back to SSO login', async () => {
    const f = fixture((_config, f) => f.calls.length === 1 ? { status: 401 } : undefined);
    await f.adapter.connect(f.saved);
    assert.equal(f.refreshes, 1);
    assert.equal(f.logins, 0);
    assert.equal(f.client.exportToken().oauth2.access_token, 'refreshed');

    const rejected = fixture(() => ({ status: 401 }));
    rejected.client.client.refreshOauth2Token = async () => { rejected.refreshes++; throw { response: { status: 401 } }; };
    await assert.rejects(rejected.adapter.connect(rejected.saved));
    assert.equal(rejected.logins, 0);
});

test('Garmin retries bounded read failures without leaking response bodies', async () => {
    const f = fixture((_config, f) => f.calls.length === 1 ? { status: 429, headers: { 'retry-after': '3' } } : undefined);
    await f.adapter.connect(f.saved);
    assert.deepEqual(f.waits, [3000]);
    const long = fixture(() => ({ status: 429, headers: { 'retry-after': '300' } }));
    await assert.rejects(long.adapter.connect(long.saved), { code: 'RATE_LIMIT' });
    const network = fixture(() => { throw new Error('private-session-in-network-error'); });
    await assert.rejects(network.adapter.page(0), error => error.code === 'GARMIN_READ' && !safeError(error).includes('private-session'));
    assert.deepEqual(network.waits, [1000, 2000, 4000]);
});

test('Garmin original download stays private and requires one FIT file', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { makeFit } = await import('./fit-fixture.mjs');
    const zip = new JSZip(); zip.file('original.fit', makeFit());
    const data = await zip.generateAsync({ type: 'nodebuffer' });
    const f = fixture(() => ({ status: 200, data }));
    const filename = await f.adapter.download(activity('garmin-cn', '321'), directory);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test('Garmin classifies a permanent per-activity export failure separately', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-missing-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const f = fixture(() => ({ status: 404 }));
    await assert.rejects(f.adapter.download(activity('garmin-cn', '321'), directory),
        { code: 'GARMIN_EXPORT_UNAVAILABLE' });
    assert.equal(f.calls.length, 1);
});

test('Garmin adapter blocks every non-OAuth write', async () => {
    const f = fixture();
    await f.adapter.connect(f.saved);
    await assert.rejects(f.client.client.post('https://connectapi.garmin.cn/upload-service/upload/fit', {}), { code: 'GARMIN_READ_ONLY' });
    await assert.rejects(f.adapter.upload('/unused.fit', {}), { code: 'GARMIN_READ_ONLY' });
    assert.equal(f.calls.filter(call => call.method === 'post').length, 0);
});

async function databaseFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-db-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'db'));
    const filename = path.join(root, 'db', 'garmin.db');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec('CREATE TABLE garmin_session (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, region TEXT, session TEXT)');
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(tokens), 'test-aes-key').toString();
    await db.run('INSERT INTO garmin_session (user, region, session) VALUES (?, ?, ?)', username, 'CN', encrypted);
    await db.close();
    return { root, filename };
}

test('garmin.db loader is read-only, username-bound and decrypts only a valid CN token', async t => {
    const f = await databaseFixture(t);
    const before = createHash('sha256').update(await fs.readFile(f.filename)).digest('hex');
    const saved = await readGarminCnSession(f.root, username, 'test-aes-key');
    assert.deepEqual(saved, { loginHash: garminLoginHash(username), token: tokens });
    const after = createHash('sha256').update(await fs.readFile(f.filename)).digest('hex');
    assert.equal(after, before);
    await assert.rejects(readGarminCnSession(f.root, 'other@example.invalid', 'test-aes-key'), { code: 'GARMIN_SESSION_MISSING' });
    await assert.rejects(readGarminCnSession(f.root, username, 'wrong-key'), { code: 'GARMIN_DB_INVALID' });
});

test('garmin.db loader rejects missing databases', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-db-missing-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(readGarminCnSession(root, username), { code: 'GARMIN_DB_MISSING' });
});
