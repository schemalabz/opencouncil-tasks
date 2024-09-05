import fs from 'fs';

export const getFromEnvOrFile = (key: string, path: string) => {
    if (process.env[key]) {
        return process.env[key];
    }
    return JSON.parse(fs.readFileSync(path, 'utf8'))[key];
}