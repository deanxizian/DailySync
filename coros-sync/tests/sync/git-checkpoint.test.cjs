require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertRemoteGarminDbLock, clearCorosUploadIntent, COROS_STATE_MARKER_REF, COROS_STATE_REF,
    initializeCorosState, publishCorosUploadIntent, restoreCorosState } = require('../../src/sync/git-checkpoint');
const { COROS_STATE_DB_PATH, createUploadIntent, readUploadIntent,
    UPLOAD_INTENT_PATH } = require('../../src/sync/upload-intent');
const { DEFAULT_AES_KEY } = require('../../src/sync/garmin-db');
const { GarminDbState, initializeStateDatabase } = require('../../src/sync/state');
const { LEGACY_UPLOAD_INTENT_PATH } = require('../../src/sync/legacy-state');
const { emptyState } = require('../../src/sync/types');
const { activity, evidence, hash } = require('./helpers.cjs');

const LOCK_REF = 'refs/heads/codex/garmin-db-writer-lock';
const AES_KEY = 'test-aes-key';

function uploadIntent(sourceId = 'g1', attempt = '00000000-0000-4000-8000-000000000000') {
    const state = emptyState();
    state.accounts['garmin-cn'] = hash('garmin-cn');
    state.accounts['coros-cn'] = hash('coros-cn');
    const source = activity('garmin-cn', sourceId);
    const canonical = `canonical_${sourceId}`;
    state.activities[`garmin-cn:${sourceId}`] = { activity: source, canonical, missing: 0, evidence: evidence(source) };
    const transfer = state.transfers[`${canonical}:coros-cn`] = {
        canonical, source: 'garmin-cn', sourceId: source.id, target: 'coros-cn', status: 'uploading',
        attempt, filename: `dailysync_${attempt}.fit`, createdAt: 1,
        evidence: evidence(source), beforeIds: [],
    };
    return createUploadIntent(state, transfer);
}

function legacyUploadingState() {
    const state = emptyState();
    state.accounts['garmin-cn'] = hash('garmin-cn');
    state.accounts['coros-cn'] = hash('coros-cn');
    const source = activity('garmin-cn', 'legacy');
    const canonical = 'legacy_canonical';
    state.activities[`garmin-cn:${source.id}`] = { activity: source, canonical, missing: 0, evidence: evidence(source) };
    const transfer = state.transfers[`${canonical}:coros-cn`] = {
        canonical, source: 'garmin-cn', sourceId: source.id, target: 'coros-cn', status: 'uploading',
        attempt: '00000000-0000-4000-8000-000000000009',
        filename: 'dailysync_00000000-0000-4000-8000-000000000009.fit', createdAt: 1,
        evidence: evidence(source), beforeIds: [],
    };
    return { state, intent: createUploadIntent(state, transfer) };
}

function git(cwd, args, options = {}) {
    return execFileSync('git', args, { cwd, encoding: 'utf8',
        env: { ...process.env, ...(options.env ?? {}) }, input: options.input }).trim();
}

function identity() {
    return {
        GIT_AUTHOR_NAME: 'DailySync Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'DailySync Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
}

function remoteHash(work, ref) {
    return git(work, ['ls-remote', '--exit-code', 'origin', ref]).split(/\s+/)[0];
}

function rootSnapshot(work, state, intent, extra) {
    const entries = [];
    for (const [name, content] of [['coros-state.db', state], ['upload-intent.enc', intent], ['extra', extra]]) {
        if (content === undefined) continue;
        const blob = git(work, ['hash-object', '-w', '--stdin'], { input: content });
        entries.push(`100644 blob ${blob}\t${name}`);
    }
    const tree = git(work, ['mktree'], { input: `${entries.sort().join('\n')}\n` });
    return git(work, ['commit-tree', tree, '-m', 'test COROS state'], { env: identity() });
}

function markerSnapshot(work, payload = 'dailysync-coros-sync-state-v1\n') {
    const blob = git(work, ['hash-object', '-w', '--stdin'], { input: payload });
    const tree = git(work, ['mktree'], { input: `100644 blob ${blob}\tinitialized\n` });
    return git(work, ['commit-tree', tree, '-m', 'test COROS marker'], { env: identity() });
}

async function fixture(t, options = {}) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-git-checkpoint-'));
    const remote = path.join(base, 'remote.git');
    const work = path.join(base, 'work');
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await fs.mkdir(remote);
    await fs.mkdir(work);
    git(remote, ['init', '--bare']);
    git(work, ['init']);
    git(work, ['checkout', '-b', 'feature']);
    git(work, ['config', 'user.name', 'DailySync Test']);
    git(work, ['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(work, 'README.md'), 'project history');
    await fs.writeFile(path.join(work, '.gitignore'), 'coros-sync/.local/\n');
    git(work, ['add', 'README.md', '.gitignore']);
    git(work, ['commit', '-m', 'Initial project']);
    git(work, ['remote', 'add', 'origin', remote]);
    git(work, ['push', 'origin', 'HEAD:refs/heads/feature']);

    const emptyTree = git(work, ['mktree'], { input: '' });
    const lockCommit = git(work, ['commit-tree', emptyTree, '-m', 'test lock'], { env: identity() });
    git(work, ['push', 'origin', `${lockCommit}:${LOCK_REF}`]);
    const stateCommit = rootSnapshot(work, options.state ?? 's'.repeat(4096), options.intent, options.extra);
    if (options.stateRef !== false) git(work, ['push', 'origin', `${stateCommit}:${COROS_STATE_REF}`]);
    const markerCommit = markerSnapshot(work, options.markerPayload);
    if (options.markerRef !== false) git(work, ['push', 'origin', `${markerCommit}:${COROS_STATE_MARKER_REF}`]);
    const env = { GITHUB_ACTIONS: 'true', GARMIN_DB_LOCK_COMMIT: lockCommit, AESKEY: AES_KEY };
    if (options.restore !== false) await restoreCorosState(work, env);
    return { work, remote, env, lockCommit, stateCommit, markerCommit };
}

test('Action snapshots never advance project history and always replace the state root commit', async t => {
    const f = await fixture(t);
    const projectHead = remoteHash(f.work, 'refs/heads/feature');
    const localHead = git(f.work, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH), 'first checkpoint'.repeat(300));

    await publishCorosUploadIntent(f.work, uploadIntent(), f.env);

    const uploading = remoteHash(f.work, COROS_STATE_REF);
    assert.notEqual(uploading, f.stateCommit);
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), projectHead);
    assert.equal(git(f.work, ['rev-parse', 'HEAD']), localHead);
    assert.equal(git(f.work, ['rev-list', '--parents', '-n', '1', uploading]).split(/\s+/).length, 1);
    assert.equal(git(f.work, ['rev-list', '--count', uploading]), '1');
    assert.deepEqual(git(f.work, ['ls-tree', '-r', '--name-only', uploading]).split('\n'),
        ['coros-state.db', 'upload-intent.enc']);
    assert.equal(git(f.work, ['--git-dir', f.remote, 'show', `${uploading}:coros-state.db`]),
        'first checkpoint'.repeat(300));
    const encrypted = git(f.work, ['--git-dir', f.remote, 'show', `${uploading}:upload-intent.enc`]);
    assert.equal(encrypted.includes('garmin-cn'), false);
    assert.equal((await readUploadIntent(f.work, AES_KEY)).transfer.status, 'uploading');
    await assertRemoteGarminDbLock(f.work, f.env);

    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH), 'completed checkpoint'.repeat(300));
    await clearCorosUploadIntent(f.work, f.env);

    const completed = remoteHash(f.work, COROS_STATE_REF);
    assert.notEqual(completed, uploading);
    assert.equal(git(f.work, ['rev-list', '--count', completed]), '1');
    assert.equal(git(f.work, ['ls-tree', '-r', '--name-only', completed]), 'coros-state.db');
    assert.equal(git(f.work, ['--git-dir', f.remote, 'show', `${completed}:coros-state.db`]),
        'completed checkpoint'.repeat(300));
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), projectHead);
    assert.equal(git(f.work, ['rev-parse', 'HEAD']), localHead);
    assert.equal(git(f.work, ['status', '--porcelain']), '');
});

test('a later intent snapshot includes all state completed before the next upload', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH), 'first activity uploading'.repeat(200));
    await publishCorosUploadIntent(f.work, uploadIntent(), f.env);

    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH),
        'first activity complete; second activity uploading'.repeat(200));
    await publishCorosUploadIntent(f.work,
        uploadIntent('g2', '00000000-0000-4000-8000-000000000001'), f.env);

    const state = remoteHash(f.work, COROS_STATE_REF);
    assert.equal(git(f.work, ['--git-dir', f.remote, 'show', `${state}:coros-state.db`]),
        'first activity complete; second activity uploading'.repeat(200));
    assert.equal((await readUploadIntent(f.work, AES_KEY)).source.activity.id, 'g2');
    assert.equal(git(f.work, ['rev-list', '--count', state]), '1');
});

test('an empty Action AESKEY keeps compatibility with the original default key', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH), 'uploading state'.repeat(300));
    await publishCorosUploadIntent(f.work, uploadIntent(), { ...f.env, AESKEY: '' });
    assert.equal((await readUploadIntent(f.work, DEFAULT_AES_KEY)).transfer.status, 'uploading');
});

test('a missing remote lock rejects snapshots before local or remote state changes', async t => {
    const f = await fixture(t);
    const state = remoteHash(f.work, COROS_STATE_REF);
    const env = { ...f.env, GARMIN_DB_LOCK_COMMIT: 'a'.repeat(40) };
    await assert.rejects(assertRemoteGarminDbLock(f.work, env), { code: 'LOCK_LOST' });
    await assert.rejects(publishCorosUploadIntent(f.work, uploadIntent(), env), { code: 'LOCK_LOST' });
    assert.equal(remoteHash(f.work, COROS_STATE_REF), state);
    await assert.rejects(fs.stat(path.join(f.work, UPLOAD_INTENT_PATH)), { code: 'ENOENT' });
});

test('a rejected snapshot push leaves project history and remote state unchanged', async t => {
    const f = await fixture(t);
    const project = remoteHash(f.work, 'refs/heads/feature');
    const state = remoteHash(f.work, COROS_STATE_REF);
    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH), 'must not publish'.repeat(300));
    const hook = path.join(f.remote, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n');
    await fs.chmod(hook, 0o755);

    await assert.rejects(publishCorosUploadIntent(f.work, uploadIntent(), f.env), { code: 'STATE_PUBLISH' });

    assert.equal(remoteHash(f.work, COROS_STATE_REF), state);
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), project);
    assert.equal(git(f.work, ['status', '--porcelain']), '');
});

test('a concurrent state replacement is never overwritten', async t => {
    const f = await fixture(t);
    const concurrent = rootSnapshot(f.work, 'concurrent state'.repeat(300));
    git(f.work, ['push', '--force', 'origin', `${concurrent}:${COROS_STATE_REF}`]);
    await fs.writeFile(path.join(f.work, COROS_STATE_DB_PATH), 'stale local state'.repeat(300));

    await assert.rejects(publishCorosUploadIntent(f.work, uploadIntent(), f.env), { code: 'STATE_CONFLICT' });
    assert.equal(remoteHash(f.work, COROS_STATE_REF), concurrent);
});

test('explicit initialization migrates legacy state and publishes an immutable marker', async t => {
    const f = await fixture(t, { restore: false, stateRef: false, markerRef: false });
    const legacyDb = path.join(f.work, 'db', 'garmin.db');
    await fs.mkdir(path.dirname(legacyDb), { recursive: true });
    await initializeStateDatabase(legacyDb);
    const legacy = legacyUploadingState();
    const writer = await GarminDbState.open(legacyDb, true, AES_KEY);
    try { await writer.save(legacy.state); } finally { await writer.close(); }
    await fs.mkdir(path.join(f.work, 'coros-sync'), { recursive: true });
    await fs.writeFile(path.join(f.work, LEGACY_UPLOAD_INTENT_PATH),
        require('crypto-js').AES.encrypt(JSON.stringify(legacy.intent), AES_KEY).toString(), { mode: 0o600 });
    const project = remoteHash(f.work, 'refs/heads/feature');

    await initializeCorosState(f.work, f.env);

    const snapshot = remoteHash(f.work, COROS_STATE_REF);
    const marker = remoteHash(f.work, COROS_STATE_MARKER_REF);
    assert.equal(git(f.work, ['rev-list', '--count', snapshot]), '1');
    assert.equal(git(f.work, ['rev-list', '--count', marker]), '1');
    assert.equal(git(f.work, ['ls-tree', '-r', '--name-only', marker]), 'initialized');
    assert.equal(git(f.work, ['show', `${marker}:initialized`]), 'dailysync-coros-sync-state-v1');
    assert.deepEqual(git(f.work, ['ls-tree', '-r', '--name-only', snapshot]).split('\n'),
        ['coros-state.db', 'upload-intent.enc']);
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), project);
    await assert.rejects(initializeCorosState(f.work, f.env), { code: 'STATE_CONFLICT' });
});

test('explicit initialization creates a valid empty state when no legacy state exists', async t => {
    const f = await fixture(t, { restore: false, stateRef: false, markerRef: false });

    await initializeCorosState(f.work, f.env);
    await restoreCorosState(f.work, f.env);

    const store = await GarminDbState.open(path.join(f.work, COROS_STATE_DB_PATH), false, AES_KEY);
    try { assert.deepEqual(await store.load(), emptyState()); } finally { await store.close(); }
    assert.equal(git(f.work, ['rev-list', '--count', remoteHash(f.work, COROS_STATE_REF)]), '1');
    assert.equal(git(f.work, ['rev-list', '--count', remoteHash(f.work, COROS_STATE_MARKER_REF)]), '1');
});

test('a missing state ref fails closed even when verified legacy state remains', async t => {
    const f = await fixture(t, { restore: false, stateRef: false });
    const legacyDb = path.join(f.work, 'db', 'garmin.db');
    await fs.mkdir(path.dirname(legacyDb), { recursive: true });
    await initializeStateDatabase(legacyDb);
    const legacy = legacyUploadingState();
    const writer = await GarminDbState.open(legacyDb, true, AES_KEY);
    try { await writer.save(legacy.state); } finally { await writer.close(); }
    await fs.mkdir(path.join(f.work, 'coros-sync'), { recursive: true });
    await fs.writeFile(path.join(f.work, LEGACY_UPLOAD_INTENT_PATH),
        require('crypto-js').AES.encrypt(JSON.stringify(legacy.intent), AES_KEY).toString(), { mode: 0o600 });
    const before = await fs.readFile(legacyDb);

    const beforeIntent = await fs.readFile(path.join(f.work, LEGACY_UPLOAD_INTENT_PATH));

    await assert.rejects(restoreCorosState(f.work, f.env), { code: 'STATE_MISSING' });
    await assert.rejects(initializeCorosState(f.work, f.env), { code: 'STATE_MISSING' });

    assert.equal(git(f.work, ['ls-remote', 'origin', COROS_STATE_REF]), '');
    assert.deepEqual(await fs.readFile(legacyDb), before);
    assert.deepEqual(await fs.readFile(path.join(f.work, LEGACY_UPLOAD_INTENT_PATH)), beforeIntent);
    await assert.rejects(fs.stat(path.join(f.work, COROS_STATE_DB_PATH)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.work, UPLOAD_INTENT_PATH)), { code: 'ENOENT' });
});

test('restore rejects missing, parented, undersized and unexpected snapshots', async t => {
    const missing = await fixture(t, { restore: false });
    git(missing.work, ['push', 'origin', `:${COROS_STATE_REF}`]);
    await assert.rejects(restoreCorosState(missing.work, missing.env), { code: 'STATE_MISSING' });

    const parented = await fixture(t, { restore: false });
    const tree = git(parented.work, ['rev-parse', `${parented.stateCommit}^{tree}`]);
    const child = git(parented.work, ['commit-tree', tree, '-p', parented.stateCommit, '-m', 'invalid child'], { env: identity() });
    git(parented.work, ['push', '--force', 'origin', `${child}:${COROS_STATE_REF}`]);
    await assert.rejects(restoreCorosState(parented.work, parented.env), { code: 'STATE_INVALID' });

    const small = await fixture(t, { restore: false, state: 'small' });
    await assert.rejects(restoreCorosState(small.work, small.env), { code: 'STATE_INVALID' });

    const extra = await fixture(t, { restore: false, extra: 'unexpected' });
    await assert.rejects(restoreCorosState(extra.work, extra.env), { code: 'STATE_INVALID' });

    const missingMarker = await fixture(t, { restore: false });
    git(missingMarker.work, ['push', 'origin', `:${COROS_STATE_MARKER_REF}`]);
    await assert.rejects(restoreCorosState(missingMarker.work, missingMarker.env), { code: 'STATE_MISSING' });

    const invalidMarker = await fixture(t, { restore: false, markerPayload: 'wrong' });
    await assert.rejects(restoreCorosState(invalidMarker.work, invalidMarker.env), { code: 'STATE_INVALID' });
});

test('local read-only restoration refreshes the latest shared snapshot', async t => {
    const f = await fixture(t);
    const replacement = rootSnapshot(f.work, 'latest shared state'.repeat(300));
    git(f.work, ['push', '--force', 'origin', `${replacement}:${COROS_STATE_REF}`]);

    await restoreCorosState(f.work, { AESKEY: AES_KEY });

    assert.equal(await fs.readFile(path.join(f.work, COROS_STATE_DB_PATH), 'utf8'),
        'latest shared state'.repeat(300));
    assert.equal(remoteHash(f.work, COROS_STATE_REF), replacement);
});

test('Action publication requires restoration while local intent durability requires no Git remote', async t => {
    const action = await fixture(t, { restore: false });
    await assert.rejects(publishCorosUploadIntent(action.work, uploadIntent(), action.env), { code: 'STATE_MISSING' });

    const local = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-local-intent-'));
    t.after(() => fs.rm(local, { recursive: true, force: true }));
    await publishCorosUploadIntent(local, uploadIntent(), { AESKEY: AES_KEY });
    assert.equal((await readUploadIntent(local, AES_KEY)).transfer.status, 'uploading');
    await clearCorosUploadIntent(local, { AESKEY: AES_KEY });
    await assert.rejects(fs.stat(path.join(local, UPLOAD_INTENT_PATH)), { code: 'ENOENT' });
});
