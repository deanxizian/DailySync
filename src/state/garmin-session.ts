import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { garminAccountHash } from '../core/account';
import { SyncError } from '../core/errors';
import { GarminSlot, SavedSession } from '../core/types';
import { canonical, readEncrypted, writeEncrypted } from './encrypted-file';
import { GitHubSecrets } from './github-secrets';

export const GARMIN_SLOTS: GarminSlot[] = ['garmin-cn', 'garmin-global'];

interface OAuth1Secret {
    version: 1;
    loginHash: string;
    oauth1: Record<string, any>;
}

interface OAuth2Cache {
    scope: string;
    oauth2: Record<string, any>;
}

export interface SessionSettings {
    slot: GarminSlot;
    region: 'CN' | 'GLOBAL';
    username: string;
    password: string;
    secretName: 'GARMIN_OAUTH1' | 'GARMIN_GLOBAL_OAUTH1';
    secret?: string;
}

export function sessionSettings(slot: GarminSlot, env: NodeJS.ProcessEnv): SessionSettings {
    const prefix = slot === 'garmin-cn' ? 'GARMIN' : 'GARMIN_GLOBAL';
    return { slot, region: slot === 'garmin-cn' ? 'CN' : 'GLOBAL',
        username: env[`${prefix}_USERNAME`] ?? '', password: env[`${prefix}_PASSWORD`] ?? '',
        secretName: `${prefix}_OAUTH1`, secret: env[`${prefix}_OAUTH1`] || undefined };
}

function oauth1Secret(value: any, loginHash: string): OAuth1Secret {
    if (value?.version !== 1 || value.loginHash !== loginHash ||
        typeof value.oauth1?.oauth_token !== 'string' || !value.oauth1.oauth_token ||
        typeof value.oauth1?.oauth_token_secret !== 'string' || !value.oauth1.oauth_token_secret) {
        throw new SyncError('OAUTH1_INVALID', 'Garmin OAuth1 is invalid or belongs to another account.');
    }
    return { version: 1, loginHash, oauth1: JSON.parse(canonical(value.oauth1)) };
}

function cacheValue(value: any): OAuth2Cache {
    if (!/^[a-f0-9]{64}$/.test(value?.scope) ||
        typeof value.oauth2?.access_token !== 'string' || !value.oauth2.access_token ||
        !Number.isFinite(value.oauth2.expires_at)) throw new Error('Invalid OAuth2 cache.');
    return { scope: value.scope, oauth2: value.oauth2 };
}

function scope(secret: OAuth1Secret): string {
    return createHash('sha256').update(canonical(secret)).digest('hex');
}

export function sessionWarning(message: string): void {
    console.error(process.env.GITHUB_ACTIONS === 'true'
        ? `::warning title=Garmin Session::${message}` : `Warning: ${message}`);
}

export class GarminSessionStore {
    private current?: OAuth1Secret;
    private readonly loginHash: string;
    private readonly localOAuth1: string;
    readonly cacheFile: string;

    constructor(root: string, readonly settings: SessionSettings,
        private readonly options: { actions?: boolean; secrets?: Pick<GitHubSecrets, 'set'>;
            warn?: (message: string) => void } = {}) {
        if (!settings.username || !settings.password) throw new SyncError('CONFIG', 'Garmin username and password are required.');
        this.loginHash = garminAccountHash(settings.slot, settings.username);
        this.localOAuth1 = path.join(root, '.local', 'oauth1', `${settings.slot}.json`);
        this.cacheFile = path.join(root, '.local', 'oauth2', `${settings.slot}.json`);
    }

    private context(kind: 'oauth1' | 'oauth2'): string {
        return `DailySync\0${kind}\0v1\0${this.settings.slot}\0${this.loginHash}`;
    }

    async load(): Promise<SavedSession | undefined> {
        let value: unknown;
        if (!this.options.actions) {
            try { value = await readEncrypted(this.localOAuth1, this.settings.password, this.context('oauth1')); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw new SyncError('OAUTH1_INVALID', 'Cannot read local OAuth1. Check the password or use session:login to replace it.');
                }
            }
        }
        if (value === undefined) {
            if (!this.settings.secret) {
                if (!this.options.actions) return undefined;
                throw new SyncError('CONFIG', `Missing ${this.settings.secretName}. Initialize it with session:login locally.`);
            }
            try { value = JSON.parse(this.settings.secret); }
            catch (_) { throw new SyncError('OAUTH1_INVALID', `${this.settings.secretName} must contain a valid OAuth1 Secret.`); }
        }
        this.current = oauth1Secret(value, this.loginHash);
        let oauth2: Record<string, any> | undefined;
        try {
            const cached = cacheValue(await readEncrypted(this.cacheFile, this.settings.password, this.context('oauth2')));
            if (cached.scope === scope(this.current) && cached.oauth2.expires_at > Date.now() / 1000 + 60) {
                oauth2 = cached.oauth2;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                (this.options.warn ?? sessionWarning)(`${this.settings.slot}: ignoring an unreadable OAuth2 cache; using OAuth1.`);
            }
        }
        return { loginHash: this.loginHash, token: { oauth1: structuredClone(this.current.oauth1), oauth2 } };
    }

    cachePrefix(): string {
        if (!this.current) throw new SyncError('OAUTH1_INVALID', 'Load OAuth1 before preparing its cache.');
        return `dailysync-oauth2-v1-${this.settings.slot}-${scope(this.current)}-`;
    }

    async save(saved: SavedSession): Promise<void> {
        const next = oauth1Secret({ version: 1, loginHash: saved.loginHash, oauth1: saved.token.oauth1 }, this.loginHash);
        if (!this.current || canonical(this.current) !== canonical(next)) {
            if (this.options.actions && !this.options.secrets) throw new SyncError('CONFIG', 'OAuth1 updates require GH_SECRETS_TOKEN.');
            if (this.options.secrets) await this.options.secrets.set(this.settings.secretName, canonical(next));
        }
        if (!this.options.actions) {
            try { await writeEncrypted(this.localOAuth1, this.settings.password, this.context('oauth1'), next); }
            catch (_) { throw new SyncError('OAUTH1_SAVE', 'Cannot save the verified Garmin OAuth1 locally.'); }
        }
        this.current = next;
        try {
            const cached = cacheValue({ scope: scope(next), oauth2: saved.token.oauth2 });
            await writeEncrypted(this.cacheFile, this.settings.password, this.context('oauth2'), cached);
        } catch (_) {
            (this.options.warn ?? sessionWarning)(`${this.settings.slot}: OAuth2 cache could not be saved; OAuth1 remains available.`);
        }
    }

    async cacheSnapshot(): Promise<{ key: string; hash: string } | undefined> {
        try {
            const cached = cacheValue(await readEncrypted(this.cacheFile, this.settings.password, this.context('oauth2')));
            if (cached.oauth2.expires_at <= Date.now() / 1000 + 60) return undefined;
            const hash = createHash('sha256').update(await fs.readFile(this.cacheFile)).digest('hex');
            return { key: `dailysync-oauth2-v1-${this.settings.slot}-${cached.scope}-${hash}`, hash };
        } catch (_) { return undefined; }
    }
}
