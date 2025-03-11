import dotenv from 'dotenv';
import { CallbackServer } from './CallbackServer.js';
import axios, { AxiosResponse } from 'axios';
import { Diarization } from '../types.js';

dotenv.config();
type PyannoteResponse = {
    jobId: string;
    status: string;
}
export type DiarizeResponse = PyannoteResponse & {
    output: {
        diarization: Diarization;
    };
};

type DiarizeRequest = {
    audioUrl: string;
    resolve: (diarization: DiarizeResponse['output']['diarization']) => void;
    reject: (error: Error) => void;
}

type VoiceprintResponse = PyannoteResponse & {
    output: {
      voiceprint: string;
    };
}
  
const PYANNOTE_MAX_CONCURRENT_DIARIZATIONS = parseInt(process.env.PYANNOTE_MAX_CONCURRENT_DIARIZATIONS || '5', 10);
const baseUrl = process.env.PYANNOTE_DIARIZE_API_URL;
const apiToken = process.env.PYANNOTE_API_TOKEN;

// Check if mock mode is enabled
const MOCK_ENABLED = process.env.MOCK_PYANNOTE === 'true';

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
        if (!baseUrl || !apiToken) {
            throw new Error("PYANNOTE_DIARIZE_API_URL and PYANNOTE_API_TOKEN must be set in environment variables");
        }

        console.log(`Diarizing ${audioSegments.length} segments: ${audioSegments.map(({ url, start }) => `${url} (${start})`).join(', ')}`);
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

    /**
     * Generates a voiceprint from an audio file
     */
    async generateVoiceprint(audioUrl: string): Promise<string> {
        if (MOCK_ENABLED) {
            console.log(`[MOCK MODE] Generating mock voiceprint for: ${audioUrl}`);
            const mockVector = Array(512).fill(0).map(() => Math.random() - 0.5);

            // Convert the array to a Float32Array
            const float32Array = new Float32Array(mockVector);
            
            // Convert to base64 string
            const buffer = float32Array.buffer;
            const bytes = new Uint8Array(buffer);
            const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
            const base64String = btoa(binary);
            
            return `MOCK_${base64String}`;
        }

        if (!baseUrl || !apiToken) {
            throw new Error("PYANNOTE_DIARIZE_API_URL and PYANNOTE_API_TOKEN must be set in environment variables");
        }

        console.log(`Generating voiceprint from audio: ${audioUrl}`);
        
        const { callbackPromise, url: webhookUrl } = await PyannoteDiarizer.callbackServer.getCallback<VoiceprintResponse>({ timeoutMinutes: 10 });

        const voiceprintUrl = `${baseUrl}/voiceprint`;
        let response: AxiosResponse<{jobId: string}>;
        
        try {
            response = await axios.post(voiceprintUrl, {
                url: audioUrl,
                webhook: webhookUrl
            }, this.axiosOptions);
        } catch (error) {
            console.error(`Error with request to ${voiceprintUrl}, passed url: ${audioUrl}`);
            if (isAxiosError(error)) {
                console.error(`Response was ${error.response?.status}: ${JSON.stringify(error.response?.data)}`);
                throw new Error(`Failed to start voiceprint generation: ${error.response?.statusText || error.message}`);
            } else {
                console.log(`Non axios error:`, error);
            }
            throw error;
        }

        const jobId = response.data.jobId;
        console.log(`Awaiting voiceprint callback: ${webhookUrl}. Response was ${response.status}: ${JSON.stringify(response.data)}`);

        const statusCheckInterval = setInterval(async () => {
            try {
                const status = await this.getJobStatus(jobId);
                console.log(`Voiceprint job status: ${JSON.stringify(status)}`);
            } catch (error) {
                console.error('Error checking voiceprint job status:', error);
            }
        }, 20000);

        let result: VoiceprintResponse;
        try {
            result = await callbackPromise;
        } catch (e) {
            throw e;
        } finally {
            clearInterval(statusCheckInterval);
        }

        if (result.status !== 'succeeded') {
            throw new Error(`Voiceprint generation failed with status: ${result.status}`);
        }

        return result.output.voiceprint;
    }

    private async processQueue() {
        if (this.activeDiarizations >= PYANNOTE_MAX_CONCURRENT_DIARIZATIONS || this.queue.length === 0) {
            return;
        }

        console.log(`Processing diarization queue of length ${this.queue.length}`);
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

    private axiosOptions = {
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        }
    };

    private async getJobStatus(jobId: string): Promise<any> {
        const response = await axios.get(`${baseUrl}/jobs/${jobId}`, this.axiosOptions);
        return response.data;
    }

    private async diarizeSegment(audioUrl: string): Promise<DiarizeResponse['output']['diarization']> {
        const { callbackPromise, url: webhookUrl } = await PyannoteDiarizer.callbackServer.getCallback<DiarizeResponse>({ timeoutMinutes: 30 });

        const diarizeUrl = `${baseUrl}/diarize`;
        let response: AxiosResponse<DiarizeResponse>;
        try {
            response = await axios.post(diarizeUrl, {
                url: audioUrl,
                webhook: webhookUrl
            }, this.axiosOptions);
        } catch (error) {
            console.error(`Error with request to ${diarizeUrl}, passed url: ${audioUrl} and webhook: ${webhookUrl}.`);
            if (isAxiosError(error)) {
                console.error(`Response was ${error.response?.status}: ${JSON.stringify(error.response?.data)}`);
                throw new Error(`Failed to start diarization job: ${error.response?.statusText || error.message}`);
            } else {
                console.log(`Non axios error:`, error);
            }
            throw error;
        }

        const jobId = response.data.jobId;
        console.log(`Awaiting diarization callback: ${webhookUrl}. Response was ${response.status}: ${JSON.stringify(response.data)}`);

        const statusCheckInterval = setInterval(async () => {
            try {
                const status = await this.getJobStatus(jobId);
                console.log(`Diarize job status: ${JSON.stringify(status)}`);
            } catch (error) {
                console.error('Error checking diarize job status:', error);
            }
        }, 20000);

        let result: DiarizeResponse;
        try {
            result = await callbackPromise;
        } catch (e) {
            throw e;
        } finally {
            clearInterval(statusCheckInterval);
        }

        if (result.status !== 'succeeded') {
            throw new Error(`Diarization job failed with status: ${result.status}`);
        }

        return result.output.diarization;
    }

    private combineDiarizations(segments: { start: number, diarization: Diarization }[]): Diarization {
        console.log(`Combining ${segments.length} diarizations`);
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