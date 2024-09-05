import express from 'express';
import dotenv from 'dotenv';
import { pipeline, Task } from './tasks/pipeline';
import { diarize } from './tasks/diarize';
import cors from 'cors';
dotenv.config();
import { taskManager } from './lib/TaskManager';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const apiTokensPath = path.join(process.cwd(), 'secrets', 'apiTokens.json');
const apiTokens: string[] = JSON.parse(fs.readFileSync(apiTokensPath, 'utf-8'));
const app = express();
const port = process.env.PORT || 3000;

const corsOptions = {
    origin: process.env.CORS_ORIGINS_ALLOWED?.split(',') || "https://opencouncil.gr",
    methods: ['GET', 'POST'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

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

const validateUrl = (url: string) => /^(https?:\/\/)?([\da-z\.-]+\.([a-z\.]{2,6})|localhost)(:\d+)?(\/[\w\.-]*)*\/?$/.test(url);
const validateYoutubeUrl = (url: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/.test(url);

app.post('/transcribe', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { youtubeUrl, callbackUrl } = req.body;

    if (!validateYoutubeUrl(youtubeUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    if (!validateUrl(callbackUrl)) {
        return res.status(400).json({ error: 'Invalid callback URL' });
    }

    next();
}, taskManager.serveTask(pipeline));

app.post('/diarize', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { audioUrl, callbackUrl } = req.body;

    if (!validateUrl(audioUrl)) {
        return res.status(400).json({ error: 'Invalid audio URL' });
    }

    if (!validateUrl(callbackUrl)) {
        return res.status(400).json({ error: 'Invalid callback URL' });
    }

    next();
}, taskManager.serveTask(diarize));

async function printTaskUpdates() {
    console.clear();
    console.log(chalk.bold.underline('Currently Running Tasks:'));

    const tasks = taskManager.getTaskUpdates();

    if (tasks.length === 0) {
        console.log(chalk.italic.yellow('No tasks.'));
    } else {
        tasks.forEach((task, index) => {
            const lastUpdatedSeconds = Math.round((new Date().getTime() - task.lastUpdatedAt.getTime()) / 1000);
            console.log(
                chalk.bold.white(`[${index + 1}]`),
                chalk.bold.cyan(`${task.taskType.toUpperCase()}`),
                `${chalk.green(task.status)} | ${chalk.blue(task.stage)} | ${chalk.magenta(task.progressPercent.toFixed(2))}%`,
                `| Last Updated: ${chalk.yellow(`${lastUpdatedSeconds} seconds ago`)}`,
                `| Running for: ${chalk.red(Math.round((new Date().getTime() - task.createdAt.getTime()) / 1000))}s`
            );
        });
    }

    console.log(chalk.dim('\n(Updates every 5 seconds)'));
}

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

// Create the server separately so we can close it
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});


if (process.argv.includes('--console')) {
    setInterval(printTaskUpdates, 5000);
}