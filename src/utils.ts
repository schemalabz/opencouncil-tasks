import fs from 'fs';
import express, { Router } from 'express';
import { CallbackServer } from './lib/CallbackServer.js';

export const tryGetFromEnvOrFile = (key: string, path: string) => {
    if (process.env[key]) {
        console.log(`Using ${key} from environment`);
        return JSON.parse(process.env[key] as string);
    }
    if (fs.existsSync(path)) {
        console.log(`Using ${key} from file`);
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    }

    return null;
}

export const getFromEnvOrFile = (key: string, path: string) => {
    const value = tryGetFromEnvOrFile(key, path);
    if (!value) {
        throw new Error(`Missing ${key} in environment or file ${path}`);
    }
    return value;
}

export const validateUrl = (url: string) => /^(https?:\/\/)?([\da-z\.-]+\.([a-z\.]{2,6})|localhost)(:\d+)?(\/[\w\.-]*)*\/?$/.test(url);
export const validateYoutubeUrl = (url: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/.test(url);

export const getExpressAppWithCallbacks = () => {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(express.json({ limit: '100mb' }));

    const callbackRouter = Router();
    const callbackServer = CallbackServer.getInstance(callbackRouter, '/callback');
    app.use('/callback', callbackRouter);
    return app;
}
export const formatTime = (time: number): string => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};