import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { Activity, Evidence } from '../core/types';
import { SyncError } from '../core/errors';
import { gpxToTcx, tcxEvidence } from './tcx';

export const MIN_ACTIVITY_BYTES = 14;
export const MAX_ACTIVITY_BYTES = 200 * 1024 * 1024;
export type ActivityFileFormat = 'fit' | 'tcx';

export function activityFileFormat(filename: string): ActivityFileFormat {
    const extension = path.extname(filename).toLowerCase();
    if (extension === '.fit' || extension === '.tcx') return extension.slice(1) as ActivityFileFormat;
    throw new SyncError('ACTIVITY_FILE_INVALID', 'Activity file must be FIT or TCX.');
}

export async function readEvidence(filename: string, expected?: Pick<Activity, 'sport'>): Promise<Evidence> {
    const stat = await fs.promises.stat(filename);
    if (stat.size > MAX_ACTIVITY_BYTES || stat.size < MIN_ACTIVITY_BYTES) {
        throw new SyncError('ACTIVITY_FILE_INVALID', 'Activity file size is unsupported.');
    }
    if (activityFileFormat(filename) === 'tcx') {
        return tcxEvidence(await fs.promises.readFile(filename), expected?.sport);
    }
    const decoder = path.resolve(__dirname, 'fit-decoder.mjs');
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [decoder, filename], { timeout: 60000, maxBuffer: 16384 }, (error, stdout) => {
            if (error) return reject(new SyncError('FIT_INVALID', 'Cannot validate a single complete FIT activity.'));
            try {
                const evidence = JSON.parse(stdout);
                if (!/^[a-f0-9]{64}$/.test(evidence.sha256) || !Number.isFinite(evidence.start) ||
                    typeof evidence.sport !== 'string' || !evidence.sport ||
                    (evidence.duration !== null && (!Number.isFinite(evidence.duration) || evidence.duration < 0)) ||
                    (evidence.distance !== null && (!Number.isFinite(evidence.distance) || evidence.distance < 0))) throw new Error();
                resolve(evidence);
            } catch (_) {
                reject(new SyncError('FIT_INVALID', 'Invalid FIT evidence.'));
            }
        });
    });
}

async function archive(zipPath: string): Promise<JSZip> {
    const stat = await fs.promises.stat(zipPath);
    if (stat.size > MAX_ACTIVITY_BYTES) throw new Error();
    return JSZip.loadAsync(await fs.promises.readFile(zipPath));
}

async function entryBytes(entry: JSZip.JSZipObject): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = new Writable({ write(chunk, _encoding, done) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_ACTIVITY_BYTES) return done(new Error('File too large'));
        chunks.push(bytes);
        done();
    } });
    await pipeline(entry.nodeStream(), collect);
    return Buffer.concat(chunks, size);
}

async function writeEntry(entry: JSZip.JSZipObject, destination: string): Promise<string> {
    let created = false;
    try {
        let size = 0;
        const limit = new Transform({ transform(chunk, _encoding, done) {
            size += chunk.length;
            done(size > MAX_ACTIVITY_BYTES ? new Error('File too large') : null, chunk);
        } });
        // Never use the archive's path as a filesystem destination.
        const output = fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' });
        output.once('open', () => { created = true; });
        await pipeline(entry.nodeStream(), limit, output);
        return destination;
    } catch (error) {
        if (created) await fs.promises.rm(destination, { force: true });
        throw error;
    }
}

export async function extractSingleFit(zipPath: string, destination: string): Promise<string> {
    try {
        const zip = await archive(zipPath);
        const files = Object.values(zip.files).filter(file => !file.dir && /\.fit$/i.test(file.name));
        if (files.length !== 1) throw new Error();
        return await writeEntry(files[0]!, destination);
    } catch (_) {
        throw new SyncError('FIT_INVALID', 'Original archive must contain exactly one supported FIT file.');
    }
}

export async function extractGarminActivity(zipPath: string, directory: string, activity: Activity): Promise<string> {
    let files: JSZip.JSZipObject[];
    try {
        const zip = await archive(zipPath);
        files = Object.values(zip.files).filter(file => !file.dir && /\.(?:fit|tcx|gpx)$/i.test(file.name));
        if (files.length !== 1) throw new Error();
    } catch (_) {
        throw new SyncError('ACTIVITY_FILE_INVALID', 'Original archive must contain exactly one FIT, TCX or GPX activity file.');
    }
    const activityFile = files[0]!;
    if (path.extname(activityFile.name).toLowerCase() === '.fit') {
        try { return await writeEntry(activityFile, path.join(directory, 'original.fit')); }
        catch (_) { throw new SyncError('FIT_INVALID', 'Original archive contains an invalid FIT file.'); }
    }
    if (path.extname(activityFile.name).toLowerCase() === '.tcx') {
        try { return await writeEntry(activityFile, path.join(directory, 'original.tcx')); }
        catch (_) { throw new SyncError('TCX_INVALID', 'Original archive contains an invalid TCX file.'); }
    }

    let converted: Buffer;
    try { converted = gpxToTcx(await entryBytes(activityFile), activity); }
    catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('GPX_INVALID', 'Original archive contains an invalid GPX file.');
    }
    if (converted.length < MIN_ACTIVITY_BYTES || converted.length > MAX_ACTIVITY_BYTES) {
        throw new SyncError('GPX_INVALID', 'Converted TCX file size is unsupported.');
    }
    const evidence = tcxEvidence(converted);
    const durationTolerance = Math.max(5, (activity.duration ?? evidence.duration ?? 0) * 0.01);
    const distanceTolerance = Math.max(20, (activity.distance ?? evidence.distance ?? 0) * 0.01);
    if (evidence.sport !== activity.sport || Math.abs(evidence.start - activity.start) > 2000 ||
        (activity.duration !== null && (evidence.duration === null || Math.abs(evidence.duration - activity.duration) > durationTolerance)) ||
        (activity.distance !== null && (evidence.distance === null || Math.abs(evidence.distance - activity.distance) > distanceTolerance))) {
        throw new SyncError('GPX_INVALID', 'Converted TCX summary does not match the Garmin activity.');
    }
    const destination = path.join(directory, 'original.tcx');
    let handle: fs.promises.FileHandle | undefined;
    let created = false;
    try {
        handle = await fs.promises.open(destination, 'wx', 0o600);
        created = true;
        await handle.writeFile(converted);
        await handle.sync();
        await handle.close();
        handle = undefined;
        return destination;
    } catch (_) {
        await handle?.close().catch(() => {});
        if (created) await fs.promises.rm(destination, { force: true }).catch(() => {});
        throw new SyncError('GPX_INVALID', 'Converted TCX file could not be written safely.');
    }
}
