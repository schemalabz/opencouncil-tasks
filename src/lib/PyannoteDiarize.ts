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

    private generateMockVoiceprint(): string {
        const mockVector = Array(512).fill(0).map(() => Math.random() - 0.5);
        const float32Array = new Float32Array(mockVector);
        const buffer = float32Array.buffer;
        const bytes = new Uint8Array(buffer);
        const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
        const base64String = btoa(binary);

        return `MOCK_${base64String}`;
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

        // TODO: Find a better way to handle the case where we don't have any voiceprints yet.
        // Currently using a pre-generated valid voiceprint because Pyannote's /identify endpoint
        // requires at least one valid voiceprint and rejects dummy/mock ones.
        // This is a temporary solution until we can either:
        // 1. Get Pyannote to accept diarization without voiceprints
        // 2. Implement a proper way to handle initial diarization before having any voiceprints
        const effectiveVoiceprints = voiceprints?.length ? voiceprints : [{
            personId: 'DUMMY_SPEAKER',
            voiceprint: "mRCrvEmgdb7MDnY8eXxePluWCD56zj4+U0GkPh+9Rr/jL+Y8snUPPzKtND3GXY29dDusvZJdtb3cBGi+PaYdv38ddL0d+Ac9kNT3veIbIb5ESH8+1JtZPnL2sL52lno+XMKkPvSRID7DEbG94q9uPTrfmb4T4Qg/phLivfi8qb30WxE++MgXPfDw7TvwiEw8W+4yPm7lE77GiNu++mRdPTW1Iz0USBA/R2k3voAXFL4iHKg+2PX7PXocc77ahsA80qZiPVHWsDzyMsm+zUwSv0iUJz0+XZ49Ad0WP2sM1L0z5pS+gT4+PreVXL0auyi+kqzKvUrxPr7xyw0+moKqPbBLAT7sNYc+8H4gPVy5Yj03HJq9bG9tPt87ib3gVMU9egtJvq7CAD/CNHo+KO3lvTNfq7405zC9CPI+v8lLkj4oyHq+h63ivs70gL7DLZ0+Eb1RPgQMqb68Vw4/7skdPeOwFD4ffuq98CKdPuD+pj2sU6m82JPTvlPVkj4VJU++YNcvvubMoj4Ltha9/qWIPZi8er5EHlG+s3wpvikJgL5wEVY+zjgFPs5bjj4v9W492pWQPswTEj2p0sW9uyukPTRcpz2sHFe+3qbEvgrP171wy969XaLRPpCxdr7wJWG9xVmVPiXvn76zZKC9zqFtvrZlUj2k3YK+sM6OPpSl0T2fdTm+KpB2vii2dj7G6708eFICvhqjCT8hE2E+3lthPs4mbD5iRAS+lrdwPRvZ7D0e9uA+Gv89PgLpAr1Zhaa8nH59vsNSBL7j+4W+/sBOvj6sVL3cWNW8gjmRPqikhL6KWKa9NlRWvmto9D6lWx6+Hz53vujTpT1Y+ru9/5ZePb9oyz26eJ4+T6gmvhueqz4kscE904qevfYwKL5kThi94D5cvu3nrz1FxxE9nO1MvX4t5T2YKVw9an3LvYAMEDkIgUO+tD9ovXRQkL2myJs+npODvfI1v72ppEk+wh41veAneT6mCAk+jQAtPkFoI76+Xom+UZZ/vpWaqb7g4Ly+0IQQur5K9zxjQBy9IYKaPdirgTxPXRU+JCfIPXGhWD1rG+y+Ck2HvTXumz78NIg+rLZdPhjH3T7ZieI9L90cPoLSKL4XwlQ9KF0YPhzfGj857Vq89ueHPXqyiz5grh+9PdAovtpuCD6nXKM+kupHPTZckT5+GQc/SuvVPGwLK7565fi91gRDPb3XIT3D2PE+n2YWvywpAz1y6xO/YUnDPVVyizwR1pa9BWhAPTqOlr6aUMC+NztnPh4PnT7VN50+JYMCvmjFfD1DbNC9nDCZvJIBmzsLY9C9DukvPNx9sb3M0Ko+XVa8PRr9jz4fFV6+6oGtPjABjzxUsW0+eisevg=="
        }];

        console.log(`Diarizing ${audioSegments.length} segments: ${audioSegments.map(({ url, start }) => `${url} (${start})`).join(', ')}`);
        const identificationPromises = audioSegments.map(({ url, start }) => this.identifySingle(url, effectiveVoiceprints));
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
            return this.generateMockVoiceprint();
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