import express from 'express';
import dotenv from 'dotenv';
import { pipeline, Task } from './tasks/pipeline';
import { diarize } from './tasks/diarize';
import { serveTask } from './lib/taskServerUtils';
import cors from 'cors';
dotenv.config();

const apiTokens: string[] = require('./secrets/apiTokens.json');
const app = express();
const port = process.env.PORT || 3000;


const corsOptions = {
    origin: process.env.CORS_ORIGINS_ALLOWED?.split(',') || "https://opencouncil.gr",
    methods: ['GET', 'POST'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));


app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    if (!apiTokens.includes(token)) {
        return res.status(403).json({ error: 'Invalid token' });
    }

    next();
});

const validateUrl = (url: string) => /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/.test(url);
const validateYoutubeUrl = (url: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/.test(url);

app.get('/transcribe', serveTask(pipeline, (req) => {
    const { youtubeUrl, callbackUrl } = req.body;

    if (!validateYoutubeUrl(youtubeUrl)) {
        return false;
    }

    if (!validateUrl(callbackUrl)) {
        return false;
    }

    return true;
}))

app.get('/diarize', serveTask(diarize, (req) => {
    const { audioUrl, callbackUrl } = req.body;

    if (!validateUrl(audioUrl)) {
        return false;
    }

    if (!validateUrl(callbackUrl)) {
        return false;
    }

    return true;
}));

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
