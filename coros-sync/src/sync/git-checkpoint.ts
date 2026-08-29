import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { SyncError } from './errors';
import { GarminDbState, initializeStateDatabase } from './state';
import { emptyState, UploadIntent } from './types';
import { clearUploadIntent, COROS_STATE_DB_PATH, mergeUploadIntent, readUploadIntent,
    UPLOAD_INTENT_PATH, writeUploadIntent } from './upload-intent';
import { migrateLegacyCorosState } from './legacy-state';

const DEFAULT_LOCK_REF = 'refs/heads/codex/garmin-db-writer-lock';
export const COROS_STATE_REF = 'refs/heads/codex/coros-sync-state';
export const COROS_STATE_MARKER_REF = 'refs/heads/codex/coros-sync-state-initialized';
const SNAPSHOT_STATE_PATH = 'coros-state.db';
const SNAPSHOT_INTENT_PATH = 'upload-intent.enc';
const MARKER_PATH = 'initialized';
const MARKER_PAYLOAD = 'dailysync-coros-sync-state-v1\n';
const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_STATE_BYTES = 48 * 1024 * 1024;
const MAX_INTENT_BYTES = 512 * 1024;

interface StateGitContext {
    stateRef: string;
    markerRef: string;
    env: NodeJS.ProcessEnv;
}

interface ActionGitContext extends StateGitContext {
    lockRef: string;
    lockCommit: string;
}

interface RestoredState {
    context: ActionGitContext;
    commit: string;
    marker: string;
}

const restoredStates = new Map<string, RestoredState>();

function git(root: string, args: string[], env: NodeJS.ProcessEnv) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT });
    if (result.error) throw new SyncError('STATE_PUBLISH', 'Cannot run Git while managing the COROS state snapshot.');
    return result;
}

function output(result: ReturnType<typeof spawnSync>): string {
    return typeof result.stdout === 'string' ? result.stdout : '';
}

function gitOutput(root: string, args: string[], context: StateGitContext, code = 'STATE_PUBLISH'): string {
    const result = git(root, args, context.env);
    if (result.status !== 0) throw new SyncError(code, 'Git could not manage the COROS state snapshot.');
    return output(result).trim();
}

function gitBlob(root: string, commit: string, filename: string, context: StateGitContext): Buffer {
    const result = spawnSync('git', ['show', `${commit}:${filename}`], {
        cwd: root, env: context.env, encoding: null, maxBuffer: MAX_GIT_OUTPUT,
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
        throw new SyncError('STATE_INVALID', 'The remote COROS state snapshot cannot be read.');
    }
    return result.stdout;
}

function stateContext(root: string, environment: NodeJS.ProcessEnv): StateGitContext {
    const env = environment === process.env ? process.env : { ...process.env, ...environment };
    if (git(root, ['check-ref-format', COROS_STATE_REF], env).status !== 0 ||
        git(root, ['check-ref-format', COROS_STATE_MARKER_REF], env).status !== 0) {
        throw new SyncError('STATE_INVALID', 'The COROS state references are invalid.');
    }
    return { stateRef: COROS_STATE_REF, markerRef: COROS_STATE_MARKER_REF, env };
}

function actionContext(root: string, environment: NodeJS.ProcessEnv): ActionGitContext | undefined {
    if (environment.GITHUB_ACTIONS !== 'true') return undefined;
    const context = stateContext(root, environment);
    const lockRef = environment.GARMIN_DB_LOCK_REF || DEFAULT_LOCK_REF;
    const lockCommit = environment.GARMIN_DB_LOCK_COMMIT ?? '';
    if (git(root, ['check-ref-format', lockRef], context.env).status !== 0 ||
        [context.stateRef, context.markerRef].includes(lockRef) || !HASH.test(lockCommit)) {
        throw new SyncError('STATE_PUBLISH', 'The COROS state reference or Garmin database lock identity is invalid.');
    }
    return { ...context, lockRef, lockCommit };
}

function remoteHash(root: string, ref: string, context: StateGitContext, code: string): string | undefined {
    const result = git(root, ['ls-remote', '--exit-code', 'origin', ref], context.env);
    if (result.status === 2) return undefined;
    if (result.status !== 0) throw new SyncError(code, 'Cannot confirm the remote COROS state.');
    const lines = output(result).trim().split('\n').filter(Boolean);
    if (lines.length !== 1) throw new SyncError(code, 'The remote COROS state is ambiguous.');
    const fields = lines[0].split(/\s+/);
    if (fields.length !== 2 || fields[1] !== ref || !HASH.test(fields[0])) {
        throw new SyncError(code, 'The remote COROS state reference is invalid.');
    }
    return fields[0];
}

function fetchStableRef(root: string, ref: string, context: StateGitContext, missing: string): string {
    const before = remoteHash(root, ref, context, 'STATE_INVALID');
    if (!before) throw new SyncError('STATE_MISSING', missing);
    const fetched = git(root, ['fetch', '--quiet', '--no-tags', 'origin', ref], context.env);
    if (fetched.status !== 0) throw new SyncError('STATE_INVALID', 'The remote COROS state cannot be fetched.');
    const commit = gitOutput(root, ['rev-parse', '--verify', 'FETCH_HEAD'], context, 'STATE_INVALID');
    if (commit !== before || remoteHash(root, ref, context, 'STATE_INVALID') !== before) {
        throw new SyncError('STATE_CONFLICT', 'The remote COROS state changed while it was being restored.');
    }
    return commit;
}

function assertRemoteLock(root: string, context: ActionGitContext, position: string): void {
    if (remoteHash(root, context.lockRef, context, 'LOCK_LOST') !== context.lockCommit) {
        throw new SyncError('LOCK_LOST', `The Action lost the remote Garmin database writer lock ${position}.`);
    }
}

function restoredState(root: string, context: ActionGitContext): RestoredState {
    const restored = restoredStates.get(path.resolve(root));
    if (!restored || restored.context.stateRef !== context.stateRef ||
        restored.context.markerRef !== context.markerRef || restored.context.lockRef !== context.lockRef ||
        restored.context.lockCommit !== context.lockCommit) {
        throw new SyncError('STATE_MISSING', 'The Action did not restore an owned COROS state snapshot.');
    }
    return restored;
}

async function replaceFile(filename: string, payload: Buffer): Promise<void> {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename);
        await fs.chmod(filename, 0o600);
    } catch (_) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw new SyncError('STATE_INVALID', 'The remote COROS state snapshot cannot be restored locally.');
    }
}

function rootFiles(root: string, commit: string, context: StateGitContext): string[] {
    const parents = gitOutput(root, ['rev-list', '--parents', '-n', '1', commit], context, 'STATE_INVALID').split(/\s+/);
    if (parents.length !== 1 || parents[0] !== commit) {
        throw new SyncError('STATE_INVALID', 'The COROS state reference must contain a parentless commit.');
    }
    const result = git(root, ['ls-tree', '-r', '--name-only', '-z', commit], context.env);
    if (result.status !== 0) throw new SyncError('STATE_INVALID', 'The COROS state tree cannot be read.');
    return output(result).split('\0').filter(Boolean).sort();
}

function validateMarker(root: string, context: StateGitContext): string {
    const commit = fetchStableRef(root, context.markerRef, context,
        'The COROS state initialization marker is missing.');
    const files = rootFiles(root, commit, context);
    if (files.length !== 1 || files[0] !== MARKER_PATH ||
        gitBlob(root, commit, MARKER_PATH, context).toString('utf8') !== MARKER_PAYLOAD) {
        throw new SyncError('STATE_INVALID', 'The COROS state initialization marker is invalid.');
    }
    return commit;
}

async function restoreSnapshot(root: string, context: StateGitContext): Promise<string> {
    const commit = fetchStableRef(root, context.stateRef, context,
        'The initialized COROS state snapshot is missing; uploads are disabled.');
    const files = rootFiles(root, commit, context);
    const allowed = files.length === 1 && files[0] === SNAPSHOT_STATE_PATH ||
        files.length === 2 && files[0] === SNAPSHOT_STATE_PATH && files[1] === SNAPSHOT_INTENT_PATH;
    if (!allowed) throw new SyncError('STATE_INVALID', 'The COROS state snapshot contains unexpected files.');
    const database = gitBlob(root, commit, SNAPSHOT_STATE_PATH, context);
    if (database.length < 100 || database.length > MAX_STATE_BYTES) {
        throw new SyncError('STATE_INVALID', 'The remote COROS state database size is invalid.');
    }
    await replaceFile(path.join(root, COROS_STATE_DB_PATH), database);
    if (files.includes(SNAPSHOT_INTENT_PATH)) {
        const intent = gitBlob(root, commit, SNAPSHOT_INTENT_PATH, context);
        if (!intent.length || intent.length > MAX_INTENT_BYTES) {
            throw new SyncError('STATE_INVALID', 'The remote COROS upload intent size is invalid.');
        }
        await replaceFile(path.join(root, UPLOAD_INTENT_PATH), intent);
    } else {
        await clearUploadIntent(root);
    }
    return commit;
}

export async function restoreCorosState(root: string,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const action = actionContext(root, environment);
    const context = action ?? stateContext(root, environment);
    if (action) assertRemoteLock(root, action, 'before restoring the COROS state');
    const marker = validateMarker(root, context);
    const commit = await restoreSnapshot(root, context);
    if (remoteHash(root, context.markerRef, context, 'STATE_CONFLICT') !== marker) {
        throw new SyncError('STATE_CONFLICT', 'The COROS state initialization marker changed during restoration.');
    }
    if (action) {
        assertRemoteLock(root, action, 'after restoring the COROS state');
        restoredStates.set(path.resolve(root), { context: action, commit, marker });
    }
}

function createRootCommit(root: string, entries: string[], message: string, context: StateGitContext): string {
    const treeResult = spawnSync('git', ['mktree'], { cwd: root, env: context.env, encoding: 'utf8',
        input: `${entries.sort().join('\n')}\n`, maxBuffer: MAX_GIT_OUTPUT });
    if (treeResult.error || treeResult.status !== 0 || !HASH.test(output(treeResult).trim())) {
        throw new SyncError('STATE_PUBLISH', 'The COROS state snapshot tree cannot be created.');
    }
    const identity = { ...context.env,
        GIT_AUTHOR_NAME: 'DailySync State', GIT_AUTHOR_EMAIL: 'actions@github.com',
        GIT_COMMITTER_NAME: 'DailySync State', GIT_COMMITTER_EMAIL: 'actions@github.com' };
    const commit = git(root, ['commit-tree', output(treeResult).trim(), '-m', message], identity);
    if (commit.status !== 0 || !HASH.test(output(commit).trim())) {
        throw new SyncError('STATE_PUBLISH', 'The COROS state snapshot commit cannot be created.');
    }
    return output(commit).trim();
}

async function createSnapshotCommit(root: string, context: StateGitContext): Promise<string> {
    const database = path.join(root, COROS_STATE_DB_PATH);
    const stat = await fs.stat(database).catch(() => undefined);
    if (!stat?.isFile() || stat.size < 100 || stat.size > MAX_STATE_BYTES) {
        throw new SyncError('STATE_PUBLISH', 'The local COROS state database is missing or has an invalid size.');
    }
    const stateBlob = gitOutput(root, ['hash-object', '-w', '--', database], context);
    if (!HASH.test(stateBlob)) throw new SyncError('STATE_PUBLISH', 'The COROS state database object is invalid.');
    const entries = [`100644 blob ${stateBlob}\t${SNAPSHOT_STATE_PATH}`];
    const intent = path.join(root, UPLOAD_INTENT_PATH);
    try {
        const intentStat = await fs.stat(intent);
        if (!intentStat.isFile() || !intentStat.size || intentStat.size > MAX_INTENT_BYTES) throw new Error();
        const intentBlob = gitOutput(root, ['hash-object', '-w', '--', intent], context);
        if (!HASH.test(intentBlob)) throw new Error();
        entries.push(`100644 blob ${intentBlob}\t${SNAPSHOT_INTENT_PATH}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new SyncError('STATE_PUBLISH', 'The local COROS upload intent cannot be inspected.');
        }
    }
    return createRootCommit(root, entries, 'COROS Sync State Snapshot', context);
}

function createMarkerCommit(root: string, context: StateGitContext): string {
    const blobResult = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, env: context.env,
        encoding: 'utf8', input: MARKER_PAYLOAD, maxBuffer: MAX_GIT_OUTPUT });
    const blob = output(blobResult).trim();
    if (blobResult.error || blobResult.status !== 0 || !HASH.test(blob)) {
        throw new SyncError('STATE_PUBLISH', 'The COROS state initialization marker cannot be created.');
    }
    return createRootCommit(root, [`100644 blob ${blob}\t${MARKER_PATH}`],
        'Initialize COROS Sync State', context);
}

async function validateLocalState(root: string, aesKey?: string): Promise<void> {
    const database = path.join(root, COROS_STATE_DB_PATH);
    const store = aesKey ? await GarminDbState.open(database, false, aesKey) : await GarminDbState.open(database, false);
    try {
        const state = await store.load();
        if (!state) throw new SyncError('STATE_INVALID', 'The COROS state database has no saved state.');
        const intent = await readUploadIntent(root, aesKey);
        if (intent) mergeUploadIntent(state, intent);
    } finally { await store.close(); }
}

export async function initializeCorosState(root: string,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (!context) throw new SyncError('STATE_PUBLISH', 'COROS shared state can only be initialized by GitHub Actions.');
    assertRemoteLock(root, context, 'before initializing the COROS state');
    const existingMarker = remoteHash(root, context.markerRef, context, 'STATE_INVALID');
    let stateCommit = remoteHash(root, context.stateRef, context, 'STATE_INVALID');
    if (existingMarker) {
        validateMarker(root, context);
        if (!stateCommit) throw new SyncError('STATE_MISSING', 'The initialized COROS state snapshot is missing.');
        throw new SyncError('STATE_CONFLICT', 'The COROS state has already been initialized.');
    }

    if (stateCommit) {
        stateCommit = await restoreSnapshot(root, context);
    } else {
        await fs.rm(path.join(root, COROS_STATE_DB_PATH), { force: true });
        await clearUploadIntent(root);
        if (!await migrateLegacyCorosState(root, environment.AESKEY)) {
            const database = path.join(root, COROS_STATE_DB_PATH);
            await initializeStateDatabase(database);
            const store = environment.AESKEY ? await GarminDbState.open(database, true, environment.AESKEY) :
                await GarminDbState.open(database, true);
            try { await store.save(emptyState()); } finally { await store.close(); }
        }
        await validateLocalState(root, environment.AESKEY);
        const initial = await createSnapshotCommit(root, context);
        git(root, ['push', '--porcelain', `--force-with-lease=${context.stateRef}:`,
            'origin', `${initial}:${context.stateRef}`], context.env);
        const published = remoteHash(root, context.stateRef, context, 'STATE_PUBLISH');
        if (published !== initial) {
            throw new SyncError(published ? 'STATE_CONFLICT' : 'STATE_PUBLISH',
                'The COROS state snapshot could not be initialized.');
        }
        stateCommit = initial;
    }

    await validateLocalState(root, environment.AESKEY);
    assertRemoteLock(root, context, 'before publishing the COROS state initialization marker');
    if (remoteHash(root, context.stateRef, context, 'STATE_CONFLICT') !== stateCommit ||
        remoteHash(root, context.markerRef, context, 'STATE_CONFLICT')) {
        throw new SyncError('STATE_CONFLICT', 'The COROS state changed during initialization.');
    }
    const marker = createMarkerCommit(root, context);
    git(root, ['push', '--porcelain', `--force-with-lease=${context.markerRef}:`,
        'origin', `${marker}:${context.markerRef}`], context.env);
    if (remoteHash(root, context.markerRef, context, 'STATE_PUBLISH') !== marker) {
        throw new SyncError('STATE_PUBLISH', 'The COROS state initialization marker was not published.');
    }
    if (validateMarker(root, context) !== marker ||
        remoteHash(root, context.stateRef, context, 'STATE_CONFLICT') !== stateCommit) {
        throw new SyncError('STATE_CONFLICT', 'The COROS state changed while initialization was completed.');
    }
    assertRemoteLock(root, context, 'after initializing the COROS state');
}

async function publishSnapshot(root: string, context: ActionGitContext, action: string): Promise<void> {
    const restored = restoredState(root, context);
    assertRemoteLock(root, context, `before ${action}`);
    if (remoteHash(root, context.markerRef, context, 'STATE_CONFLICT') !== restored.marker ||
        remoteHash(root, context.stateRef, context, 'STATE_CONFLICT') !== restored.commit) {
        throw new SyncError('STATE_CONFLICT', `The remote COROS state changed before ${action}.`);
    }
    const commit = await createSnapshotCommit(root, context);
    git(root, ['push', '--porcelain', `--force-with-lease=${context.stateRef}:${restored.commit}`,
        'origin', `${commit}:${context.stateRef}`], context.env);
    // A transport can report failure after the remote accepted the snapshot, so the remote hash is authoritative.
    if (remoteHash(root, context.stateRef, context, 'STATE_PUBLISH') !== commit) {
        throw new SyncError('STATE_PUBLISH', `The COROS state snapshot was not published while ${action}.`);
    }
    restored.commit = commit;
    if (remoteHash(root, context.markerRef, context, 'STATE_CONFLICT') !== restored.marker) {
        throw new SyncError('STATE_CONFLICT', `The COROS state marker changed while ${action}.`);
    }
    assertRemoteLock(root, context, `after ${action}`);
}

export async function assertRemoteGarminDbLock(root: string,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (context) assertRemoteLock(root, context, 'during COROS synchronization');
}

export async function publishCorosUploadIntent(root: string, intent: UploadIntent,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (context) {
        assertRemoteLock(root, context, 'before writing the COROS upload intent');
        restoredState(root, context);
    }
    await writeUploadIntent(root, intent, environment.AESKEY);
    if (context) await publishSnapshot(root, context, 'publishing the upload intent');
}

export async function clearCorosUploadIntent(root: string,
    environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const context = actionContext(root, environment);
    if (context) {
        assertRemoteLock(root, context, 'before clearing the COROS upload intent');
        restoredState(root, context);
    }
    await clearUploadIntent(root);
    if (context) await publishSnapshot(root, context, 'saving the completed COROS state');
}
