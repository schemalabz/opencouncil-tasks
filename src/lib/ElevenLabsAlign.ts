import fs from 'fs';
import path from 'path';

export interface AlignedWord {
    text: string;
    start: number; // seconds, clip-local
    end: number;
    loss: number;  // alignment confidence (lower = better)
}

export class AlignmentError extends Error {}

const ALIGN_URL = 'https://api.elevenlabs.io/v1/forced-alignment';
const TIMEOUT_MS = 120_000;

async function attemptAlign(audioPath: string, text: string, apiKey: string): Promise<AlignedWord[]> {
    const form = new FormData();
    const audio = await fs.promises.readFile(audioPath);
    form.append('file', new Blob([audio]), path.basename(audioPath));
    form.append('text', text);

    const res = await fetch(ALIGN_URL, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new AlignmentError(`forced-alignment failed: HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json() as { words: AlignedWord[] };
    return json.words.filter(w => w.text.trim().length > 0);
}

export async function forcedAlign(audioPath: string, text: string): Promise<AlignedWord[]> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new AlignmentError('ELEVENLABS_API_KEY is not set in the environment variables');
    }
    try {
        return await attemptAlign(audioPath, text, apiKey);
    } catch (firstError) {
        console.warn(`⚠️ forced-alignment attempt 1 failed, retrying once: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
        try {
            return await attemptAlign(audioPath, text, apiKey);
        } catch (secondError) {
            if (secondError instanceof AlignmentError) throw secondError;
            throw new AlignmentError(`forced-alignment failed after retry: ${secondError instanceof Error ? secondError.message : String(secondError)}`);
        }
    }
}
