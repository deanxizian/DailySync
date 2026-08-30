require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseOptions, loadPrivateEnv, requireBridgeAccounts } = require('../../src/sync/config');
const { main, acquireAccountLock } = require('../../src/bridge');

const settings = ['COROS_USERNAME', 'COROS_PASSWORD', 'GARMIN_USERNAME', 'GARMIN_PASSWORD', 'AESKEY',
    'GARMIN_SYNC_NUM', 'GARMIN_MIGRATE_NUM', 'GARMIN_MIGRATE_START', 'GARMIN_MIGRATE_AUTO_PAGE', 'GITHUB_ACTIONS'];

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
    return root;
}

test('CLI accepts only migration and synchronization execution options', () => {
    assert.deepEqual(parseOptions([]), { json: false, help: false });
    assert.deepEqual(parseOptions(['--activity-id', '123', '--json']),
        { json: true, help: false, activityId: '123' });
    assert.equal(parseOptions(['--migrate-start', '101']).migrateStart, 101);
    assert.equal(parseOptions(['--time-budget=300']).timeBudget, 300);
    for (const args of [['--apply'], ['state'], ['--route', 'garmin-to-coros'], ['--migrate-start', '-1'],
        ['--migrate-start', '1.2'], ['--time-budget', '1'], ['--activity-id', '../../file'], ['--json=false'],
        ['--json', '--json'], ['--unknown']]) {
        assert.throws(() => parseOptions(args), { code: args.includes('../../file') ? 'PROTOCOL' : 'USAGE' }, JSON.stringify(args));
    }
});

test('migration and daily sync keep separate option sets', async () => {
    await assert.rejects(main('migration', ['--activity-id', '123']), { code: 'USAGE' });
    await assert.rejects(main('sync', ['--migrate-start', '1']), { code: 'USAGE' });
    assert.equal(await main('migration', ['--help']), 0);
    assert.equal(await main('sync', ['--help']), 0);
});

test('local runs lock each COROS account without touching tracked files', async t => {
    const root = await fixture(t);
    const locks = path.join(root, '.local');
    await fs.mkdir(locks, { mode: 0o700 });

    const releaseFirst = await acquireAccountLock(locks, 'PERSONAL@example.invalid');
    await assert.rejects(acquireAccountLock(locks, 'personal@example.invalid'), { code: 'LOCK_HELD' });

    const releaseOther = await acquireAccountLock(locks, 'other@example.invalid');
    await releaseOther();
    await releaseFirst();

    const releaseAgain = await acquireAccountLock(locks, 'personal@example.invalid');
    await releaseAgain();
    assert.deepEqual(await fs.readdir(locks), []);
});

test('local runs reclaim a lock whose owner process has exited', async t => {
    const root = await fixture(t);
    const locks = path.join(root, '.local');
    await fs.mkdir(locks, { mode: 0o700 });
    await acquireAccountLock(locks, 'personal@example.invalid');
    const [filename] = await fs.readdir(locks);
    await fs.writeFile(path.join(locks, filename), JSON.stringify({
        token: 'stale', pid: 2147483647, createdAt: new Date(0).toISOString(),
    }));

    const release = await acquireAccountLock(locks, 'personal@example.invalid');
    await release();
    assert.deepEqual(await fs.readdir(locks), []);
});

test('a failed lock initialization removes the file it created', async t => {
    const root = await fixture(t);
    const locks = path.join(root, '.local');
    await fs.mkdir(locks, { mode: 0o700 });
    const open = fs.open;
    fs.open = async (...args) => {
        const handle = await open(...args);
        return { writeFile: async () => { throw new Error('test write failure'); },
            sync: handle.sync.bind(handle), close: handle.close.bind(handle) };
    };
    try {
        await assert.rejects(acquireAccountLock(locks, 'personal@example.invalid'), { code: 'LOCK_CREATE' });
    } finally {
        fs.open = open;
    }
    assert.deepEqual(await fs.readdir(locks), []);
});

test('private env file is permission-checked and never requires a Garmin password', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'coros-sync'));
    await fs.writeFile(path.join(root, '.env'), 'COROS_USERNAME=legacy\nGARMIN_PASSWORD=must-not-load\n');
    await fs.writeFile(path.join(root, 'coros-sync', '.env.local'),
        'COROS_USERNAME="personal@example.invalid"\nCOROS_PASSWORD="password#not-comment"\nGARMIN_USERNAME=garmin@example.invalid\n',
        { mode: 0o600 });
    const env = { COROS_USERNAME: 'secret-wins' };
    loadPrivateEnv(root, env);
    assert.deepEqual(env, { COROS_USERNAME: 'secret-wins', COROS_PASSWORD: 'password#not-comment',
        GARMIN_USERNAME: 'garmin@example.invalid' });
    requireBridgeAccounts(env);
    assert.equal(env.GARMIN_PASSWORD, undefined);
    if (process.platform !== 'win32') {
        await fs.chmod(path.join(root, 'coros-sync', '.env.local'), 0o644);
        assert.throws(() => loadPrivateEnv(root, {}), { code: 'CONFIG' });
    }
    assert.throws(() => requireBridgeAccounts({ GARMIN_USERNAME: 'x' }),
        error => error.code === 'CONFIG' && error.message.includes('COROS_PASSWORD'));
});

test('pagination settings reject unsafe values before any network request', async t => {
    const root = await fixture(t);
    Object.assign(process.env, { GARMIN_USERNAME: 'garmin@example.invalid', COROS_USERNAME: 'coros@example.invalid',
        COROS_PASSWORD: 'password' });

    process.env.GARMIN_SYNC_NUM = '1001';
    await assert.rejects(main('sync', [], root), { code: 'CONFIG' });
    delete process.env.GARMIN_SYNC_NUM;
    process.env.GARMIN_MIGRATE_AUTO_PAGE = 'flase';
    await assert.rejects(main('migration', [], root), { code: 'CONFIG' });
    delete process.env.GARMIN_MIGRATE_AUTO_PAGE;
    process.env.GARMIN_MIGRATE_START = 'not-a-number';
    await assert.rejects(main('migration', [], root), { code: 'CONFIG' });
});

test('runtime code has no persistent synchronization-state dependency', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '../../src/bridge.ts'), 'utf8');
    for (const term of ['checkpoint', 'SyncState', 'upload-intent', 'release-checkpoint', 'git-checkpoint', 'git push', 'git commit']) {
        assert.equal(source.includes(term), false, term);
    }
});

test('only daily sync gets the default GitHub Actions time budget', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '../../src/bridge.ts'), 'utf8');
    assert.match(source, /profile === 'sync' && process\.env\.GITHUB_ACTIONS === 'true' \? 2700 : undefined/);
});
