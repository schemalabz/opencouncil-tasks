import express from 'express';
import dotenv from 'dotenv';
import { TranscribeRequest, TranscribeUpdate } from './types';
import path from 'path';
import fs from 'fs';
import { transcribe } from './tasks/transcribe';
import { pipeline } from 'stream';
import { pipelineWithStatus } from './tasks/pipeline';

dotenv.config();

const apiTokens: string[] = require('./secrets/apiTokens.json');
const app = express();
const port = process.env.PORT || 3000;

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


app.get('/transcribe', (req: express.Request<{}, {}, TranscribeRequest>, res: express.Response) => {
    const { youtubeUrl, callbackUrl } = req.body;

    // Validate YouTube URL
    const youtubeUrlRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
    if (!youtubeUrlRegex.test(youtubeUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Validate callback URL
    const urlRegex = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
    if (!urlRegex.test(callbackUrl)) {
        return res.status(400).json({ error: 'Invalid callback URL' });
    }

    const result = pipelineWithStatus(req.body, (status) => {
        const update: TranscribeUpdate = {
            status: "processing",
            stage: status.stage,
            progressPercent: status.progressPercent,
        };

        fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(update),
        }).catch(error => {
            console.error('Error sending callback:', error);
        });
    });

    res.status(200).json({ ok: true });

    result.then((response) => {
        const finalUpdate: TranscribeUpdate = {
            status: "success",
            stage: "finished",
            progressPercent: 100,
            response: response
        };

        fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(finalUpdate),
        }).catch(error => {
            console.error('Error sending final callback:', error);
        });
    }).catch((error) => {
        const errorUpdate: TranscribeUpdate = {
            status: "error",
            stage: "finished",
            progressPercent: 100,
        };

        fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(errorUpdate),
        }).catch(callbackError => {
            console.error('Error sending error callback:', callbackError);
        });

        console.error('Error in pipeline:', error);
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
