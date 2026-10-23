import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { uploadToSpaces } from '../tasks/uploadToSpaces.js';

const DATA_DIR = process.env.DATA_DIR || './data';
// The id becomes a file name in DATA_DIR and a Spaces key, so only a plain token passes.
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 8 * 1024 ** 3;

const isVideoId = (value: unknown): value is string => typeof value === 'string' && VIDEO_ID.test(value);

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        cb(null, DATA_DIR);
    },
    filename: (req, _file, cb) => {
        const videoId = req.body.videoId;
        if (!isVideoId(videoId)) {
            return cb(new Error('videoId must match [A-Za-z0-9_-]{1,64} and precede the file'), '');
        }
        cb(null, `${videoId}.mp4`);
    },
});

const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

const router = express.Router();

router.post('/', upload.single('video'), async (req: express.Request, res: express.Response) => {
    try {
        const { videoId } = req.body;

        if (!isVideoId(videoId)) {
            return res.status(400).json({ error: 'videoId must match [A-Za-z0-9_-]{1,64}' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'video file is required' });
        }

        const filePath = req.file.path;
        const fileSize = req.file.size;

        console.log(`Received video upload: ${videoId} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

        // Upload to DO Spaces
        const [url] = await uploadToSpaces({
            files: [filePath],
            spacesPath: 'council-meeting-videos',
        }, (stage, progress) => {
            console.log(`Upload ${videoId}: ${stage} ${progress}%`);
        });

        console.log(`Video ${videoId} uploaded to Spaces: ${url}`);

        res.json({
            url,
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
