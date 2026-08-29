require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { readEvidence, extractSingleFit } = require('../../src/sync/files');
const { sameRecording } = require('../../src/sync/engine');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dailysync-fit-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { makeFit } = await import('./fit-fixture.mjs');
    return { directory, makeFit };
}

test('official SDK validates FIT and generates non-raw recording evidence', async t => {
    const f = await fixture(t);
    const first = path.join(f.directory, 'one.fit'), second = path.join(f.directory, 'two.fit');
    await fs.writeFile(first, f.makeFit());
    await fs.writeFile(second, f.makeFit({ extra: true }));
    const a = await readEvidence(first), b = await readEvidence(second);
    assert.notEqual(a.sha256, b.sha256);
    assert.equal(a.device, b.device);
    assert.equal(a.records, b.records);
    assert.equal(sameRecording(a, b), true);
    assert.equal(a.sport, 'running');
    assert.equal(a.distance, 5000);
    assert.ok(!JSON.stringify(a).includes('positionLat'));
});

test('corrupt FIT is rejected rather than uploaded', async t => {
    const f = await fixture(t), file = path.join(f.directory, 'bad.fit');
    const bytes = f.makeFit(); bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(file, bytes);
    await assert.rejects(readEvidence(file), { code: 'FIT_INVALID' });
});

test('ZIP extraction ignores original paths and requires a single FIT', async t => {
    const f = await fixture(t), zipPath = path.join(f.directory, 'file.zip'), target = path.join(f.directory, 'safe.fit');
    const zip = new JSZip(); zip.file('../../outside.fit', f.makeFit());
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
    assert.equal(await extractSingleFit(zipPath, target), target);
    assert.equal((await readEvidence(target)).sport, 'running');
    zip.file('another.fit', f.makeFit());
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(extractSingleFit(zipPath, path.join(f.directory, 'second.fit')), { code: 'FIT_INVALID' });
});

test('failed ZIP extraction never removes an existing destination', async t => {
    const f = await fixture(t), zipPath = path.join(f.directory, 'file.zip'), target = path.join(f.directory, 'existing.fit');
    const original = f.makeFit();
    await fs.writeFile(target, original);
    const zip = new JSZip(); zip.file('new.fit', f.makeFit({ extra: true }));
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(extractSingleFit(zipPath, target), { code: 'FIT_INVALID' });
    assert.deepEqual(await fs.readFile(target), original);
});
