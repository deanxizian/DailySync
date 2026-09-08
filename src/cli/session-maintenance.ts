import path from 'node:path';
import { safeError, SyncError } from '../core/errors';
import { GarminAdapter } from '../platforms/garmin';
import { GarminSessionStore, sessionSettings } from '../state/garmin-session';
import { GitHubSecrets } from '../state/github-secrets';
import { loadPrivateEnvironment, parseSessionOptions } from './config';
import { withRunLock } from './lock';

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command !== 'check' && command !== 'login') throw new SyncError('USAGE', 'Use session:check or session:login.');
    if (process.env.GITHUB_ACTIONS === 'true') throw new SyncError('USAGE', 'Session maintenance must run locally.');
    const root = path.resolve(__dirname, '../..');
    loadPrivateEnvironment(root);
    const options = parseSessionOptions(process.argv.slice(3));
    if (command === 'check' && options.repository) throw new SyncError('USAGE', '--repo is only available with session:login.');
    await withRunLock(root, async () => {
        const settings = sessionSettings(options.region === 'CN' ? 'garmin-cn' : 'garmin-global', process.env);
        const secrets = options.repository ? new GitHubSecrets(options.repository, process.env.GH_SECRETS_TOKEN) : undefined;
        if (secrets) await secrets.check();
        const store = new GarminSessionStore(root, settings, { secrets });
        const saved = command === 'check' ? await store.load() : undefined;
        if (command === 'check' && !saved) throw new SyncError('OAUTH1_INVALID', 'No local OAuth1 exists. Run session:login first.');
        const adapter = new GarminAdapter({ ...settings, onSession: session => store.save(session) });
        await adapter.connect(saved);
        console.log(`${settings.slot}: authenticated; OAuth1 ${secrets ? 'saved to GitHub Secrets' : 'saved locally'}.`);
    });
}

main().catch(error => { console.error(safeError(error)); process.exitCode = 2; });
