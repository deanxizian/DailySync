require('ts-node/register/transpile-only');
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const childProcess = require('node:child_process');
const { garminAccountHash } = require('../src/core/account');
const { safeError } = require('../src/core/errors');
const { canonical, readEncrypted, writeEncrypted } = require('../src/state/encrypted-file');
const { GarminSessionStore, sessionSettings } = require('../src/state/garmin-session');
const { GitHubSecrets } = require('../src/state/github-secrets');

const settings = sessionSettings('garmin-cn', { GARMIN_USERNAME: 'test@example.invalid', GARMIN_PASSWORD: 'private-password' });
const session = {
    loginHash: garminAccountHash(settings.slot, settings.username),
    token: { oauth1: { oauth_token: 'long-lived', oauth_token_secret: 'long-lived-secret' },
        oauth2: { access_token: 'short-lived', expires_at: Math.floor(Date.now() / 1000) + 7200 } },
};
function secret(saved = session) {
    return JSON.stringify({ version: 1, loginHash: saved.loginHash, oauth1: saved.token.oauth1 });
}
function context(kind, config = settings) {
    return `DailySync\0${kind}\0v1\0${config.slot}\0${garminAccountHash(config.slot, config.username)}`;
}
async function directory(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-session-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
function actions(root, overrides = {}, options = {}) {
    return new GarminSessionStore(root, { ...settings, secret: secret(), ...overrides }, { actions: true, ...options });
}

test('canonical Session comparison ignores property order and undefined properties', () => {
    assert.equal(canonical({ b: 2, a: { c: 1 }, absent: undefined }), canonical({ a: { c: 1 }, b: 2 }));
    assert.throws(() => canonical({ token: NaN }));
});

test('encrypted files are authenticated, private, atomic and byte-stable when unchanged', async t => {
    const root = await directory(t), file = path.join(root, 'private', 'value.json');
    assert.equal(await writeEncrypted(file, 'password', 'context', { b: 2, a: 1 }), true);
    const bytes = await fs.readFile(file);
    assert.equal(await writeEncrypted(file, 'password', 'context', { a: 1, b: 2 }), false);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(await readEncrypted(file, 'password', 'context'), { a: 1, b: 2 });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    await assert.rejects(readEncrypted(file, 'wrong', 'context'));
    await assert.rejects(readEncrypted(file, 'password', 'other-context'));
    const envelope = JSON.parse(bytes); envelope.tag = '00'.repeat(16);
    await fs.writeFile(file, JSON.stringify(envelope));
    await assert.rejects(readEncrypted(file, 'password', 'context'));
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['value.json']);
});

test('OAuth1 is required in Actions; missing and malformed Secrets never trigger a password bootstrap', async t => {
    const root = await directory(t);
    await assert.rejects(actions(root, { secret: undefined }).load(), { code: 'CONFIG' });
    await assert.rejects(actions(root, { secret: 'not-json' }).load(), { code: 'OAUTH1_INVALID' });
    await assert.rejects(actions(root, { secret: '{"access_token":"secret"}' }).load(), { code: 'OAUTH1_INVALID' });
    await assert.rejects(actions(root, { username: 'other@example.invalid' }).load(), { code: 'OAUTH1_INVALID' });
    assert.equal(await new GarminSessionStore(root, settings).load(), undefined);
});

test('cache miss loads only OAuth1 and unchanged OAuth1 never writes Secrets', async t => {
    const root = await directory(t), calls = [];
    const store = actions(root, {}, { secrets: { set: async (...args) => calls.push(args) } });
    const loaded = await store.load();
    assert.deepEqual(loaded.token.oauth1, session.token.oauth1);
    assert.equal(loaded.token.oauth2, undefined);
    await store.save(session);
    assert.equal(calls.length, 0);
    const cache = await readEncrypted(store.cacheFile, settings.password, context('oauth2'));
    assert.deepEqual(Object.keys(cache).sort(), ['oauth2', 'scope']);
    assert.ok(!JSON.stringify(cache).includes('long-lived'));
    const contents = await fs.readFile(store.cacheFile, 'utf8');
    for (const value of ['short-lived', 'long-lived', settings.password, settings.username]) assert.ok(!contents.includes(value));
    await assert.rejects(fs.access(path.join(root, '.local', 'oauth1')));
    assert.deepEqual((await actions(root).load()).token, session.token);
    const snapshot = await store.cacheSnapshot();
    await store.save(JSON.parse(JSON.stringify(session)));
    assert.deepEqual(await store.cacheSnapshot(), snapshot);
});

test('expired and corrupt OAuth2 caches recover from OAuth1 without changing the long-lived Secret', async t => {
    const root = await directory(t), warnings = [], store = actions(root, {}, { warn: text => warnings.push(text) });
    await store.load();
    await store.save({ ...session, token: { ...session.token, oauth2: { ...session.token.oauth2, expires_at: 1 } } });
    assert.equal((await store.load()).token.oauth2, undefined);
    assert.equal(await store.cacheSnapshot(), undefined);
    await fs.writeFile(store.cacheFile, 'private-token-corrupt-data');
    assert.equal((await store.load()).token.oauth2, undefined);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('private-token'));
    await store.save(session);
    assert.deepEqual((await store.load()).token.oauth2, session.token.oauth2);
});

test('OAuth2 caches cannot cross account, region or OAuth1 generations', async t => {
    const root = await directory(t), first = actions(root);
    await first.load(); await first.save(session);
    const next = { ...session, token: { ...session.token, oauth1: { ...session.token.oauth1, oauth_token: 'next' } } };
    const rotated = actions(root, { secret: secret(next) });
    assert.equal((await rotated.load()).token.oauth2, undefined);
    assert.notEqual(rotated.cachePrefix(), first.cachePrefix());
    const otherSettings = sessionSettings('garmin-global', {
        GARMIN_GLOBAL_USERNAME: settings.username, GARMIN_GLOBAL_PASSWORD: settings.password });
    const otherSession = { ...session, loginHash: garminAccountHash(otherSettings.slot, otherSettings.username) };
    const other = new GarminSessionStore(root, { ...otherSettings, secret: secret(otherSession) }, { actions: true, warn: () => {} });
    await fs.copyFile(first.cacheFile, other.cacheFile);
    assert.equal((await other.load()).token.oauth2, undefined);
    const changedPassword = actions(root, { password: 'new-password' }, { warn: () => {} });
    assert.equal((await changedPassword.load()).token.oauth2, undefined);
    await changedPassword.save(session);
    assert.deepEqual((await changedPassword.load()).token.oauth2, session.token.oauth2);
});

test('only a changed OAuth1 writes its Secret, and subsequent saves are silent', async t => {
    const root = await directory(t), calls = [];
    const store = actions(root, {}, { secrets: { set: async (...args) => calls.push(args) } });
    await store.load(); await store.save(session);
    const oldPrefix = store.cachePrefix();
    const next = { ...session, token: { ...session.token, oauth1: { ...session.token.oauth1, oauth_token: 'rotated' } } };
    await store.save(next);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'GARMIN_OAUTH1');
    assert.deepEqual(JSON.parse(calls[0][1]), JSON.parse(secret(next)));
    assert.ok(!calls[0][1].includes('short-lived'));
    assert.notEqual(store.cachePrefix(), oldPrefix);
    const snapshot = await store.cacheSnapshot();
    assert.ok(snapshot.key.startsWith(store.cachePrefix()));
    await store.save(next);
    assert.equal(calls.length, 1);
    assert.deepEqual((await actions(root, { secret: calls[0][1] }).load()).token, next.token);
});

test('SDK token mutation cannot change the stored OAuth1 comparison baseline', async t => {
    const root = await directory(t), calls = [];
    const store = actions(root, {}, { secrets: { set: async (...args) => calls.push(args) } });
    const saved = await store.load();
    saved.token.oauth1.oauth_token = 'mutated-by-sdk';
    saved.token.oauth2 = session.token.oauth2;
    await store.save(saved);
    assert.equal(calls.length, 1);
    saved.token.oauth1.oauth_token = 'mutated-again';
    await store.save(saved);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1][1]).oauth1.oauth_token, 'mutated-again');
});

test('failed OAuth1 persistence does not advance cache generation or erase the saved Session', async t => {
    const root = await directory(t), store = actions(root, {}, { secrets: { set: async () => { throw new Error('write failed'); } } });
    await store.load(); await store.save(session);
    const before = await fs.readFile(store.cacheFile);
    const next = { ...session, token: { ...session.token, oauth1: { ...session.token.oauth1, oauth_token: 'rotated' } } };
    await assert.rejects(store.save(next), /write failed/);
    assert.deepEqual(await fs.readFile(store.cacheFile), before);
    await assert.rejects(actions(root).save(next), { code: 'CONFIG' });
    assert.deepEqual((await actions(root).load()).token, session.token);
});

test('cache save failure only warns after successful durable OAuth1 persistence', async t => {
    const root = await directory(t), warnings = [], calls = [];
    await fs.mkdir(path.join(root, '.local'), { recursive: true });
    await fs.writeFile(path.join(root, '.local', 'oauth2'), 'not a directory');
    const store = actions(root, {}, { secrets: { set: async (...args) => calls.push(args) }, warn: text => warnings.push(text) });
    await store.save(session);
    assert.equal(calls.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(await store.cacheSnapshot(), undefined);
});

test('local OAuth1 is encrypted outside the cache and a wrong password never silently overwrites it', async t => {
    const root = await directory(t), store = new GarminSessionStore(root, settings);
    await store.save(session);
    assert.deepEqual((await new GarminSessionStore(root, settings).load()).token, session.token);
    const localFile = path.join(root, '.local', 'oauth1', `${settings.slot}.json`);
    const before = await fs.readFile(localFile);
    assert.ok(!before.toString().includes('long-lived'));
    await assert.rejects(new GarminSessionStore(root, { ...settings, password: 'wrong' }).load(), { code: 'OAUTH1_INVALID' });
    assert.deepEqual(await fs.readFile(localFile), before);
});

test('local OAuth1 rotation takes precedence over an old environment bootstrap', async t => {
    const root = await directory(t), config = { ...settings, secret: secret() };
    const store = new GarminSessionStore(root, config);
    await store.load(); await store.save(session);
    assert.deepEqual((await new GarminSessionStore(root, settings).load()).token, session.token);
    const next = { ...session, token: { ...session.token, oauth1: { ...session.token.oauth1, oauth_token: 'rotated-local' } } };
    await store.save(next);
    assert.deepEqual((await new GarminSessionStore(root, config).load()).token, next.token);
});

test('GitHub Secret writes use stdin, restricted names and sanitized subprocess errors', async t => {
    const calls = [];
    let code = 0;
    t.after(() => mock.restoreAll());
    mock.method(childProcess, 'spawn', (executable, args, options) => {
        const child = new EventEmitter(), call = { executable, args, options, input: '' };
        calls.push(call);
        child.stdin = new Writable({ write(chunk, _encoding, done) { call.input += chunk; done(); } });
        process.nextTick(() => child.emit('close', code));
        return child;
    });
    const client = new GitHubSecrets('owner/repo', 'test-pat');
    await client.check();
    await client.set('GARMIN_OAUTH1', 'private-oauth1');
    assert.deepEqual(calls[1].args, ['secret', 'set', 'GARMIN_OAUTH1', '--repo', 'owner/repo']);
    assert.equal(calls[1].input, 'private-oauth1');
    assert.equal(calls[1].options.env.GH_TOKEN, 'test-pat');
    assert.deepEqual(calls[1].options.stdio, ['pipe', 'ignore', 'ignore']);
    assert.equal(calls[1].options.timeout, 60000);
    assert.throws(() => client.set('GARMIN_PASSWORD', 'value'), { code: 'CONFIG' });
    assert.throws(() => new GitHubSecrets('../repo'), { code: 'CONFIG' });
    code = 1;
    await assert.rejects(client.set('GARMIN_GLOBAL_OAUTH1', 'private-oauth1'), error =>
        error.code === 'GITHUB_SECRETS' && !safeError(error).includes('private-oauth1') && !safeError(error).includes('test-pat'));
});
