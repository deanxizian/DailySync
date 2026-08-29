#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const LOCK_REF = process.env.GARMIN_DB_LOCK_REF || 'refs/heads/codex/garmin-db-writer-lock';
const MARKER = 'dailysync-garmin-db-lock-v1';
const DEFAULT_POLL_MS = 15000;
const DEFAULT_MAX_WAIT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_STALE_CHECK_MS = 60000;
const DEFAULT_MISSING_RUN_STALE_MS = 7 * 60 * 60 * 1000;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function git(args, options = {}) {
    const result = spawnSync('git', args, { encoding: 'utf8', ...options });
    if (result.error) throw result.error;
    return result;
}

function gitOk(args, options = {}) {
    const result = git(args, options);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed while managing the Garmin database lock.`);
    return result.stdout.trim();
}

function currentOwner() {
    const repository = process.env.GITHUB_REPOSITORY || '';
    const runId = process.env.GITHUB_RUN_ID || '';
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '';
    const job = process.env.GITHUB_JOB || '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^\d+$/.test(runId) ||
        !/^\d+$/.test(runAttempt) || !/^[A-Za-z0-9_.-]+$/.test(job)) {
        throw new Error('GitHub run identity is unavailable; the Garmin database lock cannot be acquired.');
    }
    return { repository, runId, runAttempt, job, createdAt: new Date().toISOString() };
}

function ownerId(owner) {
    return `${owner.repository}/${owner.runId}/${owner.runAttempt}/${owner.job}`;
}

function lockMessage(owner) {
    return `${MARKER} ${Buffer.from(JSON.stringify(owner)).toString('base64url')}`;
}

function parseLockMessage(message) {
    const line = String(message).trim().split('\n')[0];
    if (!line.startsWith(`${MARKER} `)) return undefined;
    try {
        const owner = JSON.parse(Buffer.from(line.slice(MARKER.length + 1), 'base64url').toString('utf8'));
        if (!owner || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(owner.repository) ||
            !/^\d+$/.test(owner.runId) || !/^\d+$/.test(owner.runAttempt) ||
            !/^[A-Za-z0-9_.-]+$/.test(owner.job) || !Number.isFinite(Date.parse(owner.createdAt))) return undefined;
        return owner;
    } catch (_) {
        return undefined;
    }
}

function createLockCommit(owner) {
    const tree = gitOk(['mktree'], { input: '' });
    const identity = {
        ...process.env,
        GIT_AUTHOR_NAME: 'DailySync Action Lock',
        GIT_AUTHOR_EMAIL: 'actions@github.com',
        GIT_COMMITTER_NAME: 'DailySync Action Lock',
        GIT_COMMITTER_EMAIL: 'actions@github.com',
    };
    return gitOk(['commit-tree', tree, '-m', lockMessage(owner)], { env: identity });
}

function remoteHash() {
    const result = git(['ls-remote', '--exit-code', 'origin', LOCK_REF]);
    if (result.status === 2) return undefined;
    if (result.status !== 0) throw new Error('Cannot read the remote Garmin database lock.');
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    if (lines.length !== 1 || !/^[a-f0-9]{40,64}\s/.test(lines[0])) {
        throw new Error('The remote Garmin database lock reference is invalid.');
    }
    return lines[0].split(/\s+/)[0];
}

function readRemoteOwner(hash) {
    const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', LOCK_REF]);
    if (fetched.status !== 0) return undefined;
    const shown = git(['show', '-s', '--format=%B', hash]);
    return shown.status === 0 ? parseLockMessage(shown.stdout) : undefined;
}

function tryCreate(commit) {
    return git(['push', '--porcelain', 'origin', `${commit}:${LOCK_REF}`]).status === 0;
}

function deleteWithLease(hash) {
    return git(['push', '--porcelain', `--force-with-lease=${LOCK_REF}:${hash}`, 'origin', `:${LOCK_REF}`]).status === 0;
}

async function githubRunState(owner) {
    const current = currentOwner();
    if (owner.repository !== current.repository) return 'unknown';
    if (owner.runId === current.runId && owner.runAttempt !== current.runAttempt) return 'completed';
    if (ownerId(owner) === ownerId(current)) return 'active';
    const token = process.env.GITHUB_TOKEN || '';
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    if (!token || !globalThis.fetch) return 'unknown';
    try {
        const response = await fetch(`${api}/repos/${owner.repository}/actions/runs/${owner.runId}`, {
            headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
                'x-github-api-version': '2022-11-28' },
            signal: AbortSignal.timeout(10000),
        });
        if (response.status === 404) return 'missing';
        if (!response.ok) return 'unknown';
        const run = await response.json();
        return run.status === 'completed' ? 'completed' : 'active';
    } catch (_) {
        return 'unknown';
    }
}

function refreshBranch() {
    const branch = process.env.GITHUB_REF_NAME || '';
    if (!branch || git(['check-ref-format', '--branch', branch]).status !== 0) {
        throw new Error('The workflow branch name is invalid; refusing to refresh the database checkout.');
    }
    gitOk(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    gitOk(['merge', '--ff-only', `refs/remotes/origin/${branch}`]);
}

function setOutputs(commit) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is unavailable.');
    fs.appendFileSync(output, `acquired=true\nlock_commit=${commit}\n`, 'utf8');
}

function finishAcquisition(commit, owner, verb) {
    try {
        refreshBranch();
        setOutputs(commit);
    } catch (error) {
        try {
            if (remoteHash() === commit) deleteWithLease(commit);
        } catch (_) {}
        throw error;
    }
    console.log(`${verb} Garmin database writer lock for ${ownerId(owner)}.`);
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquire() {
    const owner = currentOwner();
    const commit = createLockCommit(owner);
    const pollMs = positiveInteger(process.env.GARMIN_DB_LOCK_POLL_MS, DEFAULT_POLL_MS);
    const maxWaitMs = positiveInteger(process.env.GARMIN_DB_LOCK_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS);
    const staleCheckMs = positiveInteger(process.env.GARMIN_DB_LOCK_STALE_CHECK_MS, DEFAULT_STALE_CHECK_MS);
    const missingRunStaleMs = positiveInteger(process.env.GARMIN_DB_LOCK_MISSING_RUN_STALE_MS,
        DEFAULT_MISSING_RUN_STALE_MS);
    const deadline = Date.now() + maxWaitMs;
    let lastStatusCheck = 0;
    let announced;

    while (Date.now() < deadline) {
        const hash = remoteHash();
        if (!hash) {
            if (tryCreate(commit) && remoteHash() === commit) {
                finishAcquisition(commit, owner, 'Acquired');
                return;
            }
        } else {
            const holder = readRemoteOwner(hash);
            if (holder && ownerId(holder) === ownerId(owner)) {
                finishAcquisition(hash, owner, 'Recovered');
                return;
            }
            if (announced !== hash) {
                console.log(`Waiting for Garmin database writer lock${holder ? ` held by ${ownerId(holder)}` : ''}.`);
                announced = hash;
            }
            const lockAgeMs = holder ? Date.now() - Date.parse(holder.createdAt) : 0;
            if (holder && lockAgeMs >= staleCheckMs && Date.now() - lastStatusCheck >= staleCheckMs) {
                lastStatusCheck = Date.now();
                const runState = await githubRunState(holder);
                const stale = runState === 'completed' ||
                    (runState === 'missing' && lockAgeMs >= missingRunStaleMs);
                if (stale && deleteWithLease(hash)) {
                    const reason = runState === 'missing' ? 'expired' : 'completed';
                    console.log(`Removed ${reason} Garmin database writer lock for ${ownerId(holder)}.`);
                    continue;
                }
            }
        }
        await delay(pollMs);
    }
    throw new Error('Timed out waiting for the Garmin database writer lock; no database work was started.');
}

function release() {
    const expected = process.env.GARMIN_DB_LOCK_COMMIT || process.argv[3] || '';
    if (!/^[a-f0-9]{40,64}$/.test(expected)) throw new Error('The owned Garmin database lock commit is unavailable.');
    const actual = remoteHash();
    if (actual !== expected) throw new Error('The Garmin database lock is missing or owned by another run; it was not removed.');
    if (!deleteWithLease(expected)) throw new Error('The Garmin database lock could not be released with its ownership lease.');
    console.log('Released Garmin database writer lock.');
}

async function main() {
    if (process.argv[2] === 'acquire') await acquire();
    else if (process.argv[2] === 'release') release();
    else throw new Error('Usage: garmin-db-lock.cjs <acquire|release>');
}

if (require.main === module) main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Garmin database lock failed.');
    process.exitCode = 1;
});

module.exports = { lockMessage, parseLockMessage };
