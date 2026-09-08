import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { remoteId, SyncError } from '../core/errors';
import { SyncRoute } from '../core/types';

export const SECRET_NAMES = [
    'GARMIN_USERNAME',
    'GARMIN_PASSWORD',
    'GARMIN_GLOBAL_USERNAME',
    'GARMIN_GLOBAL_PASSWORD',
    'COROS_USERNAME',
    'COROS_PASSWORD',
    'GARMIN_OAUTH1',
    'GARMIN_GLOBAL_OAUTH1',
    'GH_SECRETS_TOKEN',
] as const;

export type SecretName = typeof SECRET_NAMES[number];
export type RunMode = 'sync' | 'migration';

export interface CliOptions {
    activityId?: string;
    json: boolean;
    help: boolean;
}

export interface SessionOptions {
    region: 'CN' | 'GLOBAL';
    repository?: string;
}

export function loadPrivateEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): void {
    for (const name of ['.env.local', '.env']) {
        const filename = path.join(root, name);
        if (!fs.existsSync(filename)) continue;
        if (process.platform !== 'win32' && (fs.statSync(filename).mode & 0o077)) {
            throw new SyncError('CONFIG', `${name} contains account credentials and must use chmod 600.`);
        }
        const values = parse(fs.readFileSync(filename));
        for (const key of SECRET_NAMES) {
            if (env[key] === undefined && values[key] !== undefined) env[key] = values[key];
        }
    }
}

export function requireSecrets(env: NodeJS.ProcessEnv, names: SecretName[]): void {
    const missing = names.filter(name => !env[name]);
    if (missing.length) throw new SyncError('CONFIG', `Missing account settings: ${missing.join(', ')}.`);
}

export function parseRunOptions(args: string[]): CliOptions {
    const options: CliOptions = { json: false, help: false };
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index]!;
        const separator = argument.indexOf('=');
        const name = separator < 0 ? argument : argument.slice(0, separator);
        if (seen.has(name)) throw new SyncError('USAGE', `Duplicate option: ${name}.`);
        seen.add(name);
        if (['--json', '--help', '-h'].includes(name)) {
            if (separator >= 0) throw new SyncError('USAGE', `${name} does not accept a value.`);
            if (name === '--json') options.json = true;
            else options.help = true;
            continue;
        }
        if (name !== '--activity-id') throw new SyncError('USAGE', `Unknown option: ${name}.`);
        const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
        if (!value || value.startsWith('-')) throw new SyncError('USAGE', 'Missing --activity-id value.');
        options.activityId = remoteId(value);
    }
    return options;
}

export function parseSessionOptions(args: string[]): SessionOptions {
    let region: SessionOptions['region'] | undefined;
    let repository: string | undefined;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--region') {
            if (region) throw new SyncError('USAGE', 'The Garmin region may be specified only once.');
            const value = args[++index]?.toUpperCase();
            if (value !== 'CN' && value !== 'GLOBAL') {
                throw new SyncError('USAGE', 'Use --region CN or --region GLOBAL.');
            }
            region = value;
            continue;
        }
        if (argument === '--repo' && !repository) {
            const value = args[++index];
            if (!value || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
                throw new SyncError('USAGE', 'Use --repo OWNER/REPO.');
            }
            repository = value;
            continue;
        }
        throw new SyncError('USAGE', `Unknown or duplicate maintenance option: ${argument ?? ''}.`);
    }
    if (!region) throw new SyncError('USAGE', 'Use --region CN or --region GLOBAL.');
    return { region, repository };
}

export function parseRoute(value: string): SyncRoute {
    const routes: SyncRoute[] = [
        'garmin-cn-to-garmin-global',
        'garmin-global-to-garmin-cn',
        'garmin-cn-to-coros-cn',
        'coros-cn-to-garmin-cn',
    ];
    if (!routes.includes(value as SyncRoute)) throw new SyncError('USAGE', 'Unknown synchronization route.');
    return value as SyncRoute;
}

export function parseMode(value: string): RunMode {
    if (value !== 'sync' && value !== 'migration') throw new SyncError('USAGE', 'Mode must be sync or migration.');
    return value;
}
