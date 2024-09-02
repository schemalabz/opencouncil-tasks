import dotenv from 'dotenv';
import { callbackServer } from './CallbackServer';
import fetch from 'node-fetch';

dotenv.config();

export type Diarization = {
    start: number;
    end: number;
    speaker: string;
}[];

export type DiarizeResponse = {
    jobId: string;
    status: string;
    output: {
        diarization: Diarization;
    };
};

type DiarizeRequest = {
    audioUrl: string;
    resolve: (diarization: DiarizeResponse['output']['diarization']) => void;
    reject: (error: Error) => void;
}

const PYANNOTE_MAX_CONCURRENT_DIARIZATIONS = parseInt(process.env.PYANNOTE_MAX_CONCURRENT_DIARIZATIONS || '5', 10);
const apiUrl = process.env.PYANNOTE_DIARIZE_API_URL;
const apiToken = process.env.PYANNOTE_API_TOKEN;

class PyannoteDiarizer {
    private queue: DiarizeRequest[] = [];
    private activeDiarizations = 0;

    async diarize(audioSegments: { url: string, start: number }[]): Promise<Diarization> {
        if (!apiUrl || !apiToken) {
            throw new Error("PYANNOTE_DIARIZE_API_URL and PYANNOTE_API_TOKEN must be set in environment variables");
        }

        const diarizationPromises = audioSegments.map(({ url, start }) => this.diarizeSingle(url));
        const diarizations = await Promise.all(diarizationPromises);
        return this.combineDiarizations(diarizations.map((diarization, index) => ({ diarization, start: audioSegments[index].start })));
    }

    async diarizeSingle(audioUrl: string): Promise<Diarization> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                audioUrl,
                resolve,
                reject,
            });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.activeDiarizations >= PYANNOTE_MAX_CONCURRENT_DIARIZATIONS || this.queue.length === 0) {
            return;
        }

        this.activeDiarizations++;
        const request = this.queue.shift()!;

        try {
            const diarization = await this.diarizeSegment(request.audioUrl);
            request.resolve(diarization);
        } catch (error) {
            request.reject(error as Error);
        } finally {
            this.activeDiarizations--;
            this.processQueue();
        }
    }

    private async diarizeSegment(audioUrl: string): Promise<DiarizeResponse['output']['diarization']> {
        const { callbackPromise, url: webhookUrl } = await callbackServer.getCallback<DiarizeResponse>({ timeoutMinutes: 30 });

        const options = {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: audioUrl,
                webhook: webhookUrl
            })
        };

        const response = await fetch(apiUrl!, options);
        const body = await response.json();

        if (!response.ok) {
            throw new Error(`Failed to start diarization job: ${response.statusText}`);
        }

        const result = await callbackPromise;

        if (result.status !== 'succeeded') {
            throw new Error(`Diarization job failed with status: ${result.status}`);
        }

        return result.output.diarization;
    }

    private combineDiarizations(segments: { start: number, diarization: Diarization }[]): Diarization {
        const f = segments.map(({ diarization, start }, index) => {
            return diarization.map((d) => ({
                start: d.start + start,
                end: d.end + start,
                speaker: `SEG${index + 1}:${d.speaker}`
            }))
        })

        return f.flat();
    }
}

export const pyannoteDiarizer = new PyannoteDiarizer();
