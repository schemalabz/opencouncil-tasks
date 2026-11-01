import express from 'express';
import { inspectMedia } from '../tasks/downloadYTV.js';
import { assertFetchableUrl } from '../lib/fetchableUrl.js';
import type { InspectMediaRequest, InspectMediaResponse } from '../types.js';

const router = express.Router();

/**
 * @openapi
 * /inspectMedia:
 *   post:
 *     tags: [Tasks]
 *     summary: Inspect a media URL and report its source metadata
 *     description: |
 *       Synchronous: extracts metadata without downloading the recording. The yt-dlp lookup
 *       execution is limited to 60 seconds; waiting for an in-progress binary update
 *       or a direct-file fallback can add time. Success means
 *       metadata was resolved, not that all media fragments were verified. Spaces URLs are
 *       recognized without checking object existence. Reports title, duration, live status
 *       and source timestamp (which may be an upload date, not the meeting start). A refusal
 *       carries the reason and, where there is one, what URL to send instead. A DRM-protected
 *       video is only detected when the download starts.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/InspectMediaRequest' }
 *     responses:
 *       200:
 *         description: Whether the URL is supported, with its metadata or the reason it is not.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/InspectMediaResponse' }
 *       400:
 *         description: The url is missing or not an http(s) URL.
 */
router.post('/', async (req: express.Request<{}, InspectMediaResponse | { error: string }, Partial<InspectMediaRequest>>, res) => {
    try {
        assertFetchableUrl(req.body?.url, 'url');
    } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
    }
    const result = await inspectMedia(req.body.url as string);
    console.log(`[inspect-media] ${req.body.url}: ${result.supported
        ? `${result.source.kind} ${result.source.extractor ?? ''} ${result.source.id ?? ''}`.trim()
        : `unsupported (${result.reason})`}`);
    res.json(result);
});

export default router;
