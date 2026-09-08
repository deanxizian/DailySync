import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function canonical(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    }
    throw new Error('Invalid Session value.');
}

function key(password: string, salt: Buffer): Buffer {
    if (!password) throw new Error('Encryption requires a password.');
    return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function bytes(value: unknown, length?: number): Buffer {
    if (typeof value !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error('Invalid encrypted file.');
    const result = Buffer.from(value, 'hex');
    if (length !== undefined && result.length !== length) throw new Error('Invalid encrypted file.');
    return result;
}

export async function readEncrypted(filename: string, password: string, context: string): Promise<unknown> {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid encrypted file.');
    const envelope = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (envelope.version !== 1) throw new Error('Invalid encrypted file.');
    const secret = key(password, bytes(envelope.salt, 16));
    try {
        const decipher = createDecipheriv('aes-256-gcm', secret, bytes(envelope.iv, 12));
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(bytes(envelope.tag, 16));
        return JSON.parse(Buffer.concat([decipher.update(bytes(envelope.ciphertext)), decipher.final()]).toString('utf8'));
    } finally { secret.fill(0); }
}

export async function writeEncrypted(filename: string, password: string, context: string, value: unknown): Promise<boolean> {
    const plaintext = canonical(value);
    try {
        if (canonical(await readEncrypted(filename, password, context)) === plaintext) return false;
    } catch (_) {}
    const salt = randomBytes(16), iv = randomBytes(12);
    const secret = key(password, salt);
    let contents: string;
    try {
        const cipher = createCipheriv('aes-256-gcm', secret, iv);
        cipher.setAAD(Buffer.from(context));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        contents = JSON.stringify({ version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'),
            tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
    } finally { secret.fill(0); }
    const directory = path.dirname(filename);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, filename);
        return true;
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
