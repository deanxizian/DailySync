const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflowPath = name => path.join(root, '.github/workflows', name);
const read = name => YAML.parse(fs.readFileSync(workflowPath(name), 'utf8'), { uniqueKeys: true });
const raw = name => fs.readFileSync(workflowPath(name), 'utf8');
const concurrency = { group: 'dailysync-garmin-cn-coros-cn', queue: 'max', 'cancel-in-progress': false };
const corosWorkflows = [
    ['migrate_garmin_cn_to_coros.yml', 'migrate'],
    ['migrate_coros_cn_to_garmin_cn.yml', 'migrate'],
    ['sync_garmin_cn_to_coros.yml', 'sync'],
    ['sync_coros_cn_to_garmin_cn.yml', 'sync'],
];
const originalWorkflows = [
    ['migrate_garmin_cn_to_garmin_global.yml', 'build'],
    ['migrate_garmin_global_to_garmin_cn.yml', 'build'],
    ['sync_garmin_cn_to_garmin_global.yml', 'build'],
    ['sync_garmin_global_to_garmin_cn.yml', 'build'],
];

test('directional scheduled sync Actions are stateless, staggered and queued', () => {
    for (const filename of fs.readdirSync(path.join(root, '.github/workflows'))) {
        if (!filename.endsWith('.yml')) continue;
        assert.ok(read(filename).jobs);
    }

    const migration = read('migrate_garmin_cn_to_coros.yml');
    const reverseMigration = read('migrate_coros_cn_to_garmin_cn.yml');
    const sync = read('sync_garmin_cn_to_coros.yml');
    const reverseSync = read('sync_coros_cn_to_garmin_cn.yml');
    assert.ok(Object.prototype.hasOwnProperty.call(migration.on, 'workflow_dispatch'));
    assert.ok(Object.prototype.hasOwnProperty.call(reverseMigration.on, 'workflow_dispatch'));
    assert.equal(migration.on.schedule, undefined);
    assert.equal(reverseMigration.on.schedule, undefined);
    assert.equal(migration.on.push, undefined);
    assert.deepEqual(sync.on.schedule, [{ cron: '0 2,8,14,20 * * *' }]);
    assert.deepEqual(reverseSync.on.schedule, [{ cron: '0 3,9,15,21 * * *' }]);
    assert.equal(sync.on.push, undefined);
    assert.equal(sync.on.workflow_dispatch.inputs.activity_id.type, 'string');
    assert.equal(reverseSync.on.workflow_dispatch.inputs.activity_id.type, 'string');
    assert.equal(fs.existsSync(workflowPath('manage_garmin_cn_to_coros.yml')), false);
    assert.equal(fs.existsSync(workflowPath('sync_garmin_cn_coros_cn.yml')), false);

    for (const [filename, jobName] of corosWorkflows) {
        const workflow = read(filename);
        const checkout = workflow.jobs[jobName].steps[0];
        assert.deepEqual(workflow.concurrency, concurrency);
        assert.deepEqual(workflow.permissions, { contents: 'read' });
        assert.equal(checkout.uses, 'actions/checkout@v4');
        assert.equal(checkout.with.ref, '${{ github.ref_name }}');
        assert.equal(checkout.with['persist-credentials'], false);
        assert.equal(workflow.jobs[jobName].steps.some(step => step.uses === 'stefanzweifel/git-auto-commit-action@v5'), false);
        for (const term of ['git push', 'git commit', 'Save COROS', 'GITHUB_TOKEN', 'GARMIN_PASSWORD', 'GARMIN_GLOBAL',
            'COROS_SYNC_STATE_KEY', 'COROS_SYNC_MODE', 'garmin-db-lock', 'GARMIN_DB_LOCK', '--apply']) {
            assert.equal(raw(filename).includes(term), false, `${filename}: ${term}`);
        }
    }

    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /secrets\.GARMIN_MIGRATE_NUM/);
    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /secrets\.GARMIN_MIGRATE_START/);
    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /secrets\.GARMIN_MIGRATE_AUTO_PAGE/);
    assert.match(raw('migrate_coros_cn_to_garmin_cn.yml'), /secrets\.GARMIN_MIGRATE_AUTO_PAGE/);
    assert.equal(raw('sync_garmin_cn_to_coros.yml').includes('GARMIN_MIGRATE'), false);
    assert.equal(raw('sync_coros_cn_to_garmin_cn.yml').includes('GARMIN_MIGRATE'), false);
    assert.match(raw('sync_garmin_cn_to_coros.yml'), /secrets\.GARMIN_SYNC_NUM/);
    assert.match(raw('sync_coros_cn_to_garmin_cn.yml'), /secrets\.GARMIN_SYNC_NUM/);
});

test('original Garmin commands and scheduling stay independent', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const originalCommands = {
        test: 'ts-node src/test.ts',
        sync_cn: 'ts-node src/sync_garmin_cn_to_global.ts',
        sync_global: 'ts-node src/sync_garmin_global_to_cn.ts',
        sync_all_cn_to_global: 'ts-node src/sync_all_garmin_cn_to_global.ts',
        sync_all_global_to_cn: 'ts-node src/sync_all_garmin_global_to_cn.ts',
        sync_wellness_cn_to_global: 'ts-node src/sync_wellness_garmin_cn_to_global.ts',
        sync_wellness_global_to_cn: 'ts-node src/sync_wellness_garmin_global_to_cn.ts',
        migrate_garmin_global_to_cn: 'ts-node src/migrate_garmin_global_to_cn.ts',
        migrate_garmin_cn_to_global: 'ts-node src/migrate_garmin_cn_to_global.ts',
        migrate_all_global_to_cn: 'ts-node src/migrate_all_garmin_global_to_cn.ts',
        migrate_all_cn_to_global: 'ts-node src/migrate_all_garmin_cn_to_global.ts',
        migrate_wellness_global_to_cn: 'ts-node src/migrate_wellness_garmin_global_to_cn.ts',
        migrate_wellness_cn_to_global: 'ts-node src/migrate_wellness_garmin_cn_to_global.ts',
    };
    for (const [name, command] of Object.entries(originalCommands)) assert.equal(packageJson.scripts[name], command);

    for (const [filename, jobName] of originalWorkflows) {
        const workflow = read(filename);
        const steps = workflow.jobs[jobName].steps;
        assert.equal(workflow.concurrency, undefined);
        assert.equal(workflow.jobs[jobName].permissions.actions, undefined);
        assert.equal(workflow.jobs[jobName].permissions.contents, 'write');
        assert.equal(steps[0].uses, 'actions/checkout@v3');
        assert.equal(steps[1].uses, 'actions/setup-node@v3');
        assert.ok(steps.some(step => step.uses === 'stefanzweifel/git-auto-commit-action@v5'));
        assert.equal(raw(filename).includes('COROS'), false);
        assert.equal(raw(filename).includes('coros'), false);
        assert.equal(raw(filename).includes('garmin-db-lock'), false);
        assert.equal(raw(filename).includes('wait-for-garmin-db-writer'), false);
    }
    for (const filename of ['migrate_garmin_cn_to_garmin_global.yml', 'migrate_garmin_global_to_garmin_cn.yml']) {
        assert.match(raw(filename), /GARMIN_MIGRATE_AUTO_PAGE: \$\{\{ secrets\.GARMIN_MIGRATE_AUTO_PAGE \}\}/);
    }
    for (const filename of ['sync_garmin_cn_to_garmin_global.yml', 'sync_garmin_global_to_garmin_cn.yml']) {
        assert.match(raw(filename), /GARMIN_SYNC_NUM: \$\{\{ secrets\.GARMIN_SYNC_NUM \}\}/);
    }
    for (const filename of ['src/utils/garmin_cn.ts', 'src/utils/garmin_global.ts', 'src/utils/garmin_common.ts', 'src/utils/garmin_wellness.ts']) {
        assert.equal(fs.readFileSync(path.join(root, filename), 'utf8').includes("from '../sync/"), false);
    }
    assert.equal(raw('ci.yml').includes('coros'), false);
});

test('the COROS package contains no persistent state or Git writer', () => {
    const childPackage = JSON.parse(fs.readFileSync(path.join(root, 'coros-sync/package.json'), 'utf8'));
    assert.equal(childPackage.scripts.migrate_garmin_cn_to_coros, 'ts-node src/migrate_garmin_cn_to_coros.ts');
    assert.equal(childPackage.scripts.migrate_coros_cn_to_garmin_cn, 'ts-node src/migrate_coros_cn_to_garmin_cn.ts');
    assert.equal(childPackage.scripts.sync_garmin_cn_to_coros, 'ts-node src/sync_garmin_cn_to_coros.ts');
    assert.equal(childPackage.scripts.sync_coros_cn_to_garmin_cn, 'ts-node src/sync_coros_cn_to_garmin_cn.ts');
    assert.equal(childPackage.scripts.initialize_garmin_cn_to_coros_state, undefined);

    for (const filename of ['initialize_garmin_cn_to_coros_state.ts', 'sync/state.ts', 'sync/workspace.ts',
        'sync/upload-intent.ts', 'sync/git-checkpoint.ts', 'sync/release-checkpoint.ts', 'sync/legacy-state.ts']) {
        assert.equal(fs.existsSync(path.join(root, 'coros-sync/src', filename)), false, filename);
    }
    assert.equal(fs.existsSync(path.join(root, '.github/scripts/garmin-db-lock.cjs')), false);
    assert.equal(fs.existsSync(path.join(root, '.github/scripts/wait-for-garmin-db-writer.cjs')), false);

    const sources = fs.readdirSync(path.join(root, 'coros-sync/src/sync'))
        .filter(name => name.endsWith('.ts'))
        .map(name => fs.readFileSync(path.join(root, 'coros-sync/src/sync', name), 'utf8'))
        .join('\n');
    for (const term of ['commit-tree', 'hash-object', 'mktree', 'git push', 'git commit', 'GITHUB_TOKEN']) {
        assert.equal(sources.includes(term), false, term);
    }

    const childCi = read('coros_sync_ci.yml');
    assert.ok(childCi.jobs.test.steps.some(step => step.run === 'pnpm --dir coros-sync test'));
    assert.ok(childCi.jobs.test.steps.some(step => step.run === 'pnpm --dir coros-sync typecheck'));
    const ciText = raw('coros_sync_ci.yml');
    assert.match(ciText, /migrate_garmin_cn_to_coros\.yml/);
    assert.match(ciText, /migrate_coros_cn_to_garmin_cn\.yml/);
    assert.match(ciText, /sync_garmin_cn_to_coros\.yml/);
    assert.match(ciText, /sync_coros_cn_to_garmin_cn\.yml/);
    assert.equal(ciText.includes('sync_garmin_cn_coros_cn.yml'), false);
    for (const [filename] of originalWorkflows) assert.equal(ciText.includes(filename), false);

    const readme = fs.readFileSync(path.join(root, 'coros-sync/README.md'), 'utf8');
    assert.match(readme, /不执行 commit 或 push/);
    assert.match(readme, /仓库只读权限/);
    assert.equal(readme.includes('Draft Release'), false);
    assert.equal(readme.includes('Preview'), false);
});

function shell(step, env) {
    return execFileSync('bash', ['-c', `pnpm() { printf '%s\\n' "$@"; }\n${step.run}`],
        { encoding: 'utf8', env: { ...process.env, ...env } }).trim().split('\n');
}

test('migration workflow uses only migration parameters', () => {
    for (const [filename, name, command] of [
        ['migrate_garmin_cn_to_coros.yml', 'Migrate Garmin history to COROS', 'migrate_garmin_cn_to_coros'],
        ['migrate_coros_cn_to_garmin_cn.yml', 'Migrate COROS history to Garmin', 'migrate_coros_cn_to_garmin_cn'],
    ]) {
        const step = read(filename).jobs.migrate.steps.find(item => item.name === name);
        assert.deepEqual(shell(step, { GARMIN_MIGRATE_NUM: '100', GARMIN_MIGRATE_START: '21' }),
            ['--dir', 'coros-sync', command, '--migrate-start', '21']);
    }
});

test('sync workflow preserves an activity ID without shell evaluation', () => {
    for (const [filename, name, command] of [
        ['sync_garmin_cn_to_coros.yml', 'Sync Garmin activities to COROS', 'sync_garmin_cn_to_coros'],
        ['sync_coros_cn_to_garmin_cn.yml', 'Sync COROS activities to Garmin', 'sync_coros_cn_to_garmin_cn'],
    ]) {
        const step = read(filename).jobs.sync.steps.find(item => item.name === name);
        assert.deepEqual(shell(step, { SYNC_ACTIVITY_ID: '' }),
            ['--dir', 'coros-sync', command, '--time-budget', '2700']);
        assert.deepEqual(shell(step, { SYNC_ACTIVITY_ID: '$(printf injected)' }),
            ['--dir', 'coros-sync', command, '--time-budget', '2700', '--activity-id', '$(printf injected)']);
    }
});
