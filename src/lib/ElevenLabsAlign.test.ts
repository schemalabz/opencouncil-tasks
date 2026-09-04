import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { forcedAlign, AlignmentError } from './ElevenLabsAlign.js';

const okResponse = {
    words: [
        { text: 'Ξεκινάμε', start: 0.1, end: 0.6, loss: 0.2 },
        { text: 'την', start: 0.65, end: 0.8, loss: 0.1 },
    ],
};

describe('forcedAlign', () => {
    let audioFile: string;

    beforeEach(() => {
        audioFile = path.join(os.tmpdir(), `align-test-${Date.now()}.mp3`);
        fs.writeFileSync(audioFile, Buffer.from([0x49, 0x44, 0x33])); // fake mp3
        process.env.ELEVENLABS_API_KEY = 'test-key';
    });

    afterEach(() => {
        fs.rmSync(audioFile, { force: true });
        vi.restoreAllMocks();
    });

    it('POSTs multipart form and returns words', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(okResponse), { status: 200 })
        );
        vi.stubGlobal('fetch', fetchMock);

        const words = await forcedAlign(audioFile, 'Ξεκινάμε την');

        expect(words).toEqual(okResponse.words);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.elevenlabs.io/v1/forced-alignment');
        expect(init.method).toBe('POST');
        expect(init.headers['xi-api-key']).toBe('test-key');
        expect(init.body).toBeInstanceOf(FormData);
        expect(init.body.get('text')).toBe('Ξεκινάμε την');
    });

    it('retries once on failure, then succeeds', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('boom', { status: 500 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(okResponse), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const words = await forcedAlign(audioFile, 'Ξεκινάμε την');
        expect(words).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws AlignmentError after both attempts fail', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
        await expect(forcedAlign(audioFile, 'x')).rejects.toBeInstanceOf(AlignmentError);
    });

    it('throws AlignmentError when API key is missing', async () => {
        delete process.env.ELEVENLABS_API_KEY;
        await expect(forcedAlign(audioFile, 'x')).rejects.toBeInstanceOf(AlignmentError);
    });

    it('filters out whitespace-only word entries', async () => {
        const withSpacing = { words: [okResponse.words[0], { text: ' ', start: 0.6, end: 0.65, loss: 0 }, okResponse.words[1]] };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify(withSpacing), { status: 200 })
        ));
        const words = await forcedAlign(audioFile, 'Ξεκινάμε την');
        expect(words).toHaveLength(2);
    });
});
