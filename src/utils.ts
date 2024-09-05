import fs from 'fs';
import express, { Router } from 'express';
import { CallbackServer } from './lib/CallbackServer';
import chalk from 'chalk';

export const getFromEnvOrFile = (key: string, path: string) => {
    if (process.env[key]) {
        return process.env[key];
    }
    return JSON.parse(fs.readFileSync(path, 'utf8'))[key];
}

export const validateUrl = (url: string) => /^(https?:\/\/)?([\da-z\.-]+\.([a-z\.]{2,6})|localhost)(:\d+)?(\/[\w\.-]*)*\/?$/.test(url);
export const validateYoutubeUrl = (url: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/.test(url);

export const getExpressAppWithCallbacks = () => {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(express.json());

    const callbackRouter = Router();
    const callbackServer = CallbackServer.getInstance(callbackRouter, '/callback');
    app.use('/callback', callbackRouter);
    return app;
}
