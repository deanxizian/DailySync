import fs from 'node:fs/promises';
import path from 'node:path';
import { safeError, SyncError } from '../core/errors';
import { GARMIN_SLOTS, GarminSessionStore, sessionSettings } from '../state/garmin-session';

async function main(): Promise<void> {
    const command = process.argv[2];
    if (!['prepare', 'inspect'].includes(command ?? '') || !process.env.GITHUB_OUTPUT) {
        throw new SyncError('USAGE', 'Session cache preparation requires GitHub Actions outputs.');
    }
    const root = path.resolve(__dirname, '../..');
    const output: string[] = [];
    for (const slot of GARMIN_SLOTS) {
        const settings = sessionSettings(slot, process.env);
        if (!settings.username && !settings.password && !settings.secret) continue;
        const store = new GarminSessionStore(root, settings, { actions: true });
        const name = slot === 'garmin-cn' ? 'cn' : 'global';
        if (command === 'prepare') {
            await store.load();
            output.push(`${name}_prefix=${store.cachePrefix()}`);
        } else {
            const snapshot = await store.cacheSnapshot();
            if (snapshot) output.push(`${name}_key=${snapshot.key}`, `${name}_hash=${snapshot.hash}`);
        }
    }
    await fs.appendFile(process.env.GITHUB_OUTPUT, `${output.join('\n')}\n`, 'utf8');
}

main().catch(error => { console.error(safeError(error)); process.exitCode = 2; });
