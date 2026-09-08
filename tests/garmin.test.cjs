require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { GarminConnect } = require('@gooin/garmin-connect');
const { garminAccountHash } = require('../src/core/account');
const { safeError, SyncError } = require('../src/core/errors');
const { GarminAdapter, normalizeGarmin } = require('../src/platforms/garmin');
const { activity, hash, start } = require('./helpers.cjs');

const username = 'test@example.invalid';
const password = 'test-password';
const tokens = { oauth1: { oauth_token: 'test-oauth1', oauth_token_secret: 'test-secret' },
    oauth2: { access_token: 'test-oauth2', expires_at: Math.floor(Date.now() / 1000) + 3600 } };
const profile = { profileId: 123, displayName: 'display-name' };
const row = { activityId: 321, startTimeGMT: '2025-04-06 03:00:00', startTimeLocal: '2025-04-06 11:00:00',
    activityType: { typeKey: 'trail_running' }, duration: 1800, distance: 5000 };

function fixture(options = {}) {
    const region = options.region ?? 'CN';
    const domain = region === 'CN' ? 'garmin.cn' : 'garmin.com';
    const slot = region === 'CN' ? 'garmin-cn' : 'garmin-global';
    const calls = [], waits = [];
    const f = { calls, waits, logins: 0, refreshes: 0 };
    const log = console.log;
    console.log = () => {};
    try { f.client = new GarminConnect({ username, password }, domain); }
    finally { console.log = log; }
    const client = f.client;
    client.login = async () => {
        f.logins++;
        if (!options.allowLogin) throw Object.assign(new Error('login rejected'), { response: { status: 401 } });
        client.loadToken(tokens.oauth1, tokens.oauth2);
    };
    f.adapter = new GarminAdapter({ region, username, password, client,
        wait: async delay => { waits.push(delay); }, pageSize: options.pageSize, writable: options.writable,
        onSession: options.onSession });
    client.client.refreshOauth2Token = async () => {
        f.refreshes++;
        client.loadToken(tokens.oauth1, { ...tokens.oauth2, access_token: 'refreshed' });
    };
    client.client.client.defaults.adapter = async config => {
        calls.push(config);
        const response = await options.handler?.(config, f) ?? { status: 200, data: profile };
        const result = { config, statusText: 'Test response', headers: {}, ...response };
        if (result.status >= 400) throw Object.assign(new Error('private response body'),
            { isAxiosError: true, config, response: result });
        return result;
    };
    f.saved = { loginHash: garminAccountHash(slot, username), token: tokens };
    return f;
}

test('Garmin normalization uses UTC, stable sport families and lossless IDs for either region', () => {
    assert.deepEqual(normalizeGarmin(row), activity('garmin-cn', '321'));
    assert.deepEqual(normalizeGarmin(row, 'garmin-global'), activity('garmin-global', '321'));
    assert.equal(normalizeGarmin({ ...row, startTimeGMT: '2025-04-06T11:00:00+08:00' }).start, start);
    assert.equal(normalizeGarmin({ ...row, startTimeGMT: undefined, beginTimestamp: start }).start, start);
    assert.equal(normalizeGarmin({ ...row, activityType: { typeKey: 'indoor_cardio' } }).sport, 'cardio');
    for (const [typeKey, sport] of [
        ['indoor_rowing', 'rowing'],
        ['virtual_ride', 'cycling'],
        ['e_bike_fitness', 'cycling'],
        ['strength_training', 'strength'],
        ['yoga', 'yoga'],
        ['stand_up_paddleboarding', 'paddling'],
        ['water_sports', 'water-sport'],
    ]) {
        assert.equal(normalizeGarmin({ ...row, activityType: { typeKey } }).sport, sport);
    }
    assert.throws(() => normalizeGarmin({ ...row, startTimeGMT: undefined }), { code: 'PROTOCOL' });
    assert.throws(() => normalizeGarmin({ ...row, activityId: Number.MAX_SAFE_INTEGER + 1 }), { code: 'PROTOCOL' });
});

test('Garmin uses a saved Session first and exports it only after a verified connection', async () => {
    const f = fixture();
    f.client.client.fetchOauthConsumer = async () => { throw new Error('Unexpected consumer metadata request'); };
    assert.equal(f.adapter.exportSession(), undefined);
    assert.equal(await f.adapter.connect(f.saved), hash('garmin-cn:123'));
    assert.equal(f.logins, 0);
    assert.deepEqual(f.adapter.exportSession(), f.saved);
    await assert.rejects(fixture().adapter.connect({ ...f.saved, loginHash: hash('another-user') }),
        { code: 'ACCOUNT_CHANGED' });
});

test('Garmin performs one password login when no Session exists', async () => {
    const f = fixture({ allowLogin: true });
    assert.equal(await f.adapter.connect(), hash('garmin-cn:123'));
    assert.equal(f.logins, 1);
    assert.deepEqual(f.adapter.exportSession(), f.saved);

    const rejected = fixture();
    await assert.rejects(rejected.adapter.connect(), { code: 'AUTH' });
    assert.equal(rejected.logins, 1);
    assert.equal(rejected.adapter.exportSession(), undefined);
});

test('OAuth1 alone or an expired OAuth2 uses the signed exchange, not password login, in both regions', async () => {
    for (const region of ['CN', 'GLOBAL']) {
        for (const oauth2 of [undefined, { ...tokens.oauth2, expires_at: 1 }]) {
            const persisted = [];
            const f = fixture({ region, onSession: async saved => persisted.push(saved), handler: config =>
                config.url.includes('/oauth-service/oauth/exchange/user/2.0')
                    ? { status: 200, data: { access_token: 'exchanged', expires_in: 3600,
                        refresh_token: 'new-refresh', refresh_token_expires_in: 86400 } } : undefined });
            f.client.client.fetchOauthConsumer = async () => {
                f.client.client.OAUTH_CONSUMER = { key: 'consumer-key', secret: 'consumer-secret' };
            };
            await f.adapter.connect({ ...f.saved, token: { oauth1: tokens.oauth1, oauth2 } });
            assert.equal(f.logins, 0);
            assert.equal(f.refreshes, 0);
            const exchanges = f.calls.filter(call => call.url.includes('/oauth-service/oauth/exchange/user/2.0'));
            assert.equal(exchanges.length, 1);
            assert.equal(exchanges[0].method, 'post');
            assert.equal(new URL(exchanges[0].url).hostname, region === 'CN' ? 'connectapi.garmin.cn' : 'connectapi.garmin.com');
            assert.equal(persisted.length, 1);
            assert.equal(persisted[0].token.oauth2.access_token, 'exchanged');
            assert.deepEqual(persisted[0].token.oauth1, tokens.oauth1);
        }
    }
});

test('rejected OAuth1 falls back once and persists the verified replacement before returning', async () => {
    for (const region of ['CN', 'GLOBAL']) {
        for (const status of [401, 403]) {
            for (const oauth2 of [undefined, { ...tokens.oauth2, expires_at: 1 }]) {
                const saved = [];
                const f = fixture({ region, allowLogin: true, onSession: async session => saved.push(session), handler: config =>
                    config.url.includes('/oauth-service/oauth/exchange/user/2.0') ? { status } : undefined });
                f.client.client.fetchOauthConsumer = async () => {
                    f.client.client.OAUTH_CONSUMER = { key: 'consumer-key', secret: 'consumer-secret' };
                };
                f.client.login = async () => {
                    f.logins++;
                    f.client.loadToken({ ...tokens.oauth1, oauth_token: 'replacement' }, tokens.oauth2);
                };
                await f.adapter.connect({ ...f.saved, token: { oauth1: tokens.oauth1, oauth2 } });
                assert.equal(f.logins, 1);
                assert.equal(f.refreshes, 0);
                assert.equal(f.calls.filter(call => call.url.includes('/oauth-service/oauth/exchange/user/2.0')).length, 1);
                assert.equal(saved.length, 1);
                assert.equal(saved[0].token.oauth1.oauth_token, 'replacement');
            }
        }
    }
});

test('consumer metadata authorization failures never trigger password login or persist a Session', async () => {
    for (const region of ['CN', 'GLOBAL']) {
        for (const status of [401, 403]) {
            for (const oauth2 of [undefined, { ...tokens.oauth2, expires_at: 1 }]) {
                const saved = [];
                let consumerFetches = 0;
                const f = fixture({ region, allowLogin: true, onSession: async session => saved.push(session) });
                f.client.client.fetchOauthConsumer = async () => {
                    consumerFetches++;
                    throw Object.assign(new Error('private-token'), { response: { status } });
                };
                await assert.rejects(f.adapter.connect({ ...f.saved, token: { oauth1: tokens.oauth1, oauth2 } }),
                    error => error.code === 'GARMIN_READ' && safeError(error).includes(`HTTP ${status}`) &&
                        !safeError(error).includes('private-token'));
                assert.equal(consumerFetches, 1);
                assert.equal(f.logins, 0);
                assert.equal(f.refreshes, 0);
                assert.deepEqual(f.calls, []);
                assert.deepEqual(f.waits, []);
                assert.deepEqual(saved, []);
                assert.equal(f.adapter.exportSession(), undefined);
            }
        }
    }
});

test('consumer metadata transient failures exhaust bounded retries without password login', async () => {
    for (const status of [429, 503]) {
        let consumerFetches = 0;
        const f = fixture({ allowLogin: true });
        f.client.client.fetchOauthConsumer = async () => {
            consumerFetches++;
            throw Object.assign(new Error('private-token'), { response: { status } });
        };
        await assert.rejects(f.adapter.connect({ ...f.saved, token: { oauth1: tokens.oauth1 } }),
            error => error.code === 'GARMIN_READ' && !safeError(error).includes('private-token'));
        assert.equal(consumerFetches, 4);
        assert.equal(f.logins, 0);
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.waits, [1000, 2000, 4000]);
        assert.equal(f.adapter.exportSession(), undefined);
    }
});

test('OAuth1 exchange throttling retries only the exchange without password login', async () => {
    let consumerFetches = 0;
    const f = fixture({ allowLogin: true, handler: () => ({ status: 429 }) });
    f.client.client.fetchOauthConsumer = async () => {
        consumerFetches++;
        f.client.client.OAUTH_CONSUMER = { key: 'consumer-key', secret: 'consumer-secret' };
    };
    await assert.rejects(f.adapter.connect({ ...f.saved, token: { oauth1: tokens.oauth1 } }),
        error => error.code === 'GARMIN_READ' && !safeError(error).includes('private response body'));
    assert.equal(consumerFetches, 1);
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(call => call.url.includes('/oauth-service/oauth/exchange/user/2.0')));
    assert.equal(f.logins, 0);
    assert.deepEqual(f.waits, [1000, 2000, 4000]);
    assert.equal(f.adapter.exportSession(), undefined);
});

test('unverified Sessions are never persisted, and persistence failure aborts connect', async () => {
    const calls = [];
    const rejected = fixture({ onSession: async session => calls.push(session) });
    await assert.rejects(rejected.adapter.connect(), { code: 'AUTH' });
    assert.equal(calls.length, 0);
    const failedSave = fixture({ onSession: async () => { throw new SyncError('GITHUB_SECRETS', 'Save failed.'); } });
    await assert.rejects(failedSave.adapter.connect(failedSave.saved), { code: 'GITHUB_SECRETS' });
    assert.ok(failedSave.adapter.exportSession());
});

test('Garmin reads complete pages and applies bounded UTC date filters', async () => {
    let rows = [row];
    const f = fixture({ handler: () => ({ status: 200, data: rows }) });
    assert.deepEqual(await f.adapter.page(0), { activities: [activity('garmin-cn', '321')], next: 1 });
    assert.equal(f.calls[0].params.start, 0);
    assert.equal(f.calls[0].params.limit, 100);
    rows = [];
    assert.deepEqual(await f.adapter.page(1), { activities: [], next: null });
    rows = null;
    await assert.rejects(f.adapter.page(0), { code: 'PROTOCOL' });

    const paged = fixture({ pageSize: 10, handler: () => ({ status: 200, data: [] }) });
    await paged.adapter.page(20);
    assert.equal(paged.calls[0].params.start, 20);
    assert.equal(paged.calls[0].params.limit, 10);
    await paged.adapter.page(0, { start: start - 60000, end: start + 60000 });
    assert.equal(paged.calls[1].params.startDate, '2025-04-05');
    assert.equal(paged.calls[1].params.endDate, '2025-04-07');
});

test('Garmin Global uses the Global API host and slot', async () => {
    const f = fixture({ region: 'GLOBAL', handler: (_config, current) => current.calls.length === 1
        ? undefined : { status: 200, data: [] } });
    await f.adapter.connect(f.saved);
    await f.adapter.page(0);
    assert.equal(f.adapter.slot, 'garmin-global');
    assert.equal(new URL(f.calls.at(-1).url).hostname, 'connectapi.garmin.com');
});

test('Garmin refreshes OAuth and bounds retry delays without leaking response bodies', async () => {
    const refreshed = fixture({ handler: (_config, f) => f.calls.length === 1 ? { status: 401 } : undefined });
    await refreshed.adapter.connect(refreshed.saved);
    assert.equal(refreshed.refreshes, 1);
    assert.equal(refreshed.logins, 0);
    assert.equal(refreshed.adapter.exportSession().token.oauth2.access_token, 'refreshed');

    const limited = fixture({ handler: (_config, f) => f.calls.length === 1
        ? { status: 429, headers: { 'retry-after': '3' } } : undefined });
    await limited.adapter.connect(limited.saved);
    assert.deepEqual(limited.waits, [3000]);
    const long = fixture({ handler: () => ({ status: 429, headers: { 'retry-after': '300' } }) });
    await assert.rejects(long.adapter.connect(long.saved), { code: 'RATE_LIMIT' });
    const network = fixture({ handler: () => { throw new Error('private-session-in-network-error'); } });
    await assert.rejects(network.adapter.page(0),
        error => error.code === 'GARMIN_READ' && !safeError(error).includes('private-session'));
    assert.deepEqual(network.waits, [1000, 2000, 4000]);
});

test('Garmin preserves FIT and TCX originals and classifies unavailable exports', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { makeFit } = await import('./fit-fixture.mjs');
    const zip = new JSZip(); zip.file('original.fit', makeFit());
    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    const fit = fixture({ handler: () => ({ status: 200, data: archive }) });
    const filename = await fit.adapter.download(activity('garmin-cn', '321'), directory);
    assert.equal(path.extname(filename), '.fit');
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);

    const missingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-missing-'));
    t.after(() => fs.rm(missingDirectory, { recursive: true, force: true }));
    const missing = fixture({ handler: () => ({ status: 404 }) });
    await assert.rejects(missing.adapter.download(activity('garmin-cn', '321'), missingDirectory),
        { code: 'GARMIN_EXPORT_UNAVAILABLE' });
});

test('read-only Garmin blocks writes while upload adapters accept only FIT and TCX endpoints', async t => {
    const readOnly = fixture();
    await readOnly.adapter.connect(readOnly.saved);
    await assert.rejects(readOnly.client.client.post('https://connectapi.garmin.cn/upload-service/upload/.fit', {}),
        { code: 'GARMIN_WRITE_BLOCKED' });
    await assert.rejects(readOnly.adapter.upload('/unused.fit', {}), { code: 'GARMIN_WRITE_BLOCKED' });

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-upload-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const format of ['fit', 'tcx']) {
        const file = path.join(directory, `source.${format}`);
        await fs.writeFile(file, Buffer.alloc(32), { mode: 0o600 });
        const writable = fixture({ writable: true, handler: config => config.url.includes(`/upload-service/upload/.${format}`)
            ? { status: 200, data: { imported: true } } : undefined });
        await writable.adapter.connect(writable.saved);
        const transfer = { sourceId: 'source', filename: `dailysync_${format === 'fit' ? 'a' : 'b'.repeat(32)}.${format}`,
            evidence: { sha256: hash(format), start, sport: 'running', duration: 1800, distance: 5000 } };
        if (format === 'fit') transfer.filename = `dailysync_${'a'.repeat(32)}.fit`;
        const receipt = await writable.adapter.upload(file, transfer);
        assert.deepEqual(receipt, { status: 'accepted', stage: 'finished' });
        assert.deepEqual(await writable.adapter.verify({ ...transfer, receipt }),
            { status: 'accepted', stage: 'finished' });
        assert.equal(writable.calls.filter(call => call.url.includes(`/upload-service/upload/.${format}`)).length, 1);
        await assert.rejects(fs.access(path.join(directory, transfer.filename)));
        await assert.rejects(writable.client.client.post('https://example.invalid/upload-service/upload/.fit', {}),
            { code: 'GARMIN_WRITE_BLOCKED' });
    }
});

test('Garmin duplicate, transient and unknown upload outcomes stay distinguishable', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-garmin-outcome-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'source.fit');
    await fs.writeFile(file, Buffer.alloc(32), { mode: 0o600 });
    const transfer = { sourceId: 'source', filename: `dailysync_${'c'.repeat(32)}.fit`,
        evidence: { sha256: hash('fit'), start, sport: 'running', duration: 1800, distance: 5000 } };

    const duplicate = fixture({ writable: true, handler: config => config.url.includes('/upload-service/upload/.fit')
        ? { status: 409, data: 'private response' } : undefined });
    await duplicate.adapter.connect(duplicate.saved);
    assert.deepEqual(await duplicate.adapter.upload(file, transfer), { status: 'duplicate', stage: 'finished' });

    for (const status of [408, 425, 429]) {
        const transient = fixture({ writable: true, handler: config => config.url.includes('/upload-service/upload/.fit')
            ? { status, data: 'private response' } : undefined });
        await transient.adapter.connect(transient.saved);
        assert.deepEqual(await transient.adapter.upload(file, transfer), {
            status: 'retryable', code: status === 429 ? 'RATE_LIMIT' : 'GARMIN_UPLOAD_RETRY',
        });
    }

    const unknown = fixture({ writable: true, handler: config => {
        if (config.url.includes('/upload-service/upload/.fit')) throw new Error('private network failure');
    } });
    await unknown.adapter.connect(unknown.saved);
    const receipt = await unknown.adapter.upload(file, transfer);
    assert.deepEqual(receipt, { status: 'unknown', code: 'GARMIN_UPLOAD_UNKNOWN' });
    assert.deepEqual(await unknown.adapter.verify({ ...transfer, receipt }),
        { status: 'pending', code: 'GARMIN_UPLOAD_UNKNOWN' });
});
