import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import JSZip from 'jszip';
import { Evidence } from './types';
import { SyncError } from './errors';

export const MIN_FIT_BYTES = 14;
export const MAX_FIT_BYTES = 200 * 1024 * 1024;

export async function readEvidence(filename: string): Promise<Evidence> {
    const stat = await fs.promises.stat(filename);
    if (stat.size > MAX_FIT_BYTES || stat.size < MIN_FIT_BYTES) throw new SyncError('FIT_INVALID', 'FIT file size is unsupported.');
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

export async function extractSingleFit(zipPath: string, destination: string): Promise<string> {
    let created = false;
    try {
        const stat = await fs.promises.stat(zipPath);
        if (stat.size > MAX_FIT_BYTES) throw new Error();
        const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
        const files = Object.values(zip.files).filter(file => !file.dir && /\.fit$/i.test(file.name));
        if (files.length !== 1) throw new Error();
        let size = 0;
        const limit = new Transform({ transform(chunk, _encoding, done) {
            size += chunk.length;
            done(size > MAX_FIT_BYTES ? new Error('File too large') : null, chunk);
        } });
        // Never use the archive's path as a filesystem destination.
        const output = fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' });
        output.once('open', () => { created = true; });
        await pipeline(files[0].nodeStream(), limit, output);
        return destination;
    } catch (_) {
        if (created) await fs.promises.rm(destination, { force: true });
        throw new SyncError('FIT_INVALID', 'Original archive must contain exactly one supported FIT file.');
    }
}
