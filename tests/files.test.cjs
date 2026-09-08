require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const { readEvidence, extractGarminActivity, extractSingleFit } = require('../src/formats/files');
const { gpxToTcx } = require('../src/formats/tcx');
const { sameRecording } = require('../src/core/engine');

const start = Date.parse('2025-04-06T03:00:00Z');

function gpx(secondTime = '2025-04-06T03:00:01Z', firstTime = '2025-04-06T03:00:00Z') {
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DailySync test" xmlns="http://www.topografix.com/GPX/1/1"
 xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <trk><trkseg>
  <trkpt lat="22.500000" lon="114.000000"><ele>10</ele><time>${firstTime}</time>
   <extensions><gpxtpx:TrackPointExtension><gpxtpx:atemp>24</gpxtpx:atemp><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension><power>210</power></extensions>
  </trkpt>
  <trkpt lat="22.500100" lon="114.000100"><ele>11</ele><time>${secondTime}</time>
   <extensions><gpxtpx:TrackPointExtension><gpxtpx:atemp>25</gpxtpx:atemp><gpxtpx:hr>121</gpxtpx:hr><gpxtpx:cad>81</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>
  </trkpt>
 </trkseg></trk>
</gpx>`);
}

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

test('FIT training evidence uses sub-sport instead of treating every workout as strength', async t => {
    const f = await fixture(t);
    for (const [name, options, expected] of [
        ['strength', { sport: 'training', subSport: 'strengthTraining' }, 'strength'],
        ['cardio', { sport: 'training', subSport: 'cardioTraining' }, 'cardio'],
        ['hiit', { sport: 'hiit', subSport: 'generic' }, 'cardio'],
        ['rowing', { sport: 'rowing', subSport: 'indoorRowing' }, 'rowing'],
        ['fitness-rowing', { sport: 'fitnessEquipment', subSport: 'indoorRowing' }, 'rowing'],
        ['fitness-cycling', { sport: 'fitnessEquipment', subSport: 'indoorCycling' }, 'cycling'],
        ['fitness-treadmill', { sport: 'fitnessEquipment', subSport: 'treadmill' }, 'running'],
        ['fitness-pilates', { sport: 'fitnessEquipment', subSport: 'pilates' }, 'pilates'],
        ['fitness-stairs', { sport: 'fitnessEquipment', subSport: 'stairClimbing' }, 'cardio'],
        ['fitness-skiing', { sport: 'fitnessEquipment', subSport: 'indoorSkiing' }, 'skiing'],
        ['fitness-walking', { sport: 'fitnessEquipment', subSport: 'indoorWalking' }, 'walking'],
        ['yoga', { sport: 'training', subSport: 'yoga' }, 'yoga'],
        ['ebike', { sport: 'eBiking', subSport: 'generic' }, 'cycling'],
        ['generic', { sport: 'training', subSport: 'generic' }, 'training'],
    ]) {
        const file = path.join(f.directory, `${name}.fit`);
        await fs.writeFile(file, f.makeFit(options));
        assert.equal((await readEvidence(file)).sport, expected);
    }
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

test('Garmin GPX is converted to validated cycling TCX with activity data', async t => {
    const f = await fixture(t), zipPath = path.join(f.directory, 'ride.zip');
    const zip = new JSZip(); zip.file('../../ride.gpx', gpx());
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const item = { slot: 'garmin-cn', id: 'ride', start, sport: 'cycling', duration: 60, distance: 1000 };
    const filename = await extractGarminActivity(zipPath, f.directory, item);
    assert.equal(filename, path.join(f.directory, 'original.tcx'));
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    const proof = await readEvidence(filename);
    assert.deepEqual({ start: proof.start, sport: proof.sport, duration: proof.duration, distance: proof.distance },
        { start, sport: 'cycling', duration: 60, distance: 1000 });

    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
        parseTagValue: false }).parse(await fs.readFile(filename));
    const points = parsed.TrainingCenterDatabase.Activities.Activity.Lap.Track.Trackpoint;
    assert.equal(parsed.TrainingCenterDatabase.Activities.Activity.Sport, 'Biking');
    assert.equal(points.length, 2);
    assert.equal(points[0].HeartRateBpm.Value, '120');
    assert.equal(points[0].Cadence, '80');
    assert.equal(points[0].Extensions.TPX.Temp, '24');
    assert.equal(points[0].Extensions.TPX.Watts, '210');
});

test('Garmin TCX originals are validated and transferred without conversion', async t => {
    const f = await fixture(t), zipPath = path.join(f.directory, 'run.zip');
    const item = { slot: 'garmin-global', id: 'run', start, sport: 'running', duration: 60, distance: 1000 };
    const original = gpxToTcx(gpx(), item);
    const zip = new JSZip(); zip.file('../../original.tcx', original);
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const filename = await extractGarminActivity(zipPath, f.directory, item);
    assert.equal(path.extname(filename), '.tcx');
    assert.deepEqual(await fs.readFile(filename), original);
    assert.equal((await readEvidence(filename)).sport, 'running');
});

test('TCX Other uses the trusted activity type and still validates the complete recording', async t => {
    const f = await fixture(t);
    const item = { slot: 'garmin-cn', id: 'strength', start, sport: 'strength', duration: 60, distance: 1000 };
    const running = gpxToTcx(gpx(), { ...item, sport: 'running' });
    const other = Buffer.from(running.toString().replace('Sport="Running"', 'Sport="Other"'));
    const filename = path.join(f.directory, 'other.tcx');
    await fs.writeFile(filename, other);
    await assert.rejects(readEvidence(filename), { code: 'TCX_INVALID' });
    assert.equal((await readEvidence(filename, item)).sport, 'strength');
});

test('GPX track points are shifted together to the Garmin summary start', async t => {
    const f = await fixture(t), zipPath = path.join(f.directory, 'delayed.zip');
    const zip = new JSZip();
    zip.file('delayed.gpx', gpx('2025-04-06T03:00:31Z', '2025-04-06T03:00:30Z'));
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
    const item = { slot: 'garmin-cn', id: 'delayed', start, sport: 'running', duration: 60, distance: 1000 };
    const filename = await extractGarminActivity(zipPath, f.directory, item);
    const proof = await readEvidence(filename);
    assert.equal(proof.start, start);

    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
        parseTagValue: false }).parse(await fs.readFile(filename));
    const points = parsed.TrainingCenterDatabase.Activities.Activity.Lap.Track.Trackpoint;
    assert.deepEqual(points.map(point => point.Time), ['2025-04-06T03:00:00.000Z', '2025-04-06T03:00:01.000Z']);
    assert.equal(parsed.TrainingCenterDatabase.Activities.Activity.Sport, 'Running');
    assert.equal(points[0].Cadence, undefined);
    assert.equal(points[0].Extensions.TPX.RunCadence, '80');
});

test('GPX conversion rejects ambiguous archives, unsafe XML and unordered points', async t => {
    const f = await fixture(t), item = { slot: 'garmin-cn', id: 'ride', start,
        sport: 'cycling', duration: 60, distance: 1000 };
    const ambiguous = new JSZip(); ambiguous.file('ride.gpx', gpx()); ambiguous.file('ride.fit', f.makeFit());
    const ambiguousPath = path.join(f.directory, 'ambiguous.zip');
    await fs.writeFile(ambiguousPath, await ambiguous.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(extractGarminActivity(ambiguousPath, f.directory, item), { code: 'ACTIVITY_FILE_INVALID' });

    for (const [name, contents] of [
        ['entity.gpx', Buffer.from('<!DOCTYPE gpx [<!ENTITY x "test">]><gpx>&x;</gpx>')],
        ['unordered.gpx', gpx('2025-04-06T02:59:59Z')],
    ]) {
        const zip = new JSZip(); zip.file(name, contents);
        const filename = path.join(f.directory, `${name}.zip`);
        await fs.writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }));
        await assert.rejects(extractGarminActivity(filename, f.directory, item), { code: 'GPX_INVALID' });
    }

    const valid = new JSZip(); valid.file('ride.gpx', gpx());
    const validPath = path.join(f.directory, 'valid.zip'), destination = path.join(f.directory, 'original.tcx');
    await fs.writeFile(validPath, await valid.generateAsync({ type: 'nodebuffer' }));
    await fs.writeFile(destination, 'keep');
    await assert.rejects(extractGarminActivity(validPath, f.directory, item), { code: 'GPX_INVALID' });
    assert.equal(await fs.readFile(destination, 'utf8'), 'keep');

    const swimming = new JSZip(); swimming.file('swim.gpx', gpx());
    const swimmingPath = path.join(f.directory, 'swimming.zip');
    await fs.writeFile(swimmingPath, await swimming.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(extractGarminActivity(swimmingPath, f.directory,
        { ...item, sport: 'swimming' }), { code: 'GPX_UNSUPPORTED' });
});
