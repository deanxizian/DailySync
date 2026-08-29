require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { GarminDbState, STATE_TABLE, validateState } = require('../../src/sync/state');
const { emptyState } = require('../../src/sync/types');
const { activity, evidence, hash, clone } = require('./helpers.cjs');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-state-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'garmin.db');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE garmin_session (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, region TEXT, session TEXT);
        CREATE TABLE garmin_sync_cursor (direction TEXT PRIMARY KEY, last_sync_start_time TEXT, updated_at TEXT);
    `);
    await db.run('INSERT INTO garmin_session (user, region, session) VALUES (?, ?, ?)', 'runner@example.invalid', 'CN', 'original-session');
    await db.run('INSERT INTO garmin_sync_cursor VALUES (?, ?, ?)', 'CN_TO_GLOBAL', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await db.close();
    return { directory, filename, aesKey: 'test-aes-key' };
}

function populatedState() {
    const state = emptyState();
    state.accounts['garmin-cn'] = hash('garmin-cn');
    state.accounts['coros-cn'] = hash('coros-cn');
    const item = activity('garmin-cn', 'g1');
    state.activities['garmin-cn:g1'] = { activity: item, canonical: 'one', missing: 0, evidence: evidence(item) };
    state.sessions['garmin-cn'] = {
        loginHash: hash('login'),
        token: { oauth1: { oauth_token: 'private-session' }, oauth2: { access_token: 'private-access' } },
    };
    return state;
}

test('read-only preview neither creates a state table nor changes garmin.db', async t => {
    const f = await fixture(t);
    const before = await fs.readFile(f.filename);
    const store = await GarminDbState.open(f.filename, false, f.aesKey);
    try {
        assert.equal(await store.load(), undefined);
        await assert.rejects(store.save(emptyState()), { code: 'STATE_SAVE' });
    } finally { await store.close(); }
    assert.deepEqual(await fs.readFile(f.filename), before);
    const db = await open({ filename: f.filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        assert.equal(await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", STATE_TABLE), undefined);
    } finally { await db.close(); }
});

test('tracked state uses the original AESKEY convention and preserves original tables', async t => {
    const f = await fixture(t);
    const state = populatedState();
    const writer = await GarminDbState.open(f.filename, true, f.aesKey);
    try { await writer.save(state); } finally { await writer.close(); }

    const db = await open({ filename: f.filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    let payload;
    try {
        const session = await db.get('SELECT user, region, session FROM garmin_session');
        const cursor = await db.get('SELECT direction, last_sync_start_time FROM garmin_sync_cursor');
        assert.deepEqual(session, { user: 'runner@example.invalid', region: 'CN', session: 'original-session' });
        assert.deepEqual(cursor, { direction: 'CN_TO_GLOBAL', last_sync_start_time: '2026-01-01T00:00:00Z' });
        payload = (await db.get(`SELECT payload FROM ${STATE_TABLE} WHERE id = 1`)).payload;
        assert.equal(payload.includes('private-session'), false);
        assert.equal(payload.includes('private-access'), false);
    } finally { await db.close(); }

    const reader = await GarminDbState.open(f.filename, false, f.aesKey);
    try { assert.deepEqual(await reader.load(), state); } finally { await reader.close(); }
    const wrongKey = await GarminDbState.open(f.filename, false, 'wrong-key');
    try { await assert.rejects(wrongKey.load(), { code: 'STATE_INVALID' }); } finally { await wrongKey.close(); }
});

test('an unchanged checkpoint does not rewrite the encrypted database', async t => {
    const f = await fixture(t);
    const writer = await GarminDbState.open(f.filename, true, f.aesKey);
    try { await writer.save(populatedState()); } finally { await writer.close(); }
    const before = await fs.readFile(f.filename);

    const sameWriter = await GarminDbState.open(f.filename, true, f.aesKey);
    try {
        const state = await sameWriter.load();
        await sameWriter.save(state);
    } finally { await sameWriter.close(); }
    assert.deepEqual(await fs.readFile(f.filename), before);
});

test('completed-transfer validation indexes activity mappings once', () => {
    const count = 250;
    const state = emptyState();
    state.accounts['garmin-cn'] = hash('garmin-cn');
    state.accounts['coros-cn'] = hash('coros-cn');
    const records = {};
    for (let index = 0; index < count; index++) {
        const canonical = `canonical_${index}`;
        const source = activity('garmin-cn', `g${index}`, index * 1000);
        const target = activity('coros-cn', `c${index}`, index * 1000);
        records[`garmin-cn:${source.id}`] = { activity: source, canonical, missing: 0 };
        records[`coros-cn:${target.id}`] = { activity: target, canonical, missing: 0 };
        state.transfers[`${canonical}:coros-cn`] = {
            canonical, source: 'garmin-cn', sourceId: source.id, target: 'coros-cn', status: 'complete',
            attempt: '00000000-0000-4000-8000-000000000000',
            filename: 'dailysync_00000000-0000-4000-8000-000000000000.fit', createdAt: 1,
            receipt: { status: 'accepted', stage: 'finished', targetId: target.id },
        };
    }
    let reads = 0;
    state.activities = new Proxy(records, {
        get(target, property, receiver) {
            if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(target, property)) reads++;
            return Reflect.get(target, property, receiver);
        },
    });
    validateState(state);
    assert.ok(reads <= count * 4, `activity index was read ${reads} times`);
});

test('invalid mappings never replace the last valid database checkpoint', async t => {
    const f = await fixture(t);
    const state = populatedState();
    const store = await GarminDbState.open(f.filename, true, f.aesKey);
    try {
        await store.save(state);
        const bad = clone(state);
        bad.activities['garmin-cn:g2'] = { ...bad.activities['garmin-cn:g1'], activity: activity('garmin-cn', 'g2') };
        assert.throws(() => validateState(bad), { code: 'STATE_INVALID' });
        await assert.rejects(store.save(bad), { code: 'STATE_INVALID' });
        assert.deepEqual(await store.load(), state);
    } finally { await store.close(); }
});
