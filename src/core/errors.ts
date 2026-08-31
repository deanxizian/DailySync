export class SyncError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'SyncError';
    }
}

export function safeError(error: unknown): string {
    return error instanceof SyncError ? `${error.code}: ${error.message}` : 'UNEXPECTED: Operation failed; raw error details suppressed.';
}

export function remoteId(value: unknown): string {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
        throw new SyncError('PROTOCOL', 'Unsafe numeric activity or account ID.');
    }
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[A-Za-z0-9_-]{1,128}$/.test(String(value))) {
        throw new SyncError('PROTOCOL', 'Missing or invalid activity or account ID.');
    }
    return String(value);
}

export function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value))) return null;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
