import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Decoder, Stream } from '@garmin/fitsdk';
import sports from '../core/sports.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const { canonicalFitSport } = sports;

export function decodeEvidence(bytes) {
    const decoder = new Decoder(Stream.fromBuffer(bytes));
    if (!decoder.isFIT() || !decoder.checkIntegrity()) throw new Error('Invalid FIT');
    const { messages, errors } = decoder.read();
    if (errors.length || messages.sessionMesgs?.length !== 1) throw new Error('A single complete FIT session is required');
    const session = messages.sessionMesgs[0];
    const start = session.startTime instanceof Date ? session.startTime.getTime() : NaN;
    if (!Number.isFinite(start) || !session.sport) throw new Error('FIT has no stable start time or sport');
    const file = messages.fileIdMesgs?.[0];
    let device;
    if (file?.serialNumber > 0 && file?.manufacturer && file?.timeCreated instanceof Date) {
        device = hash(JSON.stringify([file.manufacturer, file.product, file.serialNumber, file.timeCreated.getTime()]));
    }
    const records = messages.recordMesgs || [];
    let recordHash;
    if (records.length >= 10 && records.filter(record => Number.isFinite(record.positionLat) && Number.isFinite(record.positionLong)).length >= 5) {
        const digest = createHash('sha256');
        for (const record of records) {
            digest.update(JSON.stringify([record.timestamp, record.positionLat, record.positionLong,
                record.distance, record.heartRate, record.cadence, record.power]));
        }
        recordHash = digest.digest('hex');
    }
    return { sha256: hash(bytes), device, records: recordHash, start,
        sport: canonicalFitSport(session.sport, session.subSport),
        duration: numeric(session.totalTimerTime ?? session.totalElapsedTime), distance: numeric(session.totalDistance) };
}

// Keep the ESM-only SDK isolated from the existing CommonJS TypeScript entrypoints.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const bytes = await fs.readFile(process.argv[2]);
        process.stdout.write(JSON.stringify(decodeEvidence(bytes)));
    } catch (_) {
        process.stderr.write('FIT validation failed.\n');
        process.exitCode = 1;
    }
}
