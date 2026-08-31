import path from 'path';
import { safeError, SyncError } from '../core/errors';
import { runBridge } from './bridge';
import { loadPrivateEnvironment, parseMode, parseRoute, parseRunOptions } from './config';
import { withRunLock } from './lock';

function usage(): string {
    return 'Usage: dailysync <sync|migration> <route> [--activity-id ID] [--json]';
}

async function main(): Promise<number> {
    const root = path.resolve(__dirname, '../..');
    loadPrivateEnvironment(root);
    const mode = parseMode(process.argv[2] ?? '');
    const route = parseRoute(process.argv[3] ?? '');
    const options = parseRunOptions(process.argv.slice(4));
    if (options.help) {
        console.log(usage());
        return 0;
    }
    if (mode === 'migration' && options.activityId) {
        throw new SyncError('USAGE', '--activity-id is available only for daily synchronization.');
    }
    const result = await withRunLock(root, () => runBridge(root, route, mode, options.activityId));
    if (options.json) console.log(JSON.stringify(result));
    else {
        console.log(`${result.route} ${result.mode}: ${result.outcome}`);
        console.log(`uploaded=${result.counts.uploaded} existing=${result.counts.existing} ` +
            `review=${result.counts.review} unsupported=${result.counts.unsupported} failed=${result.counts.failed}`);
        if (result.transferLimitReached) console.log(`Transfer limit reached (${result.limit}); run the migration again to continue.`);
    }
    return result.exitCode;
}

main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(safeError(error));
    console.error(usage());
    process.exitCode = 2;
});
