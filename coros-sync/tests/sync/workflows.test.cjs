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
const writerWorkflows = [
    ['migrate_garmin_cn_to_coros.yml', 'migrate'],
    ['sync_garmin_cn_to_coros.yml', 'sync'],
    ['manage_garmin_cn_to_coros.yml', 'manage'],
    ['migrate_garmin_cn_to_garmin_global.yml', 'build'],
    ['migrate_garmin_global_to_garmin_cn.yml', 'build'],
    ['sync_garmin_cn_to_garmin_global.yml', 'build'],
    ['sync_garmin_global_to_garmin_cn.yml', 'build'],
];

test('migration and sync are separate Actions with a durable state snapshot and writer queue', () => {
    for (const filename of fs.readdirSync(path.join(root, '.github/workflows'))) if (filename.endsWith('.yml')) assert.ok(read(filename).jobs);
    for (const filename of fs.readdirSync(path.join(root, '.github/workflows'))) if (filename.endsWith('.yml')) {
        assert.equal(raw(filename).includes('actions/checkout@v3'), false);
        assert.equal(raw(filename).includes('actions/setup-node@v3'), false);
    }
    const migration = read('migrate_garmin_cn_to_coros.yml');
    const sync = read('sync_garmin_cn_to_coros.yml');
    const manage = read('manage_garmin_cn_to_coros.yml');

    assert.ok(Object.prototype.hasOwnProperty.call(migration.on, 'workflow_dispatch'));
    assert.equal(migration.on.schedule, undefined);
    assert.equal(migration.on.push, undefined);
    assert.equal(migration.on.workflow_dispatch?.inputs, undefined);

    assert.deepEqual(sync.on.schedule, [{ cron: '0 2,8,14,20 * * *' }]);
    assert.equal(sync.on.push, undefined);
    assert.equal(sync.jobs.sync.if, undefined);
    assert.equal(sync.on.workflow_dispatch.inputs.operation, undefined);
    assert.equal(sync.on.workflow_dispatch.inputs.activity_id.type, 'string');
    assert.equal(sync.on.workflow_dispatch.inputs.max_uploads, undefined);
    assert.equal(manage.on.schedule, undefined);
    assert.deepEqual(manage.on.workflow_dispatch.inputs.operation.options, ['initialize', 'state', 'link', 'ignore', 'retry']);

    assert.equal(migration.concurrency, undefined);
    assert.equal(sync.concurrency, undefined);
    assert.equal(manage.concurrency, undefined);
    assert.equal(migration.permissions.actions, 'read');
    assert.equal(migration.permissions.contents, 'write');
    assert.equal(sync.permissions.actions, 'read');
    assert.equal(sync.permissions.contents, 'write');
    assert.equal(manage.permissions.actions, 'read');
    assert.equal(manage.permissions.contents, 'write');

    for (const [filename, jobName] of [
        ['migrate_garmin_cn_to_coros.yml', 'migrate'],
        ['sync_garmin_cn_to_coros.yml', 'sync'],
    ]) {
        const workflow = read(filename);
        assert.equal(workflow.jobs[jobName].steps[0].with.ref, '${{ github.ref_name }}');
        const setupNode = workflow.jobs[jobName].steps.find(step => step.uses === 'actions/setup-node@v4');
        assert.equal(setupNode.with['node-version'], '22.13.0');
        const execute = workflow.jobs[jobName].steps.find(step => step.name?.includes('to COROS'));
        assert.equal(execute.env.GARMIN_DB_LOCK_COMMIT, '${{ steps.garmin_db_lock.outputs.lock_commit }}');
        assert.equal(workflow.jobs[jobName].steps.some(step => step.uses === 'stefanzweifel/git-auto-commit-action@v5'), false);
        assert.equal(raw(filename).includes('Save COROS'), false);
        assert.equal(raw(filename).includes('file_pattern:'), false);
        assert.equal(raw(filename).includes('GARMIN_PASSWORD'), false);
        assert.equal(raw(filename).includes('GARMIN_GLOBAL'), false);
        assert.equal(raw(filename).includes('COROS_SYNC_STATE_KEY'), false);
        assert.equal(raw(filename).includes('COROS_SYNC_MODE'), false);
        assert.equal(raw(filename).includes('operation:'), false);
    }

    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /secrets\.GARMIN_MIGRATE_NUM/);
    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /secrets\.GARMIN_MIGRATE_START/);
    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /secrets\.GARMIN_MIGRATE_AUTO_PAGE/);
    assert.match(raw('migrate_garmin_cn_to_coros.yml'), /migrate_garmin_cn_to_coros/);
    assert.equal(raw('sync_garmin_cn_to_coros.yml').includes('GARMIN_MIGRATE'), false);
    assert.match(raw('sync_garmin_cn_to_coros.yml'), /secrets\.GARMIN_SYNC_NUM/);
    assert.equal(raw('sync_garmin_cn_to_coros.yml').includes('COROS_SYNC_MAX_UPLOADS'), false);
    assert.match(raw('sync_garmin_cn_to_coros.yml'), /sync_garmin_cn_to_coros/);
    assert.match(raw('manage_garmin_cn_to_coros.yml'), /sync_garmin_cn_to_coros/);

    for (const [filename, jobName] of writerWorkflows) {
        const workflow = read(filename);
        const job = workflow.jobs[jobName];
        const permissions = job.permissions ?? workflow.permissions;
        assert.equal(workflow.concurrency, undefined);
        assert.equal(permissions.actions, 'read');
        assert.equal(permissions.contents, 'write');
        assert.equal(workflow.jobs[jobName].steps[0].with.ref, '${{ github.ref_name }}');
        const acquire = job.steps.find(step => step.id === 'garmin_db_lock');
        const release = job.steps.find(step => step.name === 'Release Garmin database writer lock');
        assert.equal(acquire.run, 'node .github/scripts/garmin-db-lock.cjs acquire');
        assert.equal(acquire.env.GITHUB_TOKEN, '${{ github.token }}');
        assert.equal(release.run, 'node .github/scripts/garmin-db-lock.cjs release');
        assert.equal(release.if, "${{ always() && steps.garmin_db_lock.outputs.acquired == 'true' }}");
        assert.equal(release.env.GARMIN_DB_LOCK_COMMIT, '${{ steps.garmin_db_lock.outputs.lock_commit }}');
        assert.ok(job.steps.indexOf(acquire) < job.steps.findIndex(step => step.run === 'yarn' ||
            step.run === 'pnpm --dir coros-sync install --frozen-lockfile'));
        assert.equal(job.steps.at(-1), release);
    }
});

test('all original commands and workflows remain independent from the COROS tools', () => {
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

    for (const filename of ['sync_garmin_cn_to_garmin_global.yml', 'sync_garmin_global_to_garmin_cn.yml',
        'migrate_garmin_cn_to_garmin_global.yml', 'migrate_garmin_global_to_garmin_cn.yml']) {
        assert.equal(raw(filename).includes('COROS'), false);
        assert.equal(raw(filename).includes('coros'), false);
        assert.equal(read(filename).concurrency, undefined);
    }
    for (const filename of ['src/utils/garmin_cn.ts', 'src/utils/garmin_global.ts', 'src/utils/garmin_common.ts', 'src/utils/garmin_wellness.ts']) {
        assert.equal(fs.readFileSync(path.join(root, filename), 'utf8').includes("from '../sync/"), false);
    }
    assert.equal(raw('ci.yml').includes('coros'), false);

    const childPackage = JSON.parse(fs.readFileSync(path.join(root, 'coros-sync/package.json'), 'utf8'));
    assert.equal(childPackage.engines.node, '>=22.13.0');
    assert.equal(childPackage.packageManager, 'pnpm@11.19.0');
    assert.equal(childPackage.scripts.migrate_garmin_cn_to_coros, 'ts-node src/migrate_garmin_cn_to_coros.ts');
    assert.equal(childPackage.scripts.sync_garmin_cn_to_coros, 'ts-node src/sync_garmin_cn_to_coros.ts');
    assert.equal(childPackage.scripts.initialize_garmin_cn_to_coros_state,
        'ts-node src/initialize_garmin_cn_to_coros_state.ts');
    const childCi = read('coros_sync_ci.yml');
    const childCiRaw = raw('coros_sync_ci.yml');
    assert.ok(childCi.jobs.test.steps.some(step => step.run === 'pnpm --dir coros-sync test'));
    const childCiNode = childCi.jobs.test.steps.find(step => step.uses === 'actions/setup-node@v4');
    assert.equal(childCiNode.with['node-version'], '22.13.0');
    assert.match(childCiRaw, /migrate_garmin_cn_to_coros\.yml/);
    assert.match(childCiRaw, /manage_garmin_cn_to_coros\.yml/);
    assert.match(childCiRaw, /sync_garmin_cn_to_coros\.yml/);
    assert.ok(childCi.on.pull_request.paths.includes('.github/scripts/garmin-db-lock.cjs'));
    assert.ok(childCi.on.push.paths.includes('.github/scripts/garmin-db-lock.cjs'));
    for (const [filename] of writerWorkflows) {
        assert.ok(childCi.on.pull_request.paths.includes(`.github/workflows/${filename}`));
        assert.ok(childCi.on.push.paths.includes(`.github/workflows/${filename}`));
    }
    assert.ok(fs.existsSync(path.join(root, 'coros-sync/README.md')));
    const childReadme = fs.readFileSync(path.join(root, 'coros-sync/README.md'), 'utf8');
    assert.match(childReadme, /远端 Git 互斥锁/);
    assert.match(childReadme, /codex\/coros-sync-state/);
    assert.match(childReadme, /不会向 `main` 写入 Action 产物/);
    assert.equal(childReadme.includes('`garmin-cn-to-coros-cn` concurrency'), false);
    assert.equal(fs.existsSync(path.join(root, 'docs/garmin-cn-to-coros-action.md')), false);
});

function shell(step, env) {
    return execFileSync('bash', ['-c', `pnpm() { printf '%s\\n' "$@"; }\n${step.run}`],
        { encoding: 'utf8', env: { ...process.env, ...env } }).trim().split('\n');
}

test('migration workflow uses only migration parameters and never schedules itself', () => {
    const step = read('migrate_garmin_cn_to_coros.yml').jobs.migrate.steps
        .find(item => item.name === 'Migrate Garmin history to COROS');
    assert.deepEqual(shell(step, { GARMIN_MIGRATE_NUM: '100', GARMIN_MIGRATE_START: '21' }),
        ['--dir', 'coros-sync', 'migrate_garmin_cn_to_coros', '--time-budget', '2700',
            '--migrate-start', '21', '--apply']);
});

test('sync workflow preserves activity IDs and schedules an uncapped six-hour apply', () => {
    const step = read('sync_garmin_cn_to_coros.yml').jobs.sync.steps
        .find(item => item.name === 'Sync Garmin activities to COROS');
    const base = { SYNC_ACTIVITY_ID: '' };
    assert.deepEqual(shell(step, base),
        ['--dir', 'coros-sync', 'sync_garmin_cn_to_coros', '--time-budget', '2700', '--apply']);
    assert.deepEqual(shell(step, { ...base, SYNC_ACTIVITY_ID: '$(printf injected)' }),
        ['--dir', 'coros-sync', 'sync_garmin_cn_to_coros', '--time-budget', '2700', '--apply',
            '--activity-id', '$(printf injected)']);
});

test('state maintenance workflow preserves activity IDs and requires explicit retry confirmation', () => {
    const step = read('manage_garmin_cn_to_coros.yml').jobs.manage.steps
        .find(item => item.name === 'Manage Garmin to COROS state');
    const base = { STATE_OPERATION: 'state', SOURCE_ACTIVITY_ID: '', TARGET_ACTIVITY_ID: '', CONFIRM_NOT_IMPORTED: 'false' };
    assert.deepEqual(shell(step, { ...base, STATE_OPERATION: 'initialize' }),
        ['--dir', 'coros-sync', 'initialize_garmin_cn_to_coros_state']);
    assert.deepEqual(shell(step, base), ['--dir', 'coros-sync', 'sync_garmin_cn_to_coros', 'state']);
    assert.deepEqual(shell(step, { ...base, STATE_OPERATION: 'link', SOURCE_ACTIVITY_ID: '$(printf source)',
        TARGET_ACTIVITY_ID: '$(printf target)' }), ['--dir', 'coros-sync', 'sync_garmin_cn_to_coros', 'link',
        '--source', 'garmin-cn:$(printf source)', '--target', 'coros-cn:$(printf target)']);
    assert.deepEqual(shell(step, { ...base, STATE_OPERATION: 'retry', SOURCE_ACTIVITY_ID: '123',
        CONFIRM_NOT_IMPORTED: 'true' }), ['--dir', 'coros-sync', 'sync_garmin_cn_to_coros', 'retry',
        '--source', 'garmin-cn:123', '--target', 'coros-cn', '--confirm-not-imported']);
    assert.throws(() => shell(step, { ...base, STATE_OPERATION: 'retry', SOURCE_ACTIVITY_ID: '123' }));
});
