import dotenv from 'dotenv';
import { Transcript } from "../types";

dotenv.config();

const GLADIA_MAX_CONCURRENT_TRANSCRIPTIONS = parseInt(process.env.GLADIA_MAX_CONCURRENT_TRANSCRIPTIONS || '20', 10);
const gladiaKey = process.env.GLADIA_API_KEY;

if (!gladiaKey) {
    throw new Error("GLADIA_API_KEY is not set in the environment variables");
}

type TranscribeRequest = {
    audioUrl: string;
    customVocabulary?: string[];
    customPrompt?: string;
    resolve: (transcript: Transcript) => void;
    reject: (error: Error) => void;
}

class GladiaTranscriber {
    private queue: TranscribeRequest[] = [];
    private activeTranscriptions = 0;

    async transcribe(request: { audioUrl: string, customVocabulary?: string[], customPrompt?: string }): Promise<Transcript> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                ...request,
                resolve,
                reject,
            });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.activeTranscriptions >= GLADIA_MAX_CONCURRENT_TRANSCRIPTIONS || this.queue.length === 0) {
            return;
        }

        this.activeTranscriptions++;
        const request = this.queue.shift()!;

        try {
            const transcript = await this.transcribeSegment(request.audioUrl, request.customVocabulary, request.customPrompt);
            request.resolve(transcript);
        } catch (error) {
            request.reject(error as Error);
        } finally {
            this.activeTranscriptions--;
            this.processQueue();
        }
    }


    private async pollForResult(resultUrl: string, headers: any): Promise<Transcript> {
        while (true) {
            const pollResponse = await this.makeFetchRequest(resultUrl, { headers });

            if (pollResponse.status === "done") {
                return JSON.parse(pollResponse.result) as Transcript;
            } else {
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        }
    }

    private async transcribeSegment(audioUrl: string, customVocabulary?: string[], customPrompt?: string): Promise<Transcript> {
        const requestData = {
            audio_url: audioUrl,
            detect_language: false,
            language: "el",
            enable_code_switching: false,
            diarization: true,
            custom_prompt: customPrompt,
            custom_vocabulary: customVocabulary,
        };
        const gladiaUrl = "https://api.gladia.io/v2/transcription/";
        const headers = {
            "x-gladia-key": gladiaKey,
            "Content-Type": "application/json",
        };

        const initialResponse = await this.makeFetchRequest(gladiaUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(requestData),
        });

        if (initialResponse.result_url) {
            return await this.pollForResult(initialResponse.result_url, headers);
        } else {
            throw new Error("Failed to get result URL from Gladia API");
        }
    }


    private async makeFetchRequest(url: string, options: any) {
        const response = await fetch(url, options);
        return response.json();
    }

}

export const gladiaTranscriber = new GladiaTranscriber();