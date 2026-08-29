const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const script = path.join(root, '.github/scripts/garmin-db-lock.cjs');
const { lockMessage, parseLockMessage } = require(script);

function git(directory, ...args) {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function outputValue(file, name) {
    const line = fs.readFileSync(file, 'utf8').split('\n').find(value => value.startsWith(`${name}=`));
    return line?.slice(name.length + 1);
}

function runLock(directory, command, env) {
    return new Promise((resolve, reject) => execFile(process.execPath, [script, command],
        { cwd: directory, env: { ...process.env, ...env }, encoding: 'utf8' },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
}

async function testRepository(t, prefix) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const remote = path.join(directory, 'remote.git');
    execFileSync('git', ['init', '--bare', remote]);
    const seed = path.join(directory, 'seed');
    execFileSync('git', ['init', seed]);
    git(seed, 'config', 'user.name', 'Test');
    git(seed, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'seed');
    git(seed, 'branch', '-M', 'main');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-u', 'origin', 'main');
    const clone = path.join(directory, 'clone');
    execFileSync('git', ['clone', '--quiet', '--branch', 'main', remote, clone]);
    git(clone, 'config', 'user.name', 'Test');
    git(clone, 'config', 'user.email', 'test@example.com');
    return { clone, remote, seed };
}

function pushRemoteLock(directory, owner) {
    const tree = git(directory, 'mktree');
    const commit = git(directory, 'commit-tree', tree, '-m', lockMessage(owner));
    git(directory, 'push', 'origin', `${commit}:refs/heads/codex/garmin-db-writer-lock`);
    return commit;
}

async function statusServer(t, status) {
    const server = http.createServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{}');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

test('remote Garmin database lock queues every writer and releases only its own lease', async t => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'dailysync-remote-lock-'));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const remote = path.join(directory, 'remote.git');
    execFileSync('git', ['init', '--bare', remote]);
    const seed = path.join(directory, 'seed');
    execFileSync('git', ['init', seed]);
    git(seed, 'config', 'user.name', 'Test');
    git(seed, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'seed');
    git(seed, 'branch', '-M', 'main');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-u', 'origin', 'main');

    const clones = ['a', 'b', 'c'].map(name => path.join(directory, name));
    for (const clone of clones) execFileSync('git', ['clone', '--quiet', '--branch', 'main', remote, clone]);
    const environments = clones.map((clone, index) => ({
        GITHUB_REPOSITORY: 'owner/repository', GITHUB_RUN_ID: String(100 + index), GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: `writer-${index}`, GITHUB_REF_NAME: 'main', GITHUB_OUTPUT: path.join(clone, 'output'),
        GARMIN_DB_LOCK_POLL_MS: '25', GARMIN_DB_LOCK_MAX_WAIT_MS: '5000', GARMIN_DB_LOCK_STALE_CHECK_MS: '60000',
    }));

    await runLock(clones[0], 'acquire', environments[0]);
    const queued = [1, 2].map(index => runLock(clones[index], 'acquire', environments[index])
        .then(stdout => ({ index, stdout })));
    await new Promise(resolve => setTimeout(resolve, 100));
    const firstCommit = outputValue(environments[0].GITHUB_OUTPUT, 'lock_commit');
    await runLock(clones[0], 'release', { ...environments[0], GARMIN_DB_LOCK_COMMIT: firstCommit });

    const firstQueued = await Promise.race(queued);
    const firstQueuedCommit = outputValue(environments[firstQueued.index].GITHUB_OUTPUT, 'lock_commit');
    await runLock(clones[firstQueued.index], 'release',
        { ...environments[firstQueued.index], GARMIN_DB_LOCK_COMMIT: firstQueuedCommit });
    const otherQueued = await queued.find((_, index) => index !== firstQueued.index - 1);
    const otherCommit = outputValue(environments[otherQueued.index].GITHUB_OUTPUT, 'lock_commit');
    await runLock(clones[otherQueued.index], 'release',
        { ...environments[otherQueued.index], GARMIN_DB_LOCK_COMMIT: otherCommit });

    assert.deepEqual(new Set([firstQueued.index, otherQueued.index]), new Set([1, 2]));
    assert.equal(git(seed, 'ls-remote', 'origin', 'refs/heads/codex/garmin-db-writer-lock'), '');

    const invalid = { ...environments[0], GITHUB_RUN_ID: '999', GITHUB_REF_NAME: '../invalid',
        GITHUB_OUTPUT: path.join(clones[0], 'invalid-output') };
    await assert.rejects(runLock(clones[0], 'acquire', invalid), /workflow branch name is invalid/);
    assert.equal(git(seed, 'ls-remote', 'origin', 'refs/heads/codex/garmin-db-writer-lock'), '');
});

test('lock metadata is strict and does not expose workflow credentials', () => {
    const owner = { repository: 'owner/repository', runId: '10', runAttempt: '2', job: 'sync',
        createdAt: '2026-08-29T00:00:00.000Z' };
    const message = lockMessage(owner);
    assert.deepEqual(parseLockMessage(message), owner);
    assert.equal(message.includes('secret'), false);
    assert.equal(parseLockMessage('untrusted lock'), undefined);
});

test('an old lock is recoverable after GitHub deletes its workflow-run record', async t => {
    const { clone, seed } = await testRepository(t, 'dailysync-missing-run-lock-');
    const oldOwner = { repository: 'owner/repository', runId: '200', runAttempt: '1', job: 'writer',
        createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() };
    pushRemoteLock(clone, oldOwner);
    const output = path.join(clone, 'output');
    const api = await statusServer(t, 404);
    const env = {
        GITHUB_REPOSITORY: 'owner/repository', GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'next-writer', GITHUB_REF_NAME: 'main', GITHUB_OUTPUT: output,
        GITHUB_TOKEN: 'test-token', GITHUB_API_URL: api, GARMIN_DB_LOCK_POLL_MS: '10',
        GARMIN_DB_LOCK_MAX_WAIT_MS: '2000', GARMIN_DB_LOCK_STALE_CHECK_MS: '1',
    };

    const stdout = await runLock(clone, 'acquire', env);
    assert.match(stdout, /Removed expired Garmin database writer lock/);
    const commit = outputValue(output, 'lock_commit');
    await runLock(clone, 'release', { ...env, GARMIN_DB_LOCK_COMMIT: commit });
    assert.equal(git(seed, 'ls-remote', 'origin', 'refs/heads/codex/garmin-db-writer-lock'), '');
});

test('an API error never makes an old workflow lock appear stale', async t => {
    const { clone, seed } = await testRepository(t, 'dailysync-unknown-run-lock-');
    const oldOwner = { repository: 'owner/repository', runId: '300', runAttempt: '1', job: 'writer',
        createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() };
    const lockCommit = pushRemoteLock(clone, oldOwner);
    const api = await statusServer(t, 500);
    const env = {
        GITHUB_REPOSITORY: 'owner/repository', GITHUB_RUN_ID: '301', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'next-writer', GITHUB_REF_NAME: 'main', GITHUB_OUTPUT: path.join(clone, 'output'),
        GITHUB_TOKEN: 'test-token', GITHUB_API_URL: api, GARMIN_DB_LOCK_POLL_MS: '10',
        GARMIN_DB_LOCK_MAX_WAIT_MS: '100', GARMIN_DB_LOCK_STALE_CHECK_MS: '1',
        GARMIN_DB_LOCK_MISSING_RUN_STALE_MS: '1',
    };

    await assert.rejects(runLock(clone, 'acquire', env), /Timed out waiting/);
    assert.match(git(seed, 'ls-remote', 'origin', 'refs/heads/codex/garmin-db-writer-lock'),
        new RegExp(`^${lockCommit}\\s`));
});
