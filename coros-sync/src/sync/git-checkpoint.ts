import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SyncError } from './errors';
import { UploadIntent } from './types';
import { clearUploadIntent, UPLOAD_INTENT_PATH, writeUploadIntent } from './upload-intent';

const DEFAULT_LOCK_REF = 'refs/heads/codex/garmin-db-writer-lock';
const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const GARMIN_DB_PATH = 'db/garmin.db';

interface ActionGitContext {
    branchRef: string;
    lockRef: string;
    lockCommit: string;
    env: NodeJS.ProcessEnv;
}

function git(root: string, args: string[], env: NodeJS.ProcessEnv) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.error) throw new SyncError('STATE_PUBLISH', 'Cannot run Git while publishing the COROS upload intent.');
    return result;
}

function output(result: ReturnType<typeof spawnSync>): string {
    return typeof result.stdout === 'string' ? result.stdout : '';
}

function gitOutput(root: string, args: string[], context: ActionGitContext): string {
    const result = git(root, args, context.env);
    if (result.status !== 0) throw new SyncError('STATE_PUBLISH', 'Git could not publish the COROS upload intent.');
    return output(result).trim();
}

function actionContext(root: string, environment: NodeJS.ProcessEnv): ActionGitContext | undefined {
    if (environment.GITHUB_ACTIONS !== 'true') return undefined;
    const env = environment === process.env ? process.env : { ...process.env, ...environment };
    const branch = environment.GITHUB_REF_NAME ?? '';
    const lockRef = environment.GARMIN_DB_LOCK_REF || DEFAULT_LOCK_REF;
    const lockCommit = environment.GARMIN_DB_LOCK_COMMIT ?? '';
    if (git(root, ['check-ref-format', '--branch', branch], env).status !== 0 ||
        git(root, ['check-ref-format', lockRef], env).status !== 0 || !HASH.test(lockCommit)) {
        throw new SyncError('STATE_PUBLISH', 'The Action branch or Garmin database lock identity is invalid.');
    }
    return { branchRef: `refs/heads/${branch}`, lockRef, lockCommit, env };
}

function remoteHash(root: string, ref: string, context: ActionGitContext, code: string): string | undefined {
    const result = git(root, ['ls-remote', '--exit-code', 'origin', ref], context.env);
    if (result.status === 2) return undefined;
    if (result.status !== 0) throw new SyncError(code, 'Cannot confirm the remote Garmin database writer state.');
    const lines = output(result).trim().split('\n').filter(Boolean);
    if (lines.length !== 1) throw new SyncError(code, 'The remote Garmin database writer state is ambiguous.');
    const fields = lines[0].split(/\s+/);
    if (fields.length !== 2 || fields[1] !== ref || !HASH.test(fields[0])) {
        throw new SyncError(code, 'The remote Garmin database writer state is invalid.');
    }
    return fields[0];
}

function stagedPaths(root: string, context: ActionGitContext): string[] {
    const result = git(root, ['diff', '--cached', '--name-only', '-z'], context.env);
    if (result.status !== 0) throw new SyncError('STATE_PUBLISH', 'Cannot inspect the staged COROS upload intent.');
    return output(result).split('\0').filter(Boolean);
}

function stageStateAndIntent(root: string, context: ActionGitContext, action: string): void {
    if (git(root, ['add', '--', GARMIN_DB_PATH, UPLOAD_INTENT_PATH], context.env).status !== 0) {
        throw new SyncError('STATE_PUBLISH', `The COROS upload intent ${action} could not be staged.`);
    }
    const staged = stagedPaths(root, context);
    if (staged.length !== 2 || !staged.includes(GARMIN_DB_PATH) || !staged.includes(UPLOAD_INTENT_PATH)) {
        throw new SyncError('STATE_PUBLISH', `The COROS upload intent ${action} did not include an isolated database checkpoint.`);
    }
    const deleted = git(root, ['diff', '--cached', '--diff-filter=D', '--name-only', '--', GARMIN_DB_PATH], context.env);
    if (deleted.status !== 0 || output(deleted).trim()) {
        throw new SyncError('STATE_PUBLISH', 'The COROS state checkpoint cannot delete db/garmin.db.');
    }
}

async function createCheckpointCommit(root: string, context: ActionGitContext, parent: string,
    message: string, action: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-git-index-'));
    const stagedContext = { ...context,
        env: { ...context.env, GIT_INDEX_FILE: path.join(directory, `index-${randomUUID()}`) } };
    try {
        gitOutput(root, ['read-tree', parent], stagedContext);
        stageStateAndIntent(root, stagedContext, action);
        const tree = gitOutput(root, ['write-tree'], stagedContext);
        if (!HASH.test(tree)) throw new SyncError('STATE_PUBLISH', 'The COROS state checkpoint tree is invalid.');
        const commitContext = { ...stagedContext, env: { ...stagedContext.env,
            GIT_AUTHOR_NAME: 'github-actions[bot]',
            GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
            GIT_COMMITTER_NAME: 'github-actions[bot]',
            GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' } };
        const commit = gitOutput(root, ['commit-tree', tree, '-p', parent, '-m', message], commitContext);
        if (!HASH.test(commit)) throw new SyncError('STATE_PUBLISH', 'The COROS state checkpoint commit is invalid.');
        return commit;
    } finally {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
}

function publishCheckpointCommit(root: string, context: ActionGitContext, parent: string,
    commit: string, action: string): void {
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', `The Action lost the remote Garmin database writer lock before ${action}.`);
    }
    // A transport can report failure after the remote accepted the commit, so the remote hash is authoritative.
    git(root, ['push', '--porcelain', 'origin', `${commit}:${context.branchRef}`], context.env);
    if (remoteHash(root, context.branchRef, context, 'STATE_PUBLISH') !== commit) {
        throw new SyncError('STATE_PUBLISH', `The COROS state checkpoint was not published while ${action}.`);
    }
    if (git(root, ['update-ref', 'HEAD', commit, parent], context.env).status !== 0 ||
        git(root, ['read-tree', commit], context.env).status !== 0) {
        throw new SyncError('STATE_PUBLISH', 'The local workflow branch could not follow the published COROS state checkpoint.');
    }
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', `The Action lost the remote Garmin database writer lock after ${action}.`);
    }
}

export async function assertRemoteGarminDbLock(root: string,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (!context) return;
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action no longer owns the remote Garmin database writer lock.');
    }
}

export async function publishCorosUploadIntent(root: string, intent: UploadIntent,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (!context) return;
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action no longer owns the remote Garmin database writer lock.');
    }

    const head = gitOutput(root, ['rev-parse', '--verify', 'HEAD'], context);
    if (!HASH.test(head) || remoteHash(root, context.branchRef, context, 'STATE_PUBLISH') !== head) {
        throw new SyncError('STATE_PUBLISH', 'The workflow branch changed before the COROS upload intent was published.');
    }
    if (stagedPaths(root, context).length) {
        throw new SyncError('STATE_PUBLISH', 'Unrelated staged changes prevent publishing the COROS upload intent.');
    }

    await writeUploadIntent(root, intent, environment.AESKEY);
    const intentCommit = await createCheckpointCommit(root, context, head,
        'Save COROS Upload Intent', 'publication');
    publishCheckpointCommit(root, context, head, intentCommit, 'publishing the upload intent');
}

export async function clearCorosUploadIntent(root: string,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (!context) {
        await clearUploadIntent(root);
        return;
    }
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action no longer owns the remote Garmin database writer lock.');
    }

    const head = gitOutput(root, ['rev-parse', '--verify', 'HEAD'], context);
    if (!HASH.test(head) || remoteHash(root, context.branchRef, context, 'STATE_PUBLISH') !== head) {
        throw new SyncError('STATE_PUBLISH', 'The workflow branch changed before the COROS upload intent was cleared.');
    }
    if (stagedPaths(root, context).length) {
        throw new SyncError('STATE_PUBLISH', 'Unrelated staged changes prevent clearing the COROS upload intent.');
    }

    await clearUploadIntent(root);
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', UPLOAD_INTENT_PATH], context.env);
    if (tracked.status === 1) return;
    if (tracked.status !== 0) {
        throw new SyncError('STATE_PUBLISH', 'Git could not inspect the COROS upload intent before clearing it.');
    }
    const clearedCommit = await createCheckpointCommit(root, context, head,
        'Clear COROS Upload Intent', 'deletion');
    publishCheckpointCommit(root, context, head, clearedCommit, 'clearing the upload intent');
}
