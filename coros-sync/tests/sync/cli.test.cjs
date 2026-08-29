require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const CryptoJS = require('crypto-js');
const { parseOptions, parseActivityReference, loadPrivateEnv, requireBridgeAccounts } = require('../../src/sync/config');
const { SyncWorkspace } = require('../../src/sync/workspace');
const { STATE_TABLE } = require('../../src/sync/state');
const { main } = require('../../src/bridge');
const { emptyState } = require('../../src/sync/types');
const { createUploadIntent, writeUploadIntent, UPLOAD_INTENT_PATH } = require('../../src/sync/upload-intent');
const { activity, evidence, hash } = require('./helpers.cjs');

const settings = ['COROS_USERNAME', 'COROS_PASSWORD', 'GARMIN_USERNAME', 'GARMIN_PASSWORD', 'AESKEY',
    'GARMIN_SYNC_NUM', 'GARMIN_MIGRATE_NUM', 'GARMIN_MIGRATE_START', 'GARMIN_MIGRATE_AUTO_PAGE',
    'GITHUB_ACTIONS', 'GITHUB_REF_NAME', 'GARMIN_DB_LOCK_COMMIT', 'GARMIN_DB_LOCK_REF'];

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-cli-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const saved = Object.fromEntries(settings.map(key => [key, process.env[key]]));
    for (const key of settings) delete process.env[key];
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    return { root };
}

async function createGarminDb(root, username, aesKey) {
    await fs.mkdir(path.join(root, 'db'));
    const db = await open({ filename: path.join(root, 'db', 'garmin.db'), driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE garmin_session (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, region TEXT, session TEXT);
        CREATE TABLE garmin_sync_cursor (direction TEXT PRIMARY KEY, last_sync_start_time TEXT, updated_at TEXT);
    `);
    const token = { oauth1: { oauth_token: 'one', oauth_token_secret: 'two' }, oauth2: { access_token: 'three' } };
    await db.run('INSERT INTO garmin_session (user, region, session) VALUES (?, ?, ?)', username, 'CN',
        CryptoJS.AES.encrypt(JSON.stringify(token), aesKey).toString());
    await db.close();
}

test('CLI defaults to preview and rejects contradictory or removed state-branch options', () => {
    assert.equal(parseOptions([]).apply, false);
    assert.equal(parseOptions(['--apply', '--activity-id', '123']).apply, true);
    assert.equal(parseOptions(['--migrate-start', '101']).migrateStart, 101);
    for (const args of [['--route', 'garmin-to-coros'], ['--max-uploads', '1'],
        ['--migrate-start', '-1'], ['--migrate-start', '1.2'], ['--time-budget', '1'], ['init'], ['unlock', '--owner', 'id'],
        ['retry', '--source', 'garmin-cn:123', '--target', 'coros-cn'], ['--apply', '--apply'],
        ['--apply=false'], ['state', '--apply'], ['state', '--migrate-start', '1'], ['--source', 'garmin-cn:123'], ['--unknown']]) {
        assert.throws(() => parseOptions(args), { code: 'USAGE' }, JSON.stringify(args));
    }
    assert.deepEqual(parseActivityReference('coros-cn:9223372036854775800'), { slot: 'coros-cn', id: '9223372036854775800' });
    assert.throws(() => parseActivityReference('123'), { code: 'USAGE' });
    assert.throws(() => parseActivityReference('garmin-cn:../../file'), { code: 'PROTOCOL' });
});

test('migration and sync entry profiles reject each other\'s options', async () => {
    await assert.rejects(main('migration', ['state']), { code: 'USAGE' });
    await assert.rejects(main('migration', ['--activity-id', '123']), { code: 'USAGE' });
    await assert.rejects(main('sync', ['--migrate-start', '1']), { code: 'USAGE' });
});

test('private env file is permission-checked and never requires a Garmin password', async t => {
    const { root } = await fixture(t);
    await fs.mkdir(path.join(root, 'coros-sync'));
    await fs.writeFile(path.join(root, '.env'), 'COROS_USERNAME=legacy\nGARMIN_PASSWORD=must-not-load\n');
    await fs.writeFile(path.join(root, 'coros-sync', '.env.local'),
        'COROS_USERNAME="personal@example.invalid"\nCOROS_PASSWORD="password#not-comment"\nGARMIN_USERNAME=garmin@example.invalid\n', { mode: 0o600 });
    const env = { COROS_USERNAME: 'secret-wins' };
    loadPrivateEnv(root, env);
    assert.deepEqual(env, { COROS_USERNAME: 'secret-wins', COROS_PASSWORD: 'password#not-comment', GARMIN_USERNAME: 'garmin@example.invalid' });
    requireBridgeAccounts(env);
    assert.equal(env.GARMIN_PASSWORD, undefined);
    if (process.platform !== 'win32') {
        await fs.chmod(path.join(root, 'coros-sync', '.env.local'), 0o644);
        assert.throws(() => loadPrivateEnv(root, {}), { code: 'CONFIG' });
    }
    assert.throws(() => requireBridgeAccounts({ GARMIN_USERNAME: 'x' }), error => error.code === 'CONFIG' && error.message.includes('COROS_PASSWORD'));
});

test('workspace previews read-only and persists apply state inside the tracked Garmin database', async t => {
    const { root } = await fixture(t);
    process.env.AESKEY = 'test-key';
    await createGarminDb(root, 'garmin@example.invalid', process.env.AESKEY);
    const filename = path.join(root, 'db', 'garmin.db');
    const before = await fs.readFile(filename);

    const preview = await SyncWorkspace.create(root);
    try { assert.deepEqual(await preview.load(false), emptyState()); } finally { await preview.close(); }
    assert.deepEqual(await fs.readFile(filename), before);

    const writer = await SyncWorkspace.create(root);
    try {
        const state = await writer.load(true);
        state.accounts['coros-cn'] = 'a'.repeat(64);
        await writer.save(state);
    } finally { await writer.close(); }

    const reader = await SyncWorkspace.create(root);
    try { assert.equal((await reader.load(false)).accounts['coros-cn'], 'a'.repeat(64)); } finally { await reader.close(); }
    const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        assert.ok(await db.get(`SELECT id FROM ${STATE_TABLE} WHERE id = 1`));
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM garmin_session')).count, 1);
    } finally { await db.close(); }
});

test('workspace recovers a compact upload intent before the full database checkpoint arrives', async t => {
    const { root } = await fixture(t);
    process.env.AESKEY = 'test-key';
    await createGarminDb(root, 'garmin@example.invalid', process.env.AESKEY);
    const state = emptyState();
    state.accounts['garmin-cn'] = hash('garmin-cn');
    state.accounts['coros-cn'] = hash('coros-cn');
    const source = activity('garmin-cn', 'g1');
    const canonical = 'canonical_1';
    state.activities['garmin-cn:g1'] = { activity: source, canonical, missing: 0, evidence: evidence(source) };
    const task = state.transfers[`${canonical}:coros-cn`] = {
        canonical, source: 'garmin-cn', sourceId: source.id, target: 'coros-cn', status: 'uploading',
        attempt: '00000000-0000-4000-8000-000000000000',
        filename: 'dailysync_00000000-0000-4000-8000-000000000000.fit', createdAt: 1,
        evidence: evidence(source), beforeIds: [],
    };
    await writeUploadIntent(root, createUploadIntent(state, task));

    const recovered = await SyncWorkspace.create(root);
    try {
        const loaded = await recovered.load(true);
        assert.equal(Object.values(loaded.transfers)[0].status, 'uploading');
        await recovered.save(loaded);
        await recovered.clearUploadIntent();
    } finally { await recovered.close(); }

    await assert.rejects(fs.stat(path.join(root, UPLOAD_INTENT_PATH)), { code: 'ENOENT' });
    const reader = await SyncWorkspace.create(root);
    try { assert.equal(Object.values((await reader.load(false)).transfers)[0].status, 'uploading'); }
    finally { await reader.close(); }
});

test('writable workspaces hold an exclusive lock and remove all per-run artifacts after closing', async t => {
    const { root } = await fixture(t);
    process.env.AESKEY = 'test-key';
    await createGarminDb(root, 'garmin@example.invalid', process.env.AESKEY);
    const first = await SyncWorkspace.create(root);
    const second = await SyncWorkspace.create(root);
    try {
        await first.load(true);
        await assert.rejects(second.load(true), { code: 'LOCK_HELD' });
        await first.assertOwned();
    } finally {
        await first.close();
        await second.close();
    }
    assert.deepEqual(await fs.readdir(path.join(root, 'coros-sync', '.local')), []);

    const next = await SyncWorkspace.create(root);
    try { await next.load(true); } finally { await next.close(); }
    assert.deepEqual(await fs.readdir(path.join(root, 'coros-sync', '.local')), []);
});

test('a replaced write lock stops state saves and is never removed as if still owned', async t => {
    const { root } = await fixture(t);
    process.env.AESKEY = 'test-key';
    await createGarminDb(root, 'garmin@example.invalid', process.env.AESKEY);
    const workspace = await SyncWorkspace.create(root);
    const state = await workspace.load(true);
    const lock = path.join(root, 'coros-sync', '.local', 'write.lock');
    await fs.writeFile(lock, 'replacement', { mode: 0o600 });
    await assert.rejects(workspace.save(state), { code: 'LOCK_LOST' });
    await assert.rejects(workspace.close(), { code: 'LOCK_LOST' });
    assert.equal(await fs.readFile(lock, 'utf8'), 'replacement');
});

test('Actions writes do not depend on an additional mode variable', async t => {
    const { root } = await fixture(t);
    process.env.GITHUB_ACTIONS = 'true';
    await assert.rejects(main('sync', ['--apply'], root), { code: 'CONFIG' });
    await assert.rejects(main('sync', ['--apply', '--activity-id', '123'], root), { code: 'CONFIG' });
    await assert.rejects(main('migration', ['--apply', '--migrate-start', '1'], root), { code: 'CONFIG' });
    await assert.rejects(fs.stat(path.join(root, 'db', 'garmin.db')), { code: 'ENOENT' });
});

test('pagination settings reject unsafe ranges and invalid booleans before network access', async t => {
    const { root } = await fixture(t);
    Object.assign(process.env, { GARMIN_USERNAME: 'garmin@example.invalid', COROS_USERNAME: 'coros@example.invalid',
        COROS_PASSWORD: 'password', AESKEY: 'test-key' });
    await createGarminDb(root, process.env.GARMIN_USERNAME, process.env.AESKEY);

    process.env.GARMIN_SYNC_NUM = '1001';
    await assert.rejects(main('sync', [], root), { code: 'CONFIG' });
    delete process.env.GARMIN_SYNC_NUM;
    process.env.GARMIN_MIGRATE_AUTO_PAGE = 'flase';
    await assert.rejects(main('migration', [], root), { code: 'CONFIG' });
    delete process.env.GARMIN_MIGRATE_AUTO_PAGE;
    process.env.GARMIN_MIGRATE_START = 'not-a-number';
    await assert.rejects(main('migration', [], root), { code: 'CONFIG' });
});
