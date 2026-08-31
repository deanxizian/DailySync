const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
require('ts-node/register/transpile-only');
const { DAILY_TRANSFER_LIMIT, MIGRATION_TRANSFER_LIMIT } = require('../src/cli/bridge');
const { SECRET_NAMES } = require('../src/cli/config');

const root = path.resolve(__dirname, '..');
const syncFiles = [
    'sync_garmin_cn_to_garmin_global.yml',
    'sync_garmin_global_to_garmin_cn.yml',
    'sync_garmin_cn_to_coros.yml',
    'sync_coros_cn_to_garmin_cn.yml',
];
const migrationFiles = [
    'migrate_garmin_cn_to_garmin_global.yml',
    'migrate_garmin_global_to_garmin_cn.yml',
    'migrate_garmin_cn_to_coros.yml',
    'migrate_coros_cn_to_garmin_cn.yml',
];
const schedules = {
    'sync_garmin_cn_to_garmin_global.yml': '0 */6 * * *',
    'sync_garmin_global_to_garmin_cn.yml': '0 1,7,13,19 * * *',
    'sync_garmin_cn_to_coros.yml': '0 2,8,14,20 * * *',
    'sync_coros_cn_to_garmin_cn.yml': '0 3,9,15,21 * * *',
};

async function workflow(filename) {
    const source = await fs.readFile(path.join(root, '.github', 'workflows', filename), 'utf8');
    return { source, value: YAML.parse(source) };
}

test('four sync workflows keep the exact staggered schedules and have no push trigger', async () => {
    for (const filename of syncFiles) {
        const { value } = await workflow(filename);
        assert.ok(value.on.workflow_dispatch);
        assert.equal(value.on.push, undefined);
        assert.equal(value.on.schedule.length, 1);
        assert.equal(value.on.schedule[0].cron, schedules[filename]);
        assert.equal(value.concurrency.group, 'dailysync-activity-accounts');
        assert.equal(value.concurrency['cancel-in-progress'], false);
        assert.equal(value.permissions.contents, 'write');
        assert.equal(value.jobs.sync.uses, './.github/workflows/_run_dailysync.yml');
    }
});

test('four migration workflows are manual-only and share the account lock', async () => {
    for (const filename of migrationFiles) {
        const { value } = await workflow(filename);
        assert.ok(value.on.workflow_dispatch !== undefined);
        assert.equal(value.on.schedule, undefined);
        assert.equal(value.on.push, undefined);
        assert.equal(value.concurrency.group, 'dailysync-activity-accounts');
        assert.equal(value.permissions.contents, 'write');
        assert.equal(value.jobs.migrate.uses, './.github/workflows/_run_dailysync.yml');
    }
});

test('every caller supplies both Garmin credentials so Session persistence validates both rows', async () => {
    for (const filename of [...syncFiles, ...migrationFiles]) {
        const { value } = await workflow(filename);
        const job = value.jobs.sync ?? value.jobs.migrate;
        for (const secret of ['GARMIN_USERNAME', 'GARMIN_PASSWORD', 'GARMIN_GLOBAL_USERNAME', 'GARMIN_GLOBAL_PASSWORD']) {
            assert.equal(job.secrets[secret], `\${{ secrets.${secret} }}`, `${filename} is missing ${secret}`);
        }
    }
});

test('the reusable runner uses Node 22, six-hour jobs and a main-only Session commit guard', async () => {
    const { source, value } = await workflow('_run_dailysync.yml');
    const job = value.jobs.run;
    assert.equal(job['timeout-minutes'], 360);
    assert.equal(value.permissions.contents, 'write');
    assert.equal(job.steps.find(step => step.uses === 'actions/setup-node@v4').with['node-version'], '22.13.0');
    assert.equal(job.steps.find(step => step.id === 'synchronization')['continue-on-error'], true);
    const persist = job.steps.find(step => step.name === 'Persist changed Garmin Sessions');
    assert.match(persist.if, /github\.ref == 'refs\/heads\/main'/);
    assert.equal(persist.run, 'bash scripts/commit-garmin-session.sh');
    assert.deepEqual(Object.keys(persist.env).sort(), [
        'GARMIN_GLOBAL_PASSWORD', 'GARMIN_GLOBAL_USERNAME', 'GARMIN_PASSWORD', 'GARMIN_USERNAME',
    ]);
    assert.match(source, /pnpm run "\$COMMAND" "\$\{args\[@\]\}"/);
    assert.doesNotMatch(source, /pnpm run "\$COMMAND" --/);
    assert.doesNotMatch(source, /time-budget|timeout-minutes:\s*45|GARMIN_(?:SYNC|MIGRATE)_/);
    const secretNames = Object.keys(value.on.workflow_call.secrets).sort();
    assert.deepEqual(secretNames, [...SECRET_NAMES].sort());
});

test('daily and migration transfer limits are fixed in code at 10 and 100', async () => {
    assert.equal(DAILY_TRANSFER_LIMIT, 10);
    assert.equal(MIGRATION_TRANSFER_LIMIT, 100);
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const commands = Object.keys(packageJson.scripts).filter(name => /^(?:sync|migrate):/.test(name));
    assert.equal(commands.filter(name => name.startsWith('sync:')).length, 4);
    assert.equal(commands.filter(name => name.startsWith('migrate:')).length, 4);
    assert.equal(Object.values(packageJson.scripts).some(value => /migrate-start|transfer-limit|time-budget/.test(value)), false);
});

test('only the six account Secrets are documented', async () => {
    const names = (await fs.readFile(path.join(root, '.env.example'), 'utf8'))
        .split(/\r?\n/).filter(Boolean).map(line => line.split('=')[0]);
    assert.deepEqual(names, [...SECRET_NAMES]);
});

test('the Session commit script stages one database and never rewrites remote history', async () => {
    const source = await fs.readFile(path.join(root, 'scripts', 'commit-garmin-session.sh'), 'utf8');
    assert.match(source, /git add -- db\/garmin\.db/);
    assert.match(source, /Update Garmin sessions \[skip ci\]/);
    assert.match(source, /git push origin HEAD:main/);
    assert.doesNotMatch(source, /git (?:pull|rebase|reset)|--force|-f\b/);
    assert.equal((source.match(/git add/g) ?? []).length, 1);
});

function command(cwd, executable, args, options = {}) {
    return spawnSync(executable, args, { cwd, encoding: 'utf8', ...options });
}

function successful(cwd, executable, args, options) {
    const result = command(cwd, executable, args, options);
    assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed:\n${result.stderr}`);
    return result.stdout.trim();
}

test('the Session commit guard is silent, path-restricted and rejects non-fast-forward pushes',
    { timeout: 20000 }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-commit-guard-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const remote = path.join(directory, 'remote.git');
        const work = path.join(directory, 'work');
        const bin = path.join(directory, 'bin');
        successful(directory, 'git', ['init', '--bare', remote]);
        await fs.mkdir(path.join(work, 'db'), { recursive: true });
        await fs.mkdir(path.join(work, 'scripts'), { recursive: true });
        await fs.mkdir(bin);
        await fs.writeFile(path.join(work, 'db', 'garmin.db'), 'baseline\n');
        await fs.copyFile(path.join(root, 'scripts', 'commit-garmin-session.sh'),
            path.join(work, 'scripts', 'commit-garmin-session.sh'));
        await fs.writeFile(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\n[[ "$*" == "session:check" ]]\n', { mode: 0o755 });
        successful(work, 'git', ['init', '-b', 'main']);
        successful(work, 'git', ['config', 'user.name', 'Test']);
        successful(work, 'git', ['config', 'user.email', 'test@example.invalid']);
        successful(work, 'git', ['add', '.']);
        successful(work, 'git', ['commit', '-m', 'baseline']);
        successful(work, 'git', ['remote', 'add', 'origin', remote]);
        successful(work, 'git', ['push', '-u', 'origin', 'main']);

        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
        let result = command(work, 'bash', ['scripts/commit-garmin-session.sh'], { env });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /Garmin Sessions are unchanged/);
        assert.equal(successful(work, 'git', ['rev-list', '--count', 'HEAD']), '1');

        await fs.appendFile(path.join(work, 'db', 'garmin.db'), 'changed\n');
        await fs.writeFile(path.join(work, 'runtime.tmp'), 'unexpected\n');
        result = command(work, 'bash', ['scripts/commit-garmin-session.sh'], { env });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /outside db\/garmin\.db/);
        assert.equal(successful(work, 'git', ['rev-list', '--count', 'HEAD']), '1');
        await fs.rm(path.join(work, 'runtime.tmp'));

        result = command(work, 'bash', ['scripts/commit-garmin-session.sh'], { env });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(successful(work, 'git', ['show', '-s', '--format=%s', 'HEAD']),
            'Update Garmin sessions [skip ci]');
        assert.equal(successful(work, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']),
            'db/garmin.db');

        const other = path.join(directory, 'other');
        successful(directory, 'git', ['clone', '--branch', 'main', remote, other]);
        successful(other, 'git', ['config', 'user.name', 'Other']);
        successful(other, 'git', ['config', 'user.email', 'other@example.invalid']);
        await fs.writeFile(path.join(other, 'remote.txt'), 'remote advance\n');
        successful(other, 'git', ['add', 'remote.txt']);
        successful(other, 'git', ['commit', '-m', 'remote advance']);
        successful(other, 'git', ['push', 'origin', 'main']);

        await fs.appendFile(path.join(work, 'db', 'garmin.db'), 'local refresh\n');
        result = command(work, 'bash', ['scripts/commit-garmin-session.sh'], { env });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /fetch first|non-fast-forward|rejected/i);
        assert.notEqual(successful(work, 'git', ['rev-parse', 'HEAD']),
            successful(work, 'git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0]);
    });
