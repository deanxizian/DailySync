export const SLOTS = ['garmin-cn', 'coros-cn'] as const;
export type Slot = typeof SLOTS[number];

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

export interface ImportReceipt {
    status: 'accepted' | 'pending' | 'duplicate' | 'failed' | 'retryable' | 'unknown';
    stage?: 'submitted' | 'finished';
    targetId?: string;
    taskId?: string;
    code?: string;
}

export interface Transfer {
    sourceId: string;
    filename: string;
    evidence: Evidence;
    receipt?: ImportReceipt;
}

export interface SavedSession {
    loginHash: string;
    token: { oauth1: Record<string, any>; oauth2: Record<string, any> };
}

export interface PlatformAdapter {
    readonly slot: Slot;
    connect(saved?: SavedSession): Promise<string>;
    page(cursor: number, window?: ActivityWindow): Promise<{ activities: Activity[]; next: number | null; total?: number }>;
    download(activity: Activity, directory: string): Promise<string>;
    supports(activity: Activity): boolean;
    upload(file: string, transfer: Transfer): Promise<ImportReceipt>;
    verify(transfer: Transfer): Promise<ImportReceipt>;
}

export function activityKey(slot: Slot, id: string): string {
    return `${slot}:${id}`;
}
