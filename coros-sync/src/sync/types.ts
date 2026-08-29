export const SLOTS = ['garmin-cn', 'coros-cn'] as const;
export type Slot = typeof SLOTS[number];
export const ROUTES = [
    { name: 'garmin-to-coros', source: 'garmin-cn', target: 'coros-cn' },
] as const;
export type RouteName = typeof ROUTES[number]['name'];

export interface Activity {
    slot: Slot;
    id: string;
    start: number;
    sport: string;
    duration: number | null;
    distance: number | null;
    sportCode?: number;
}

export interface ActivityWindow {
    start: number;
    end: number;
}

export interface Evidence {
    sha256: string;
    device?: string;
    records?: string;
    start: number;
    sport: string;
    duration: number | null;
    distance: number | null;
}

export interface ActivityRecord {
    activity: Activity;
    canonical: string;
    evidence?: Evidence;
    missing: number;
}

export interface ImportReceipt {
    status: 'accepted' | 'pending' | 'duplicate' | 'failed' | 'retryable' | 'unknown';
    stage?: 'submitted' | 'finished';
    targetId?: string;
    taskId?: string;
    code?: string;
}

export interface Transfer {
    canonical: string;
    source: Slot;
    sourceId: string;
    target: Slot;
    status: 'pending' | 'uploading' | 'verifying' | 'complete' | 'failed' | 'review' | 'ignored';
    attempt: string;
    filename: string;
    createdAt: number;
    beforeIds?: string[];
    evidence?: Evidence;
    candidates?: string[];
    receipt?: ImportReceipt;
    code?: string;
}

export interface SavedSession {
    loginHash: string;
    token: { oauth1: Record<string, any>; oauth2: Record<string, any> };
}

export interface SyncState {
    version: 1;
    accounts: Partial<Record<Slot, string>>;
    activities: Record<string, ActivityRecord>;
    transfers: Record<string, Transfer>;
    sessions: Partial<Record<Slot, SavedSession>>;
}

export interface UploadIntent {
    version: 1;
    accounts: Record<Slot, string>;
    source: ActivityRecord;
    transfer: Transfer;
}

export interface PlatformAdapter {
    readonly slot: Slot;
    connect(saved?: SavedSession): Promise<string>;
    session(): SavedSession | undefined;
    setWriteGuard?(guard: () => Promise<void>): void;
    page(cursor: number, window?: ActivityWindow): Promise<{ activities: Activity[]; next: number | null; total?: number }>;
    download(activity: Activity, directory: string): Promise<string>;
    supports(activity: Activity): boolean;
    upload(file: string, transfer: Transfer): Promise<ImportReceipt>;
    verify(transfer: Transfer): Promise<ImportReceipt>;
}

export function activityKey(slot: Slot, id: string): string {
    return `${slot}:${id}`;
}

export function transferKey(canonical: string, target: Slot): string {
    return `${canonical}:${target}`;
}

export function emptyState(): SyncState {
    return { version: 1, accounts: {}, activities: {}, transfers: {}, sessions: {} };
}
