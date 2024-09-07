import express, { Router } from 'express';
import dotenv from 'dotenv';
import { pipeline } from './tasks/pipeline.js';
import cors from 'cors';
import { taskManager } from './lib/TaskManager.js';
import path from 'path';
import { getExpressAppWithCallbacks, getFromEnvOrFile, validateUrl, validateYoutubeUrl } from './utils.js';
import { TranscribeRequest } from './types.js';

dotenv.config();


const app = getExpressAppWithCallbacks();


const corsOptions = {
    origin: process.env.CORS_ORIGINS_ALLOWED?.split(',') || "https://opencouncil.gr",
    methods: ['GET', 'POST'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

const apiTokensPath = path.join(process.cwd(), 'secrets', 'apiTokens.json');
const apiTokens = getFromEnvOrFile('API_TOKENS', apiTokensPath);

if (process.env.NO_AUTH !== 'true') {
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.split(' ')[1].trim();

        if (!apiTokens.includes(token)) {
            return res.status(403).json({ error: 'Invalid token' });
        }

        next();
    });
}

app.post('/transcribe', (
    req: express.Request<{}, {}, TranscribeRequest & { callbackUrl: string }>,
    res: express.Response,
    next: express.NextFunction
) => {
    const { youtubeUrl, callbackUrl } = req.body;

    if (!validateYoutubeUrl(youtubeUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    if (!validateUrl(callbackUrl)) {
        return res.status(400).json({ error: 'Invalid callback URL' });
    }

    next();
}, taskManager.serveTask(pipeline));

const testVideo = "https://www.youtube.com/watch?v=3ugZUq9nm4Y";

app.post('/test', async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {

    const resultPromise = pipeline({ youtubeUrl: testVideo }, () => { });
    res.status(200).json(await resultPromise);
}, taskManager.serveTask(pipeline));

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Shutting down gracefully...');

    // Stop the server from accepting new connections
    server.close(() => {
        console.log('Server closed. No longer accepting connections.');
    });

    try {
        // Wait for all running tasks to finish
        console.log('Waiting for all tasks to complete...');
        await taskManager.finish();
        console.log('All tasks completed.');
    } catch (error) {
        console.error('Error during graceful shutdown:', error);
    } finally {
        // Exit the process
        console.log('Exiting process.');
        process.exit(0);
    }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

if (process.argv.includes('--console')) {
    setInterval(taskManager.printTaskUpdates, 5000);
} else {
    setInterval(() => {
        const taskUpdates = taskManager.getTaskUpdates();
        const tasksRunning = taskUpdates.length;

        let longestRunningTaskDuration = 0;
        if (tasksRunning > 0) {
            const oldestTask = taskUpdates.reduce((oldest, current) =>
                oldest.createdAt < current.createdAt ? oldest : current
            );
            const durationSeconds = Math.floor((Date.now() - new Date(oldestTask.createdAt).getTime()) / 1000);
            longestRunningTaskDuration = durationSeconds;
        }

        console.log(JSON.stringify({
            type: 'task-updates',
            tasksRunning,
            longestRunningTaskDuration
        }));
    }, 5000);
}