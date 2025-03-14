import dotenv from 'dotenv';
import { CallbackServer } from './CallbackServer.js';
import axios, { AxiosResponse } from 'axios';
import { Diarization, DiarizationSpeaker, DiarizeResult, Voiceprint } from '../types.js';

dotenv.config();
type PyannoteResponse = {
    jobId: string;
    status: string;
}

export type IdentifyResponse = PyannoteResponse & {
    output: {
        identification: Diarization[number] & {
            diarizationSpeaker: string;
            match: string | null;
        }[]; // list of identification segments, not used in the current implementation
        voiceprints: DiarizationSpeaker[];
        diarization: Diarization; // subset of identification
    };
};

type IdentifyRequest = {
    audioUrl: string;
    voiceprints: Voiceprint[];
    resolve: (response: IdentifyResponse) => void;
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
    private queue: IdentifyRequest[] = [];
    private activeDiarizations = 0;
    private static callbackServer: CallbackServer;
    private static instance: PyannoteDiarizer;
    private static readonly CONFIDENCE_THRESHOLD = 50; // Minimum confidence score required to consider a match valid

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

    /**
     * Performs diarization and speaker identification on multiple audio segments.
     * 
     * Processes each segment separately, then combines results while
     * maintaining correct timestamp offsets. Uses identified speaker names 
     * when available; otherwise, prefixes diarization labels with segment numbers (e.g., SEG1:SpeakerA).
     */
    async diarize(audioSegments: { url: string, start: number }[], voiceprints?: Voiceprint[]): Promise<DiarizeResult> {
        if (!baseUrl || !apiToken) {
            throw new Error("PYANNOTE_DIARIZE_API_URL and PYANNOTE_API_TOKEN must be set in environment variables");
        }

        console.log(`Diarizing ${audioSegments.length} segments: ${audioSegments.map(({ url, start }) => `${url} (${start})`).join(', ')}`);
        const identificationPromises = audioSegments.map(({ url, start }) => this.identifySingle(url, voiceprints || []));
        const identifications = await Promise.all(identificationPromises);
        return this.combineDiarizations(identifications.map((identification, index) => ({
            diarization: identification.output.diarization,
            voiceprints: identification.output.voiceprints,
            start: audioSegments[index].start
        })));
    }

    async identifySingle(audioUrl: string, voiceprints: Voiceprint[]): Promise<IdentifyResponse> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                audioUrl,
                voiceprints,
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
        let response: AxiosResponse<PyannoteResponse>;

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
            const response = await this.identifySegment(request.audioUrl, request.voiceprints);
            request.resolve(response);
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

    async getJobStatus(jobId: string): Promise<any> {
        const response = await axios.get(`${baseUrl}/jobs/${jobId}`, this.axiosOptions);
        return response.data;
    }

    private async identifySegment(audioUrl: string, voiceprints: Voiceprint[]): Promise<IdentifyResponse> {
        const { callbackPromise, url: webhookUrl } = await PyannoteDiarizer.callbackServer.getCallback<IdentifyResponse>({ timeoutMinutes: 30 });

        const identifyUrl = `${baseUrl}/identify`;
        let response: AxiosResponse<PyannoteResponse>;

        try {
            // Map personId to label for the API request
            const apiVoiceprints = voiceprints.map(vp => ({
                label: vp.personId,
                voiceprint: vp.voiceprint
            }));

            response = await axios.post(identifyUrl, {
                url: audioUrl,
                voiceprints: apiVoiceprints,
                webhook: webhookUrl
            }, this.axiosOptions);
        } catch (error) {
            console.error(`Error with request to ${identifyUrl}, passed url: ${audioUrl}`);
            if (isAxiosError(error)) {
                console.error(`Response was ${error.response?.status}: ${JSON.stringify(error.response?.data)}`);
                throw new Error(`Failed to start identification job: ${error.response?.statusText || error.message}`);
            } else {
                console.log(`Non axios error:`, error);
            }
            throw error;
        }

        const jobId = response.data.jobId;
        console.log(`Awaiting identification callback: ${webhookUrl}. Response was ${response.status}: ${JSON.stringify(response.data)}`);

        const statusCheckInterval = setInterval(async () => {
            try {
                const status = await this.getJobStatus(jobId);
                console.log(`Identification job status: ${JSON.stringify(status)}`);
            } catch (error) {
                console.error('Error checking identification job status:', error);
            }
        }, 20000);

        let result: IdentifyResponse;
        try {
            result = await callbackPromise;
        } catch (e) {
            throw e;
        } finally {
            clearInterval(statusCheckInterval);
        }

        if (result.status !== 'succeeded') {
            throw new Error(`Identification job failed with status: ${result.status}`);
        }

        return result;
    }

    private combineDiarizations(segments: { start: number, diarization: Diarization, voiceprints: IdentifyResponse['output']['voiceprints'] }[]): DiarizeResult {
        console.log(`Combining ${segments.length} identifications`);

        // Process diarization entries
        const diarization = segments.flatMap(({ diarization, voiceprints, start }, segmentIndex) => {
            return diarization.map((d) => {
                // Find the voiceprint entry for this speaker
                const voiceprintEntry = voiceprints.find(vp => vp.speaker === d.speaker);

                // Check if we have a valid match with sufficient confidence
                // We don't use output.identification directly since Pyannote may return matches with low confidence.
                // Instead, we implement our own threshold check to ensure more reliable speaker identification.
                const hasValidMatch = this.hasValidMatch(voiceprintEntry);

                return {
                    start: d.start + start,
                    end: d.end + start,
                    // Use identified speaker only if confidence threshold is met, otherwise use diarization speaker
                    speaker: hasValidMatch ? voiceprintEntry!.match! : `SEG${segmentIndex + 1}:${d.speaker}`
                };
            });
        });

        // Process speaker information
        const speakers = segments.flatMap(({ voiceprints }, segmentIndex) => {
            return voiceprints.map(vp => {
                const hasValidMatch = this.hasValidMatch(vp);

                return {
                    speaker: hasValidMatch ? vp.speaker : `SEG${segmentIndex + 1}:${vp.speaker}`,
                    match: hasValidMatch ? vp.match : null,
                    // Store only top 3 confidence scores
                    confidence: Object.entries(vp.confidence)
                        .sort(([, a], [, b]) => b - a) // Sort by confidence score in descending order
                        .slice(0, 3) // Take the top 3 entries
                        .reduce((acc, [speaker, score]) => ({ ...acc, [speaker]: score }), {}) // Convert back to object
                };
            });
        });

        return {
            diarization,
            speakers
        };
    }

    /**
     * Checks if a voiceprint entry has a valid match that meets our confidence threshold
     */
    private hasValidMatch(voiceprintEntry?: IdentifyResponse['output']['voiceprints'][number]): boolean {
        return !!voiceprintEntry?.match &&
            voiceprintEntry.confidence[voiceprintEntry.match] >= PyannoteDiarizer.CONFIDENCE_THRESHOLD;
    }
}

const isAxiosError = (error: unknown): error is { response: any, message: any } => {
    return axios.isAxiosError(error);
};