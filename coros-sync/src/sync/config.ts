import fs from 'fs';
import path from 'path';
import { parse } from 'dotenv';
import { remoteId, SyncError } from './errors';

export function loadPrivateEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
    const filename = path.join(root, 'coros-sync', '.env.local');
    if (!fs.existsSync(filename)) return;
    if (process.platform !== 'win32' && (fs.statSync(filename).mode & 0o077)) {
        throw new SyncError('CONFIG', 'Make coros-sync/.env.local private with chmod 600 before using account credentials.');
    }
    for (const [key, value] of Object.entries(parse(fs.readFileSync(filename)))) {
        if (env[key] === undefined) env[key] = value;
    }
}

export interface CliOptions {
    json: boolean;
    help: boolean;
    activityId?: string;
    migrateStart?: number;
    timeBudget?: number;
}

export function parseOptions(args: string[]): CliOptions {
    const options: CliOptions = { json: false, help: false };
    const booleans: Record<string, keyof CliOptions> = { '--json': 'json', '--help': 'help', '-h': 'help' };
    const values: Record<string, keyof CliOptions> = {
        '--activity-id': 'activityId', '--migrate-start': 'migrateStart', '--time-budget': 'timeBudget',
    };
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const separator = args[index].indexOf('=');
        const name = separator < 0 ? args[index] : args[index].slice(0, separator);
        if (seen.has(name)) throw new SyncError('USAGE', 'Duplicate command option.');
        seen.add(name);
        if (booleans[name]) {
            if (separator >= 0) throw new SyncError('USAGE', 'Boolean flags do not accept values.');
            (options as any)[booleans[name]] = true;
            continue;
        }
        if (!values[name]) throw new SyncError('USAGE', 'Unknown command option. Run the selected COROS script with --help.');
        const value = separator < 0 ? args[++index] : args[index].slice(separator + 1);
        if (!value || value.startsWith('-')) throw new SyncError('USAGE', 'Missing command option value.');
        if (name === '--migrate-start' || name === '--time-budget') {
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
                (name === '--time-budget' && Number(value) < 30)) {
                throw new SyncError('USAGE', 'Invalid migration start or time budget (minimum 30 seconds).');
            }
            (options as any)[values[name]] = Number(value);
        } else {
            (options as any)[values[name]] = remoteId(value);
        }
    }
    return options;
}

export function requireBridgeAccounts(env: NodeJS.ProcessEnv): void {
    const missing = ['GARMIN_USERNAME', 'COROS_USERNAME', 'COROS_PASSWORD'].filter(name => !env[name]);
    if (missing.length) throw new SyncError('CONFIG', `Missing account settings: ${missing.join(', ')}.`);
}
