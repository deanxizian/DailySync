require('ts-node/register/transpile-only');
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runBridge } = require('../src/cli/bridge');
const { garminAccountHash } = require('../src/core/account');
const { SyncError } = require('../src/core/errors');
const { GarminAdapter } = require('../src/platforms/garmin');
const { GarminSessionStore, sessionSettings } = require('../src/state/garmin-session');
const { GitHubSecrets } = require('../src/state/github-secrets');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-bridge-'));
    t.after(() => { mock.restoreAll(); return fs.rm(root, { recursive: true, force: true }); });
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GH_SECRETS_TOKEN: 'test-pat',
        GARMIN_USERNAME: 'cn@example.invalid', GARMIN_PASSWORD: 'cn-password',
        GARMIN_GLOBAL_USERNAME: 'global@example.invalid', GARMIN_GLOBAL_PASSWORD: 'global-password' };
    for (const slot of ['garmin-cn', 'garmin-global']) {
        const settings = sessionSettings(slot, env);
        env[settings.secretName] = JSON.stringify({ version: 1, loginHash: garminAccountHash(slot, settings.username),
            oauth1: { oauth_token: `${slot}-old`, oauth_token_secret: 'old-secret' } });
    }
    const trace = [], exported = new Map(), writes = [];
    mock.method(GitHubSecrets.prototype, 'check', async () => { trace.push('check-pat'); });
    mock.method(GitHubSecrets.prototype, 'set', async function (name, value) {
        trace.push(`save-${name}`); writes.push({ name, value });
    });
    mock.method(GarminAdapter.prototype, 'connect', async function (saved) {
        trace.push(`connect-${this.slot}`);
        const current = { loginHash: saved.loginHash, token: {
            oauth1: { oauth_token: `${this.slot}-new`, oauth_token_secret: 'new-secret' },
            oauth2: { access_token: 'short-token', expires_at: Math.floor(Date.now() / 1000) + 3600 },
        } };
        exported.set(this.slot, current);
        await this.options.onSession(current);
        return this.slot;
    });
    mock.method(GarminAdapter.prototype, 'exportSession', function () { return exported.get(this.slot); });
    mock.method(GarminAdapter.prototype, 'page', async function () {
        trace.push(`page-${this.slot}`);
        return { activities: [], next: null };
    });
    mock.method(GarminAdapter.prototype, 'upload', async () => { throw new Error('Unexpected upload'); });
    return { root, env, trace, exported, writes };
}

test('bridge persists both verified OAuth1 Secrets before scanning any activities', async t => {
    const f = await fixture(t);
    const result = await runBridge(f.root, 'garmin-cn-to-garmin-global', 'sync', undefined, f.env);
    assert.equal(result.counts.uploaded, 0);
    assert.equal(f.writes.length, 2);
    const firstScan = f.trace.findIndex(value => value.startsWith('page-'));
    assert.ok(firstScan > f.trace.indexOf('save-GARMIN_OAUTH1'));
    assert.ok(firstScan > f.trace.indexOf('save-GARMIN_GLOBAL_OAUTH1'));
    assert.deepEqual(await fs.readdir(path.join(f.root, '.local', 'runs')), []);
    await assert.rejects(fs.access(path.join(f.root, 'db')));
});

test('bridge saves a refreshed OAuth2 even after a later activity scan fails', async t => {
    const f = await fixture(t);
    mock.method(GarminAdapter.prototype, 'page', async function () {
        f.exported.get(this.slot).token.oauth2.access_token = 'refreshed-before-failure';
        throw new SyncError('SCAN_INCOMPLETE', 'Scan failed.');
    });
    await assert.rejects(runBridge(f.root, 'garmin-cn-to-garmin-global', 'sync', undefined, f.env), { code: 'SCAN_INCOMPLETE' });
    const settings = sessionSettings('garmin-cn', f.env);
    settings.secret = f.writes.find(write => write.name === settings.secretName).value;
    const saved = await new GarminSessionStore(f.root, settings, { actions: true }).load();
    assert.equal(saved.token.oauth2.access_token, 'refreshed-before-failure');
    assert.equal(f.writes.length, 2);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.local', 'runs')), []);
});

test('bridge blocks activity access when the durable OAuth1 Secret cannot be saved', async t => {
    const f = await fixture(t);
    mock.method(GitHubSecrets.prototype, 'set', async () => { throw new SyncError('GITHUB_SECRETS', 'Cannot save.'); });
    await assert.rejects(runBridge(f.root, 'garmin-cn-to-garmin-global', 'migration', undefined, f.env), { code: 'GITHUB_SECRETS' });
    assert.equal(f.trace.some(value => value.startsWith('page-')), false);
    await assert.rejects(fs.access(path.join(f.root, '.local', 'oauth2')));
});

test('bridge rejects an unavailable PAT before connecting to Garmin', async t => {
    const f = await fixture(t);
    mock.method(GitHubSecrets.prototype, 'check', async () => { throw new SyncError('GITHUB_SECRETS', 'Token expired.'); });
    await assert.rejects(runBridge(f.root, 'garmin-cn-to-garmin-global', 'sync', undefined, f.env), { code: 'GITHUB_SECRETS' });
    assert.equal(f.trace.some(value => value.startsWith('connect-')), false);
});
