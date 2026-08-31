require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { garminAccountHash } = require('../src/core/account');
const { canonicalSession, checkGarminSessionDatabase, initializeGarminSessionDatabase,
    loadGarminSession, rekeyGarminSession, replaceGarminSession,
    saveGarminSession } = require('../src/state/session-db');

function credentials(region = 'CN', overrides = {}) {
    return region === 'CN'
        ? { region, slot: 'garmin-cn', username: 'cn@example.invalid', password: 'cn-password', ...overrides }
        : { region, slot: 'garmin-global', username: 'global@example.invalid', password: 'global-password', ...overrides };
}

function session(current, suffix = '') {
    return { loginHash: garminAccountHash(current.slot, current.username), token: {
        oauth1: { oauth_token_secret: `secret${suffix}`, oauth_token: `oauth1${suffix}` },
        oauth2: { refresh_token: `refresh${suffix}`, access_token: `oauth2${suffix}`, expires_at: 1700000000 },
    } };
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-session-db-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'garmin.db');
    const cn = credentials();
    const global = credentials('GLOBAL');
    const entries = [{ credentials: cn, saved: session(cn) },
        { credentials: global, saved: session(global) }];
    await initializeGarminSessionDatabase(filename, entries);
    return { directory, filename, cn, global };
}

async function digest(filename) {
    return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
}

test('Session database contains only encrypted per-region records and no cursor table', async t => {
    const f = await fixture(t);
    await checkGarminSessionDatabase(f.filename);
    const db = await open({ filename: f.filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const rows = await db.all('SELECT region, account_hash, version, length(salt) salt, length(iv) iv, length(tag) tag FROM garmin_session ORDER BY region');
    await db.close();
    assert.deepEqual(tables, [{ name: 'garmin_session' }]);
    assert.deepEqual(rows.map(row => [row.region, row.version, row.salt, row.iv, row.tag]),
        [['CN', 1, 16, 12, 16], ['GLOBAL', 1, 16, 12, 16]]);
    assert.equal(rows[0].account_hash, garminAccountHash('garmin-cn', 'cn@example.invalid'));
    const bytes = await fs.readFile(f.filename);
    for (const secret of ['cn@example.invalid', 'global@example.invalid', 'cn-password', 'global-password',
        'oauth1', 'oauth2', 'refresh']) assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('both regions decrypt only with their own account and password', async t => {
    const f = await fixture(t);
    const global = credentials('GLOBAL');
    assert.deepEqual(await loadGarminSession(f.filename, f.cn), session(f.cn));
    assert.deepEqual(await loadGarminSession(f.filename, global), session(global));
    await assert.rejects(loadGarminSession(f.filename, { ...f.cn, password: 'wrong' }), { code: 'SESSION_DB_DECRYPT' });
    await assert.rejects(loadGarminSession(f.filename, { ...f.cn, username: 'other@example.invalid' }),
        { code: 'SESSION_DB_DECRYPT' });
});

test('canonical Session comparison makes unchanged saves byte-for-byte silent', async t => {
    const f = await fixture(t);
    const before = await digest(f.filename);
    const reordered = { loginHash: session(f.cn).loginHash, token: {
        oauth1: { oauth_token: 'oauth1', oauth_token_secret: 'secret' },
        oauth2: { access_token: 'oauth2', expires_at: 1700000000, refresh_token: 'refresh' },
    } };
    assert.equal(canonicalSession(reordered), canonicalSession(session(f.cn)));
    assert.deepEqual(await saveGarminSession(f.filename, f.cn, reordered), { changed: false, created: false });
    assert.equal(await digest(f.filename), before);
});

test('a real Session refresh updates one row transactionally and remains readable', async t => {
    const f = await fixture(t);
    const db = await open({ filename: f.filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    const beforeGlobal = await db.get("SELECT hex(ciphertext) ciphertext FROM garmin_session WHERE region = 'GLOBAL'");
    await db.close();
    const before = await digest(f.filename);
    assert.deepEqual(await saveGarminSession(f.filename, f.cn, session(f.cn, '-new')),
        { changed: true, created: false });
    assert.notEqual(await digest(f.filename), before);
    assert.deepEqual(await loadGarminSession(f.filename, f.cn), session(f.cn, '-new'));
    const checked = await open({ filename: f.filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    const afterGlobal = await checked.get("SELECT hex(ciphertext) ciphertext FROM garmin_session WHERE region = 'GLOBAL'");
    await checked.close();
    assert.deepEqual(afterGlobal, beforeGlobal);
    await checkGarminSessionDatabase(f.filename);
});

test('password rotation re-encrypts without exposing or changing the Session', async t => {
    const f = await fixture(t);
    const beforeSession = await loadGarminSession(f.filename, f.cn);
    await rekeyGarminSession(f.filename, f.cn, 'new-password');
    await assert.rejects(loadGarminSession(f.filename, f.cn), { code: 'SESSION_DB_DECRYPT' });
    assert.deepEqual(await loadGarminSession(f.filename, { ...f.cn, password: 'new-password' }), beforeSession);
    const bytes = await fs.readFile(f.filename);
    assert.equal(bytes.includes(Buffer.from('new-password')), false);
});

test('a failed password rotation leaves the database unchanged', async t => {
    const f = await fixture(t);
    const before = await digest(f.filename);
    await assert.rejects(rekeyGarminSession(f.filename, { ...f.cn, password: 'wrong' }, 'new-password'),
        { code: 'SESSION_DB_DECRYPT' });
    assert.equal(await digest(f.filename), before);
});

test('local reset can replace an undecryptable row only after obtaining a valid Session', async t => {
    const f = await fixture(t);
    const replacementCredentials = { ...f.cn, password: 'reset-password' };
    const replacement = session(replacementCredentials, '-reset');
    await replaceGarminSession(f.filename, replacementCredentials, replacement);
    await assert.rejects(loadGarminSession(f.filename, f.cn), { code: 'SESSION_DB_DECRYPT' });
    assert.deepEqual(await loadGarminSession(f.filename, replacementCredentials), replacement);
});

test('tampering, invalid schemas and malformed Sessions fail closed', async t => {
    const f = await fixture(t);
    const db = await open({ filename: f.filename, driver: sqlite3.Database });
    await db.run("UPDATE garmin_session SET ciphertext = x'00' WHERE region = 'CN'");
    await db.close();
    await assert.rejects(loadGarminSession(f.filename, f.cn), { code: 'SESSION_DB_DECRYPT' });

    const incomplete = await open({ filename: f.filename, driver: sqlite3.Database });
    await incomplete.run("DELETE FROM garmin_session WHERE region = 'GLOBAL'");
    await incomplete.close();
    await assert.rejects(checkGarminSessionDatabase(f.filename), { code: 'SESSION_DB_SCHEMA' });

    const invalid = path.join(f.directory, 'invalid.db');
    const other = await open({ filename: invalid, driver: sqlite3.Database });
    await other.exec('CREATE TABLE old_state (value TEXT)');
    await other.close();
    await assert.rejects(checkGarminSessionDatabase(invalid), { code: 'SESSION_DB_SCHEMA' });
    assert.throws(() => canonicalSession({ loginHash: 'bad', token: {} }), { code: 'SESSION_INVALID' });
});
