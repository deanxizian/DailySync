import fs from 'fs';
import path from 'path';
import { parse } from 'dotenv';
import { Slot, SLOTS } from './types';
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
    command: 'sync' | 'state' | 'link' | 'ignore' | 'retry';
    apply: boolean;
    json: boolean;
    help: boolean;
    activityId?: string;
    migrateStart?: number;
    timeBudget?: number;
    retryFailed: boolean;
    source?: string;
    target?: string;
    confirmNotImported: boolean;
}

export function parseOptions(args: string[]): CliOptions {
    const options: CliOptions = { command: 'sync', apply: false, json: false, help: false, retryFailed: false,
        confirmNotImported: false };
    const commands = ['sync', 'state', 'link', 'ignore', 'retry'];
    if (args[0] && !args[0].startsWith('-')) {
        if (!commands.includes(args[0])) throw new SyncError('USAGE', 'Unknown command. Run the selected COROS script with --help.');
        options.command = args[0] as CliOptions['command'];
        args = args.slice(1);
    }
    const booleans: Record<string, keyof CliOptions> = { '--apply': 'apply', '--json': 'json', '--help': 'help', '-h': 'help',
        '--retry-failed': 'retryFailed', '--confirm-not-imported': 'confirmNotImported' };
    const values: Record<string, keyof CliOptions> = { '--activity-id': 'activityId',
        '--migrate-start': 'migrateStart', '--time-budget': 'timeBudget', '--source': 'source', '--target': 'target' };
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const at = args[i].indexOf('=');
        const name = at < 0 ? args[i] : args[i].slice(0, at);
        if (seen.has(name)) throw new SyncError('USAGE', 'Duplicate command option.');
        seen.add(name);
        if (booleans[name]) {
            if (at >= 0) throw new SyncError('USAGE', 'Boolean flags do not accept values.');
            (options as any)[booleans[name]] = true;
        } else if (values[name]) {
            const value = at < 0 ? args[++i] : args[i].slice(at + 1);
            if (!value || value.startsWith('-')) throw new SyncError('USAGE', 'Missing command option value.');
            if (['--migrate-start', '--time-budget'].includes(name)) {
                if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
                    (name === '--time-budget' && Number(value) < 30)) {
                    throw new SyncError('USAGE', 'Invalid migration start or time budget (minimum 30 seconds).');
                }
                (options as any)[values[name]] = Number(value);
            } else (options as any)[values[name]] = value;
        } else throw new SyncError('USAGE', 'Unknown command option. Run the selected COROS script with --help.');
    }
    if (options.help) return options;
    if (options.activityId) remoteId(options.activityId);
    if (options.command !== 'sync' && (options.apply || options.activityId || options.migrateStart !== undefined || options.retryFailed)) {
        throw new SyncError('USAGE', 'Sync execution options are only valid for the sync command.');
    }
    if (['link', 'ignore', 'retry'].includes(options.command) && (!options.source || !options.target)) {
        throw new SyncError('USAGE', 'This command requires --source and --target.');
    }
    if (options.command === 'retry' && !options.confirmNotImported) {
        throw new SyncError('USAGE', 'Retry requires --confirm-not-imported after checking COROS.');
    }
    const allowedExtras: Record<string, CliOptions['command'][]> = {
        source: ['link', 'ignore', 'retry'], target: ['link', 'ignore', 'retry'], confirmNotImported: ['retry'],
    };
    for (const [key, allowed] of Object.entries(allowedExtras)) {
        if ((options as any)[key] && !allowed.includes(options.command)) throw new SyncError('USAGE', 'Option does not apply to this command.');
    }
    return options;
}

export function parseActivityReference(value: string): { slot: Slot; id: string } {
    const at = value.indexOf(':');
    const slot = value.slice(0, at) as Slot;
    if (at < 0 || !SLOTS.includes(slot)) throw new SyncError('USAGE', 'Activity reference must be account-slot:activity-id.');
    return { slot, id: remoteId(value.slice(at + 1)) };
}

export function requireGarminAccount(env: NodeJS.ProcessEnv): void {
    if (!env.GARMIN_USERNAME) throw new SyncError('CONFIG', 'GARMIN_USERNAME is required; GARMIN_PASSWORD is deliberately unused.');
}

export function requireBridgeAccounts(env: NodeJS.ProcessEnv): void {
    requireGarminAccount(env);
    const missing = ['COROS_USERNAME', 'COROS_PASSWORD'].filter(name => !env[name]);
    if (missing.length) throw new SyncError('CONFIG', `Missing COROS settings: ${missing.join(', ')}.`);
}
