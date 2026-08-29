require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertRemoteGarminDbLock, clearCorosUploadIntent, publishCorosUploadIntent } = require('../../src/sync/git-checkpoint');
const { createUploadIntent, readUploadIntent, UPLOAD_INTENT_PATH } = require('../../src/sync/upload-intent');
const { DEFAULT_AES_KEY } = require('../../src/sync/garmin-db');
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

async function fixture(t) {
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
    await fs.mkdir(path.join(work, 'db'));
    await fs.writeFile(path.join(work, 'db', 'garmin.db'), 'initial');
    git(work, ['add', 'db/garmin.db']);
    git(work, ['commit', '-m', 'Initial database']);
    git(work, ['remote', 'add', 'origin', remote]);
    git(work, ['push', 'origin', 'HEAD:refs/heads/feature']);

    const emptyTree = git(work, ['mktree'], { input: '' });
    const lockCommit = git(work, ['commit-tree', emptyTree, '-m', 'test lock'], { env: identity() });
    git(work, ['push', 'origin', `${lockCommit}:${LOCK_REF}`]);
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'feature', GARMIN_DB_LOCK_COMMIT: lockCommit, AESKEY: AES_KEY };
    return { work, remote, env, lockCommit };
}

test('Action upload intents atomically checkpoint the Garmin database and their deletion', async t => {
    const f = await fixture(t);
    const before = remoteHash(f.work, 'refs/heads/feature');
    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'large local state checkpoint');

    await publishCorosUploadIntent(f.work, uploadIntent(), f.env);

    const after = remoteHash(f.work, 'refs/heads/feature');
    assert.notEqual(after, before);
    assert.equal(after, git(f.work, ['rev-parse', 'HEAD']));
    assert.equal(git(f.work, ['--git-dir', f.remote, 'show', `${after}:db/garmin.db`]), 'large local state checkpoint');
    const encrypted = git(f.work, ['--git-dir', f.remote, 'show', `${after}:${UPLOAD_INTENT_PATH}`]);
    assert.equal(encrypted.includes('garmin-cn'), false);
    assert.ok(Buffer.byteLength(encrypted) < 4096);
    assert.equal((await readUploadIntent(f.work, AES_KEY)).transfer.status, 'uploading');
    assert.equal(git(f.work, ['show', '-s', '--format=%s', after]), 'Save COROS Upload Intent');
    assert.equal(remoteHash(f.work, LOCK_REF), f.lockCommit);
    assert.equal(git(f.work, ['status', '--porcelain']), '');
    await assertRemoteGarminDbLock(f.work, f.env);

    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'retryable local state checkpoint');
    await clearCorosUploadIntent(f.work, f.env);

    const cleared = remoteHash(f.work, 'refs/heads/feature');
    assert.notEqual(cleared, after);
    assert.equal(cleared, git(f.work, ['rev-parse', 'HEAD']));
    assert.equal(git(f.work, ['--git-dir', f.remote, 'ls-tree', '--name-only', cleared, UPLOAD_INTENT_PATH]), '');
    assert.equal(git(f.work, ['--git-dir', f.remote, 'show', `${cleared}:db/garmin.db`]), 'retryable local state checkpoint');
    assert.equal(git(f.work, ['show', '-s', '--format=%s', cleared]), 'Clear COROS Upload Intent');
    assert.equal(remoteHash(f.work, LOCK_REF), f.lockCommit);
    assert.equal(git(f.work, ['status', '--porcelain']), '');

    await clearCorosUploadIntent(f.work, f.env);
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), cleared);
});

test('replacing an upload intent checkpoints prior completed mappings', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'first activity uploading');
    await publishCorosUploadIntent(f.work, uploadIntent(), f.env);

    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'first activity complete; second activity uploading');
    await publishCorosUploadIntent(f.work,
        uploadIntent('g2', '00000000-0000-4000-8000-000000000001'), f.env);

    const head = remoteHash(f.work, 'refs/heads/feature');
    assert.equal(git(f.work, ['--git-dir', f.remote, 'show', `${head}:db/garmin.db`]),
        'first activity complete; second activity uploading');
    assert.equal((await readUploadIntent(f.work, AES_KEY)).source.activity.id, 'g2');
    assert.equal(remoteHash(f.work, LOCK_REF), f.lockCommit);
    assert.equal(git(f.work, ['status', '--porcelain']), '');
});

test('an empty Action AESKEY uses the original default for its upload intent', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'uploading state');
    await publishCorosUploadIntent(f.work, uploadIntent(), { ...f.env, AESKEY: '' });

    assert.equal((await readUploadIntent(f.work, DEFAULT_AES_KEY)).transfer.status, 'uploading');
});

test('a missing remote lock rejects an intent before changing branch history', async t => {
    const f = await fixture(t);
    const branch = remoteHash(f.work, 'refs/heads/feature');
    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'must not publish');
    const env = { ...f.env, GARMIN_DB_LOCK_COMMIT: 'a'.repeat(40) };

    await assert.rejects(assertRemoteGarminDbLock(f.work, env), { code: 'LOCK_LOST' });
    await assert.rejects(publishCorosUploadIntent(f.work, uploadIntent(), env), { code: 'LOCK_LOST' });
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), branch);
    assert.equal(git(f.work, ['rev-parse', 'HEAD']), branch);
});

test('a concurrently advanced workflow branch rejects an intent before commit or upload', async t => {
    const f = await fixture(t);
    const localHead = git(f.work, ['rev-parse', 'HEAD']);
    const tree = git(f.work, ['rev-parse', `${localHead}^{tree}`]);
    const advanced = git(f.work, ['commit-tree', tree, '-p', localHead, '-m', 'Concurrent update'], { env: identity() });
    git(f.work, ['push', 'origin', `${advanced}:refs/heads/feature`]);
    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'must not publish');

    await assert.rejects(publishCorosUploadIntent(f.work, uploadIntent(), f.env), { code: 'STATE_PUBLISH' });
    assert.equal(git(f.work, ['rev-parse', 'HEAD']), localHead);
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), advanced);
});

test('a concurrently advanced workflow branch rejects an intent deletion', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.work, 'db', 'garmin.db'), 'uploading state');
    await publishCorosUploadIntent(f.work, uploadIntent(), f.env);
    const localHead = git(f.work, ['rev-parse', 'HEAD']);
    const tree = git(f.work, ['rev-parse', `${localHead}^{tree}`]);
    const advanced = git(f.work, ['commit-tree', tree, '-p', localHead, '-m', 'Concurrent update'], { env: identity() });
    git(f.work, ['push', 'origin', `${advanced}:refs/heads/feature`]);

    await assert.rejects(clearCorosUploadIntent(f.work, f.env), { code: 'STATE_PUBLISH' });
    assert.equal(git(f.work, ['rev-parse', 'HEAD']), localHead);
    assert.equal(remoteHash(f.work, 'refs/heads/feature'), advanced);
    assert.ok(git(f.work, ['--git-dir', f.remote, 'show', `${advanced}:${UPLOAD_INTENT_PATH}`]));
});

test('local runs do not require a Git repository or remote lock', async () => {
    await publishCorosUploadIntent('/path/that/does/not/exist', uploadIntent(), {});
    await clearCorosUploadIntent('/path/that/does/not/exist', {});
    await assertRemoteGarminDbLock('/path/that/does/not/exist', {});
});
