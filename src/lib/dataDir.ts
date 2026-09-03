import fs from 'fs';
import path from 'path';

/** Read at call time so tests can point it at a temp directory. */
export const getDataDir = (): string => process.env.DATA_DIR || './data';

/** Path to a subdirectory of the data dir, created if missing. */
export const ensureDataSubdir = (name: string): string => {
    const dir = path.join(getDataDir(), name);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
};
