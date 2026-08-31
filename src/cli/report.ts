import fs from 'node:fs/promises';
import type { BridgeResult } from './bridge';
import { SyncEvent } from '../core/engine';

const ATTENTION = new Set<SyncEvent['status']>(['review', 'verifying', 'failed', 'unsupported', 'deferred']);

export interface AttentionGroup {
    status: SyncEvent['status'];
    code: string;
    count: number;
    examples: string[];
}

function eventCode(event: SyncEvent): string {
    return event.code ?? (event.status === 'unsupported' ? 'UNSUPPORTED_ACTIVITY' : event.status.toUpperCase());
}

export function groupAttention(events: SyncEvent[], exampleLimit = 3): AttentionGroup[] {
    const groups = new Map<string, AttentionGroup>();
    for (const event of events) {
        if (!ATTENTION.has(event.status)) continue;
        const code = eventCode(event);
        const key = `${event.status}\0${code}`;
        const group = groups.get(key) ?? { status: event.status, code, count: 0, examples: [] };
        group.count++;
        if (group.examples.length < exampleLimit) group.examples.push(event.source);
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function compactResult(result: BridgeResult): Omit<BridgeResult, 'events'> & {
    transfers: Array<Pick<SyncEvent, 'source' | 'targetId'>>;
    attention: AttentionGroup[];
} {
    const { events, ...summary } = result;
    return {
        ...summary,
        transfers: events.filter(event => event.status === 'uploaded')
            .map(event => ({ source: event.source, targetId: event.targetId })),
        attention: groupAttention(events),
    };
}

function commandValue(value: string): string {
    return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function markdownValue(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export async function reportGitHub(result: BridgeResult, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (env.GITHUB_ACTIONS !== 'true') return;
    const attention = groupAttention(result.events);
    for (const group of attention) {
        const examples = group.examples.length ? ` Examples: ${group.examples.join(', ')}.` : '';
        console.error(`::warning title=${commandValue(`DailySync ${group.code}`)}::${commandValue(
            `${group.count} activity item(s) need attention.${examples}`)}`);
    }
    if (!env.GITHUB_STEP_SUMMARY) return;
    const rows = [
        '## DailySync result',
        '',
        '| Route | Mode | Outcome | Uploaded | Existing | Attention |',
        '| --- | --- | --- | ---: | ---: | ---: |',
        `| ${markdownValue(result.route)} | ${result.mode} | ${result.outcome} | ${result.counts.uploaded} | ` +
            `${result.counts.existing} | ${attention.reduce((total, group) => total + group.count, 0)} |`,
    ];
    if (result.transferLimitReached) rows.push('', `Transfer limit reached (${result.limit}); run the migration again to continue.`);
    if (attention.length) {
        rows.push('', '| Status | Code | Count | Examples |', '| --- | --- | ---: | --- |');
        for (const group of attention) {
            rows.push(`| ${group.status} | ${markdownValue(group.code)} | ${group.count} | ` +
                `${markdownValue(group.examples.join(', '))} |`);
        }
    }
    try { await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`, 'utf8'); }
    catch (_) { console.error('::warning title=DailySync report::Could not write the GitHub step summary.'); }
}
