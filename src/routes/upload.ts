import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { uploadToSpaces } from '../tasks/uploadToSpaces.js';

const DATA_DIR = process.env.DATA_DIR || './data';

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        cb(null, DATA_DIR);
    },
    filename: (req, _file, cb) => {
        const videoId = req.body.videoId;
        if (!videoId) {
            return cb(new Error('videoId field is required'), '');
        }
        cb(null, `${videoId}.mp4`);
    },
});

const upload = multer({ storage });

const router = express.Router();

router.post('/', upload.single('video'), async (req: express.Request, res: express.Response) => {
    try {
        const { videoId } = req.body;

        if (!videoId) {
            return res.status(400).json({ error: 'videoId is required' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'video file is required' });
        }

        const filePath = req.file.path;
        const fileSize = req.file.size;

        console.log(`Received video upload: ${videoId} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

        // Upload to DO Spaces
        const [cdnUrl] = await uploadToSpaces({
            files: [filePath],
            spacesPath: 'council-meeting-videos',
        }, (stage, progress) => {
            console.log(`Upload ${videoId}: ${stage} ${progress}%`);
        });

        console.log(`Video ${videoId} uploaded to Spaces: ${cdnUrl}`);

        res.json({
            cdnUrl,
            videoId,
            size: fileSize,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Upload failed',
        });
    }
});

export default router;
