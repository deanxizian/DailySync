import path from 'path';
import { safeError, SyncError } from '../core/errors';
import { GarminAdapter } from '../platforms/garmin';
import { checkGarminSessionDatabase, GarminCredentials, rekeyGarminSession,
    loadGarminSession, replaceGarminSession } from '../state/session-db';
import { loadPrivateEnvironment, parseSessionOptions, requireSecrets } from './config';
import { withRunLock } from './lock';

function credentials(region: 'CN' | 'GLOBAL'): GarminCredentials {
    if (region === 'CN') {
        requireSecrets(process.env, ['GARMIN_USERNAME', 'GARMIN_PASSWORD']);
        return { region, slot: 'garmin-cn', username: process.env.GARMIN_USERNAME!, password: process.env.GARMIN_PASSWORD! };
    }
    requireSecrets(process.env, ['GARMIN_GLOBAL_USERNAME', 'GARMIN_GLOBAL_PASSWORD']);
    return { region, slot: 'garmin-global', username: process.env.GARMIN_GLOBAL_USERNAME!,
        password: process.env.GARMIN_GLOBAL_PASSWORD! };
}

async function hiddenStdin(): Promise<string> {
    if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        const value = Buffer.concat(chunks).toString('utf8');
        return value.replace(/\r?\n$/, '');
    }
    if (!process.stdin.setRawMode) throw new SyncError('INPUT', 'Cannot read a hidden password from this terminal.');
    process.stdout.write('New Garmin password: ');
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const restore = () => {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdout.write('\n');
        };
        process.stdin.on('data', function onData(chunk: string) {
            for (const character of chunk) {
                if (character === '\u0003') {
                    process.stdin.off('data', onData);
                    restore();
                    reject(new SyncError('INPUT', 'Password input was cancelled.'));
                    return;
                }
                if (character === '\n' || character === '\r') {
                    process.stdin.off('data', onData);
                    restore();
                    resolve(value);
                    return;
                }
                if (character === '\b' || character === '\u007f') value = [...value].slice(0, -1).join('');
                else value += character;
            }
        });
    });
}

async function main(): Promise<void> {
    const root = path.resolve(__dirname, '../..');
    const command = process.argv[2];
    const database = path.join(root, 'db', 'garmin.db');
    loadPrivateEnvironment(root);
    if (command === 'check') {
        if (process.argv.length !== 3) throw new SyncError('USAGE', 'Session check does not accept options.');
        await withRunLock(root, async () => {
            await checkGarminSessionDatabase(database);
            const regions: Array<'CN' | 'GLOBAL'> = [];
            if (process.env.GARMIN_USERNAME || process.env.GARMIN_PASSWORD) regions.push('CN');
            if (process.env.GARMIN_GLOBAL_USERNAME || process.env.GARMIN_GLOBAL_PASSWORD) regions.push('GLOBAL');
            if (!regions.length) throw new SyncError('CONFIG', 'Session check requires Garmin account credentials.');
            for (const region of regions) {
                const current = credentials(region);
                if (!await loadGarminSession(database, current)) {
                    throw new SyncError('SESSION_MISSING', `No ${region} Garmin Session exists.`);
                }
            }
            console.log('Garmin Session database is valid.');
        });
        return;
    }
    if (command !== 'rekey' && command !== 'reset') {
        throw new SyncError('USAGE', 'Use session-maintenance rekey, reset or check.');
    }
    const options = parseSessionOptions(process.argv.slice(3));
    if (command === 'rekey' && options.confirmReset) {
        throw new SyncError('USAGE', '--confirm-reset is available only for Session reset.');
    }
    await withRunLock(root, async () => {
        if (command === 'rekey') {
            const current = credentials(options.region);
            const next = await hiddenStdin();
            await rekeyGarminSession(database, current, next);
            await checkGarminSessionDatabase(database);
            console.log(`${options.region} Garmin Session was re-encrypted. Update the matching GitHub Password Secret now.`);
            return;
        }
        if (command === 'reset') {
            if (process.env.CI || !options.confirmReset) {
                throw new SyncError('USAGE', 'Session reset is local-only and requires --confirm-reset.');
            }
            const current = credentials(options.region);
            const client = new GarminAdapter({ region: current.region, username: current.username,
                password: current.password, writable: false });
            await client.connect();
            const saved = client.exportSession();
            if (!saved) throw new SyncError('SESSION_INVALID', 'Garmin did not return a valid OAuth Session.');
            await replaceGarminSession(database, current, saved);
            await checkGarminSessionDatabase(database);
            console.log(`${options.region} Garmin Session was replaced after a successful password login.`);
            return;
        }
    });
}

main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 2;
});
