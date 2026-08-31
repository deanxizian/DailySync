import { createHash } from 'crypto';
import { GarminSlot } from './types';

export function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

export function garminAccountHash(slot: GarminSlot, username: string): string {
    return createHash('sha256').update(`${slot}:${normalizeUsername(username)}`).digest('hex');
}
