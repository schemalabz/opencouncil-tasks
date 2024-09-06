import dotenv from 'dotenv';
import { CallbackServer } from './CallbackServer';
import axios from 'axios';
import { Diarization } from '../types';
import { Router } from 'express';

dotenv.config();
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

export default class PyannoteDiarizer {
    private queue: DiarizeRequest[] = [];
    private activeDiarizations = 0;
    private static callbackServer: CallbackServer;
    private static instance: PyannoteDiarizer;

    public static getInstance(): PyannoteDiarizer {
        if (!PyannoteDiarizer.instance) {
            PyannoteDiarizer.instance = new PyannoteDiarizer();
        }
        return PyannoteDiarizer.instance;
    }

    constructor() {
        if (!PyannoteDiarizer.callbackServer) {
            PyannoteDiarizer.callbackServer = CallbackServer.getInstance();
        }
    }

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
        const { callbackPromise, url: webhookUrl } = await PyannoteDiarizer.callbackServer.getCallback<DiarizeResponse>({ timeoutMinutes: 30 });

        const options = {
            headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            }
        };

        try {
            const response = await axios.post(apiUrl!, {
                url: audioUrl,
                webhook: webhookUrl
            }, options);

            const result = await callbackPromise;

            if (result.status !== 'succeeded') {
                throw new Error(`Diarization job failed with status: ${result.status}`);
            }

            return result.output.diarization;
        } catch (error) {
            if (isAxiosError(error)) {
                throw new Error(`Failed to start diarization job: ${error.response?.statusText || error.message}`);
            }
            throw error;
        }
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

const isAxiosError = (error: unknown): error is { response: any, message: any } => {
    return axios.isAxiosError(error);
};