import { spawnSync } from 'child_process';
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
    stageStateAndIntent(root, context, 'publication');
    const commit = git(root, ['-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Save COROS Upload Intent'], context.env);
    if (commit.status !== 0) throw new SyncError('STATE_PUBLISH', 'Git could not commit the COROS upload intent.');
    const intentCommit = gitOutput(root, ['rev-parse', '--verify', 'HEAD'], context);
    if (!HASH.test(intentCommit)) throw new SyncError('STATE_PUBLISH', 'The COROS upload intent commit is invalid.');

    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action lost the remote Garmin database writer lock before publishing.');
    }
    // A transport can report failure after the remote accepted the commit, so the remote hash is authoritative.
    git(root, ['push', '--porcelain', 'origin', `HEAD:${context.branchRef}`], context.env);
    const published = remoteHash(root, context.branchRef, context, 'STATE_PUBLISH');
    if (published !== intentCommit) {
        throw new SyncError('STATE_PUBLISH', 'The COROS upload intent was not published to the workflow branch.');
    }
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action lost the remote Garmin database writer lock after publishing.');
    }
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
    stageStateAndIntent(root, context, 'deletion');
    const commit = git(root, ['-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Clear COROS Upload Intent'], context.env);
    if (commit.status !== 0) throw new SyncError('STATE_PUBLISH', 'Git could not commit the COROS upload intent deletion.');
    const clearedCommit = gitOutput(root, ['rev-parse', '--verify', 'HEAD'], context);
    if (!HASH.test(clearedCommit)) throw new SyncError('STATE_PUBLISH', 'The COROS upload intent deletion commit is invalid.');

    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action lost the remote Garmin database writer lock before clearing the intent.');
    }
    git(root, ['push', '--porcelain', 'origin', `HEAD:${context.branchRef}`], context.env);
    const published = remoteHash(root, context.branchRef, context, 'STATE_PUBLISH');
    if (published !== clearedCommit) {
        throw new SyncError('STATE_PUBLISH', 'The COROS upload intent deletion was not published to the workflow branch.');
    }
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', 'The Action lost the remote Garmin database writer lock after clearing the intent.');
    }
}
