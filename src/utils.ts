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

export const getExpressAppWithCallbacks = (): express.Express => {
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

/**
 * Utility class for compressing long IDs into shorter ones and vice versa.
 * Maintains a bidirectional mapping between long and short IDs.
 */
export class IdCompressor {
    private shortIdToLong = new Map<string, string>();
    private longIdToShort = new Map<string, string>();

    /**
     * Adds a long ID to the maps, generating a random short ID.
     * @param longId The long ID to compress
     * @returns The corresponding short ID
     */
    public addLongId(longId: string): string {
        if (this.longIdToShort.has(longId)) {
            return this.longIdToShort.get(longId)!;
        }

        // Short IDs are 8 characters long, using a-z, 0-9
        const shortId = Math.random().toString(36).substring(2, 10);
        if (this.shortIdToLong.has(shortId)) {
            return this.addLongId(longId);
        }

        this.shortIdToLong.set(shortId, longId);
        this.longIdToShort.set(longId, shortId);
        return shortId;
    }

    /**
     * Gets the long ID corresponding to a short ID.
     * @param shortId The short ID
     * @returns The corresponding long ID
     */
    public getLongId(shortId: string): string {
        if (!this.shortIdToLong.has(shortId)) {
            console.error(`Short ID ${shortId} not found`);
        }

        return this.shortIdToLong.get(shortId)!;
    }

    /**
     * Gets the short ID corresponding to a long ID.
     * @param longId The long ID
     * @returns The corresponding short ID
     */
    public getShortId(longId: string): string {
        if (!this.longIdToShort.has(longId)) {
            console.error(`Long ID ${longId} not found`);
        }

        return this.longIdToShort.get(longId)!;
    }
}