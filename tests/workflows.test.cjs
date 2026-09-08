const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
require('ts-node/register/transpile-only');
const { DAILY_TRANSFER_LIMIT, MIGRATION_TRANSFER_LIMIT } = require('../src/cli/bridge');
const { SECRET_NAMES } = require('../src/cli/config');

const root = path.resolve(__dirname, '..');
const schedules = {
    'garmin_cn_to_garmin_global': '0 */6 * * *',
    'garmin_global_to_garmin_cn': '0 1,7,13,19 * * *',
    'garmin_cn_to_coros': '0 2,8,14,20 * * *',
    'coros_cn_to_garmin_cn': '0 3,9,15,21 * * *',
};

async function workflow(filename) {
    const source = await fs.readFile(path.join(root, '.github', 'workflows', filename), 'utf8');
    return { source, value: YAML.parse(source) };
}

test('all eight callers retain their schedules, limits and shared account lock without write access', async () => {
    for (const [route, schedule] of Object.entries(schedules)) {
        for (const mode of ['sync', 'migrate']) {
            const { value } = await workflow(`${mode}_${route}.yml`);
            assert.ok(value.on.workflow_dispatch !== undefined);
            assert.equal(value.on.push, undefined);
            assert.deepEqual(value.on.schedule, mode === 'sync' ? [{ cron: schedule }] : undefined);
            assert.deepEqual(value.concurrency, { group: 'dailysync-activity-accounts', 'cancel-in-progress': false });
            assert.deepEqual(value.permissions, { contents: 'read' });
            const job = value.jobs[mode];
            assert.equal(job.uses, './.github/workflows/_run_dailysync.yml');
            const names = ['GARMIN_USERNAME', 'GARMIN_PASSWORD', 'GARMIN_OAUTH1', 'GH_SECRETS_TOKEN'];
            if (route.includes('global')) names.push('GARMIN_GLOBAL_USERNAME', 'GARMIN_GLOBAL_PASSWORD', 'GARMIN_GLOBAL_OAUTH1');
            else names.push('COROS_USERNAME', 'COROS_PASSWORD');
            assert.deepEqual(Object.keys(job.secrets).sort(), names.sort());
            for (const name of names) assert.equal(job.secrets[name], `\${{ secrets.${name} }}`);
        }
    }
});

test('runner uses Node 24, encrypted OAuth2 caches, no repository writes and six-hour jobs', async () => {
    const { source, value } = await workflow('_run_dailysync.yml');
    const job = value.jobs.run;
    assert.equal(job['timeout-minutes'], 360);
    assert.deepEqual(value.permissions, { contents: 'read' });
    assert.equal(job.steps.find(step => step.uses === 'actions/checkout@v6').with['persist-credentials'], false);
    assert.ok(job.steps.some(step => step.uses === 'pnpm/action-setup@v6'));
    assert.equal(job.steps.find(step => step.uses === 'actions/setup-node@v6').with['node-version'], '24.20.0');
    assert.equal(job.steps.find(step => step.id === 'synchronization')['continue-on-error'], true);
    assert.equal(job.steps.find(step => step.id === 'synchronization').env.GH_SECRETS_TOKEN, '${{ secrets.GH_SECRETS_TOKEN }}');
    assert.match(source, /pnpm run "\$COMMAND" "\$\{args\[@\]\}"/);
    assert.doesNotMatch(source, /git (?:add|commit|push)|garmin\.db|contents: write|upload-artifact/);
    assert.deepEqual(Object.keys(value.on.workflow_call.secrets).sort(), [...SECRET_NAMES].sort());

    const restores = job.steps.filter(step => step.uses === 'actions/cache/restore@v5');
    const saves = job.steps.filter(step => step.uses === 'actions/cache/save@v5');
    assert.equal(restores.length, 2);
    assert.equal(saves.length, 2);
    for (const step of [...restores, ...saves]) {
        assert.match(step.with.path, /^\.local\/oauth2\/garmin-(?:cn|global)\.json$/);
        assert.equal(step['continue-on-error'], true);
    }
    for (const step of restores) {
        assert.match(step.with['restore-keys'], /cache_keys.outputs.(?:cn|global)_prefix/);
    }
    for (const step of saves) {
        assert.match(step.if, /^always\(\)/);
        assert.match(step.if, /_hash != steps.cache_before.outputs/);
        assert.match(step.with.key, /cache_after.outputs.(?:cn|global)_key/);
    }
    assert.match(job.steps.find(step => step.id === 'cache_after').if, /^always\(\)/);
    assert.match(job.steps.at(-1).if, /synchronization.outcome == 'failure'/);
    assert.equal(job.steps.at(-1).run, 'exit 1');
});

test('CI and the project use the same Node 24 release', async () => {
    const { value } = await workflow('ci.yml');
    assert.equal(value.jobs.test.steps.find(step => step.uses === 'actions/setup-node@v6').with['node-version'], '24.20.0');
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.engines.node, '>=24.20.0');
});

test('daily and migration limits remain 10 and 100 with four commands each', async () => {
    assert.equal(DAILY_TRANSFER_LIMIT, 10);
    assert.equal(MIGRATION_TRANSFER_LIMIT, 100);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const commands = Object.keys(pkg.scripts);
    assert.equal(commands.filter(name => name.startsWith('sync:')).length, 4);
    assert.equal(commands.filter(name => name.startsWith('migrate:')).length, 4);
    assert.equal(pkg.dependencies.sqlite, undefined);
    assert.equal(pkg.dependencies.sqlite3, undefined);
});

test('the environment template lists the six accounts plus only three Session Secrets', async () => {
    const names = (await fs.readFile(path.join(root, '.env.example'), 'utf8'))
        .split(/\r?\n/).filter(Boolean).map(line => line.split('=')[0]);
    assert.deepEqual(names, [...SECRET_NAMES]);
    assert.equal(names.length, 9);
});
