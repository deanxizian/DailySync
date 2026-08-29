import path from 'path';
import { safeError } from './sync/errors';
import { initializeCorosState } from './sync/git-checkpoint';

initializeCorosState(path.resolve(__dirname, '..', '..'))
    .then(() => { console.log('COROS synchronization state initialized.'); })
    .catch(error => { console.error(safeError(error)); process.exitCode = 1; });
