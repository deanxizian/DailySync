require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadPrivateEnvironment, parseMode, parseRoute, parseRunOptions, parseSessionOptions,
    SECRET_NAMES } = require('../src/cli/config');
const { withRunLock } = require('../src/cli/lock');

async function directory(t) {
    const result = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-cli-'));
    t.after(() => fs.rm(result, { recursive: true, force: true }));
    return result;
}

test('CLI accepts only four fixed routes, two fixed modes and an optional activity ID', () => {
    for (const route of ['garmin-cn-to-garmin-global', 'garmin-global-to-garmin-cn',
        'garmin-cn-to-coros-cn', 'coros-cn-to-garmin-cn']) assert.equal(parseRoute(route), route);
    assert.equal(parseMode('sync'), 'sync');
    assert.equal(parseMode('migration'), 'migration');
    assert.deepEqual(parseRunOptions(['--activity-id', '123', '--json']),
        { activityId: '123', json: true, help: false });
    assert.throws(() => parseRunOptions(['--transfer-limit', '1']), { code: 'USAGE' });
    assert.throws(() => parseRunOptions(['--activity-id', '1', '--activity-id', '2']), { code: 'USAGE' });
    assert.throws(() => parseRoute('garmin-global-to-coros-cn'), { code: 'USAGE' });
});

test('Session maintenance accepts one explicit region and one reset confirmation', () => {
    assert.deepEqual(parseSessionOptions(['--region', 'cn']), { region: 'CN', confirmReset: false });
    assert.deepEqual(parseSessionOptions(['--confirm-reset', '--region', 'GLOBAL']),
        { region: 'GLOBAL', confirmReset: true });
    assert.throws(() => parseSessionOptions(['--region', 'CN', '--region', 'GLOBAL']), { code: 'USAGE' });
    assert.throws(() => parseSessionOptions(['--region', 'CN', '--confirm-reset', '--confirm-reset']),
        { code: 'USAGE' });
    assert.throws(() => parseSessionOptions(['CN']), { code: 'USAGE' });
});

test('private env loading imports only the six account settings', async t => {
    const root = await directory(t);
    const lines = [...SECRET_NAMES.map((name, index) => `${name}=value-${index}`),
        'UNRELATED_SETTING=ignored'];
    await fs.writeFile(path.join(root, '.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
    const env = {};
    loadPrivateEnvironment(root, env);
    assert.deepEqual(Object.keys(env), [...SECRET_NAMES]);
    assert.equal(env.UNRELATED_SETTING, undefined);
});

test('credential files with broad permissions are rejected', async t => {
    if (process.platform === 'win32') return;
    const root = await directory(t);
    await fs.writeFile(path.join(root, '.env'), 'GARMIN_USERNAME=test\n', { mode: 0o644 });
    assert.throws(() => loadPrivateEnvironment(root, {}), { code: 'CONFIG' });
});

test('the local account lock serializes every direction and never steals a stale lock', async t => {
    const root = await directory(t);
    let release;
    const first = withRunLock(root, () => new Promise(resolve => { release = resolve; }));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(withRunLock(root, async () => undefined), { code: 'LOCKED' });
    release('done');
    assert.equal(await first, 'done');
    assert.equal(await withRunLock(root, async () => 'next'), 'next');

    const lock = path.join(root, '.local', 'locks', 'activity-sync.lock');
    await fs.writeFile(lock, 'stale\n', { mode: 0o600 });
    await assert.rejects(withRunLock(root, async () => undefined), { code: 'LOCKED' });
});
