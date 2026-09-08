import { spawn } from 'node:child_process';
import { SyncError } from '../core/errors';

export class GitHubSecrets {
    constructor(private readonly repository: string, private readonly token?: string) {
        if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
            throw new SyncError('CONFIG', 'A GitHub repository in OWNER/REPO format is required.');
        }
    }

    private run(args: string[], input = ''): Promise<void> {
        return new Promise((resolve, reject) => {
            // Never pass credentials in arguments or relay GitHub CLI output to the log.
            const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
            if (this.token) env.GH_TOKEN = this.token;
            const child = spawn('gh', args, { env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 60000 });
            const failed = () => reject(new SyncError('GITHUB_SECRETS',
                'Cannot access GitHub Secrets. Check GH_SECRETS_TOKEN, its expiration and repository Secrets write permission.'));
            child.on('error', failed);
            child.on('close', code => code === 0 ? resolve() : failed());
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        });
    }

    check(): Promise<void> {
        return this.run(['api', `repos/${this.repository}/actions/secrets/public-key`, '--silent']);
    }

    set(name: string, value: string): Promise<void> {
        if (!['GARMIN_OAUTH1', 'GARMIN_GLOBAL_OAUTH1'].includes(name)) {
            throw new SyncError('CONFIG', 'Only Garmin OAuth1 Secrets may be updated.');
        }
        return this.run(['secret', 'set', name, '--repo', this.repository], value);
    }
}
