import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import JSZip from 'jszip';
import { Activity, Evidence } from './types';
import { SyncError } from './errors';
import { gpxToTcx, tcxEvidence } from './tcx';

export const MIN_ACTIVITY_BYTES = 14;
export const MAX_ACTIVITY_BYTES = 200 * 1024 * 1024;
export type ActivityFileFormat = 'fit' | 'tcx';

export function activityFileFormat(filename: string): ActivityFileFormat {
    const extension = path.extname(filename).toLowerCase();
    if (extension === '.fit' || extension === '.tcx') return extension.slice(1) as ActivityFileFormat;
    throw new SyncError('ACTIVITY_FILE_INVALID', 'Activity file must be FIT or TCX.');
}

export async function readEvidence(filename: string): Promise<Evidence> {
    const stat = await fs.promises.stat(filename);
    if (stat.size > MAX_ACTIVITY_BYTES || stat.size < MIN_ACTIVITY_BYTES) {
        throw new SyncError('ACTIVITY_FILE_INVALID', 'Activity file size is unsupported.');
    }
    if (activityFileFormat(filename) === 'tcx') return tcxEvidence(await fs.promises.readFile(filename));
    const decoder = path.resolve(__dirname, 'fit-decoder.mjs');
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [decoder, filename], { timeout: 60000, maxBuffer: 16384 }, (error, stdout) => {
            if (error) return reject(new SyncError('FIT_INVALID', 'Cannot validate a single complete FIT activity.'));
            try {
                const evidence = JSON.parse(stdout);
                if (!/^[a-f0-9]{64}$/.test(evidence.sha256) || !Number.isFinite(evidence.start)) throw new Error();
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
        return await writeEntry(files[0], destination);
    } catch (_) {
        throw new SyncError('FIT_INVALID', 'Original archive must contain exactly one supported FIT file.');
    }
}

export async function extractGarminActivity(zipPath: string, directory: string, activity: Activity): Promise<string> {
    let files: JSZip.JSZipObject[];
    try {
        const zip = await archive(zipPath);
        files = Object.values(zip.files).filter(file => !file.dir && /\.(?:fit|gpx)$/i.test(file.name));
        if (files.length !== 1) throw new Error();
    } catch (_) {
        throw new SyncError('ACTIVITY_FILE_INVALID', 'Original archive must contain exactly one FIT or GPX activity file.');
    }
    if (path.extname(files[0].name).toLowerCase() === '.fit') {
        try { return await writeEntry(files[0], path.join(directory, 'original.fit')); }
        catch (_) { throw new SyncError('FIT_INVALID', 'Original archive contains an invalid FIT file.'); }
    }

    let converted: Buffer;
    try { converted = gpxToTcx(await entryBytes(files[0]), activity); }
    catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('GPX_INVALID', 'Original archive contains an invalid GPX file.');
    }
    if (converted.length < MIN_ACTIVITY_BYTES || converted.length > MAX_ACTIVITY_BYTES) {
        throw new SyncError('GPX_INVALID', 'Converted TCX file size is unsupported.');
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
