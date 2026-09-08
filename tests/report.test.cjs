require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { compactResult, groupAttention, reportGitHub } = require('../src/cli/report');

function result(events) {
    const counts = { uploaded: 0, existing: 0, review: 0, verifying: 0, failed: 0, unsupported: 0, deferred: 0 };
    for (const event of events) counts[event.status]++;
    return { route: 'garmin-cn-to-coros-cn', mode: 'migration', limit: 100,
        transferLimitReached: false, outcome: 'partial', exitCode: 0, counts, events };
}

test('machine output omits repetitive existing events and groups attention codes', () => {
    const base = { route: 'garmin-cn-to-coros-cn' };
    const value = result([
        { ...base, source: 'garmin-cn:1', status: 'existing', targetId: 'coros-1' },
        { ...base, source: 'garmin-cn:2', status: 'existing', targetId: 'coros-2' },
        { ...base, source: 'garmin-cn:3', status: 'uploaded', targetId: 'coros-3' },
        { ...base, source: 'garmin-cn:4', status: 'review', code: 'AMBIGUOUS_HISTORY' },
        { ...base, source: 'garmin-cn:5', status: 'review', code: 'AMBIGUOUS_HISTORY' },
    ]);
    assert.deepEqual(groupAttention(value.events), [{ status: 'review', code: 'AMBIGUOUS_HISTORY', count: 2,
        examples: ['garmin-cn:4', 'garmin-cn:5'] }]);
    const compact = compactResult(value);
    assert.equal(compact.events, undefined);
    assert.deepEqual(compact.transfers, [{ source: 'garmin-cn:3', targetId: 'coros-3' }]);
    assert.equal(JSON.stringify(compact).includes('garmin-cn:1'), false);
});

test('GitHub reporting writes an aggregate warning summary without changing the exit code', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-report-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const summary = path.join(directory, 'summary.md');
    const base = { route: 'garmin-cn-to-coros-cn' };
    const value = result([{ ...base, source: 'garmin-cn:4', status: 'review', code: 'AMBIGUOUS_HISTORY' }]);
    const messages = [];
    const original = console.error;
    console.error = message => messages.push(message);
    try { await reportGitHub(value, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }); }
    finally { console.error = original; }
    assert.match(messages[0], /^::warning title=DailySync AMBIGUOUS_HISTORY::1 activity item/);
    assert.match(await fs.readFile(summary, 'utf8'), /\| review \| AMBIGUOUS_HISTORY \| 1 \|/);
    assert.equal(value.exitCode, 0);
});
