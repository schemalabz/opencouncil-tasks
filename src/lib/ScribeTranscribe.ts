import dotenv from 'dotenv';
import { Transcript, Utterance, Word } from "../types.js";

dotenv.config();

// Scribe's sync API takes ~12s per audio-minute, so keep concurrency low.
const SCRIBE_MAX_CONCURRENT_TRANSCRIPTIONS = parseInt(process.env.SCRIBE_MAX_CONCURRENT_TRANSCRIPTIONS || '5', 10);

// Cap for audio segments sent to Scribe: at ~12s per audio-minute, a 15-minute
// segment responds in ~3 minutes, safely before fetch's 5-minute response
// header timeout. All splitAudioDiarization call sites that feed transcription
// must use this.
export const MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS = 15 * 60;

const SCRIBE_API_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 5000;
// Hard per-request cap so a stalled request can't pin a concurrency slot:
// a 15-minute segment should respond in ~3 minutes, so 10 is generous
const SCRIBE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function getScribeKey(): string {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) {
        throw new Error("ELEVENLABS_API_KEY is not set in the environment variables");
    }
    return key;
}

// See https://elevenlabs.io/docs/api-reference/speech-to-text/convert
export interface ScribeWord {
    text: string;
    type: "word" | "spacing" | "audio_event";
    start?: number | null;
    end?: number | null;
    logprob?: number | null;
    speaker_id?: string | null;
}

export interface ScribeResponse {
    language_code: string;
    language_probability: number;
    text: string;
    words: ScribeWord[];
    audio_duration_secs?: number | null;
    transcription_id?: string | null;
}

// Scribe returns a flat word stream (we transcribe with diarize: false and
// assign speakers downstream by merging pyannote diarization), so we segment
// it into utterances at sentence-final punctuation and pauses. Utterances must
// stay short enough that "one speaker per utterance" holds for that merge.
// Abbreviations that are longer than two letters but still don't end a sentence
const KNOWN_ABBREVIATIONS = new Set(["δηλ", "βλ", "σελ", "αριθ", "κεφ", "λεωφ", "τηλ"]);

// A trailing '.' ends the sentence unless the token looks like an abbreviation:
// short forms (κ., αρ., οδ.) or dotted acronyms (Κ.Κ.Ε., π.χ.).
// A missed abbreviation only causes a mid-sentence utterance split, but κ.
// is everywhere in roll-calls, so the common cases matter.
function endsSentence(text: string): boolean {
    // '…' is excluded: Scribe emits it when a speaker trails off mid-thought
    // and continues; the pause rule splits the genuine stops.
    if (/[!?;;]$/.test(text)) { // both ';' and U+037E are Greek question marks
        return true;
    }
    if (!text.endsWith(".")) {
        return false;
    }
    const core = text.slice(0, -1);
    const isAbbreviation = core.length <= 2
        || KNOWN_ABBREVIATIONS.has(core.toLowerCase())
        || /^(\p{L}\.)+\p{L}{0,3}$/u.test(core);
    return !isAbbreviation;
}
const UTTERANCE_PAUSE_SECONDS = 1;
const UTTERANCE_MAX_DURATION_SECONDS = 30;

export function scribeWordsToUtterances(words: ScribeWord[], language: string): Utterance[] {
    const utterances: Utterance[] = [];

    let currentWords: Word[] = [];
    let currentText = "";
    let lastEnd = 0;

    const flush = () => {
        if (currentWords.length === 0) {
            return;
        }
        utterances.push({
            text: currentText.trim(),
            language,
            start: currentWords[0].start,
            end: currentWords[currentWords.length - 1].end,
            confidence: currentWords.reduce((acc, w) => acc + w.confidence, 0) / currentWords.length,
            channel: 0,
            speaker: 0, // placeholder — applyDiarization assigns real speakers from pyannote
            drift: 0,
            words: currentWords,
        });
        currentWords = [];
        currentText = "";
    };

    for (const entry of words) {
        if (entry.type === "spacing") {
            if (currentWords.length > 0) {
                currentText += entry.text;
            }
            continue;
        }
        if (entry.type !== "word") {
            continue;
        }

        const start = entry.start ?? lastEnd;
        const end = entry.end ?? start;

        if (currentWords.length > 0 && start - lastEnd > UTTERANCE_PAUSE_SECONDS) {
            flush();
        }

        lastEnd = end;
        currentWords.push({
            word: entry.text,
            start,
            end,
            confidence: logprobToConfidence(entry.logprob),
        });
        currentText += entry.text;

        if (endsSentence(entry.text) || end - currentWords[0].start >= UTTERANCE_MAX_DURATION_SECONDS) {
            flush();
        }
    }
    flush();

    return utterances;
}

function logprobToConfidence(logprob: number | null | undefined): number {
    if (logprob === null || logprob === undefined) {
        return 1;
    }
    return Math.min(1, Math.exp(logprob));
}

// Scribe uses ISO-639-3 codes ("ell"); downstream consumers expect the
// two-letter codes Gladia produced ("el")
function normalizeLanguageCode(code: string): string {
    return code === "ell" ? "el" : code;
}

export function scribeResponseToTranscript(response: ScribeResponse, transcriptionTimeSeconds: number): Transcript {
    const language = normalizeLanguageCode(response.language_code);
    const utterances = scribeWordsToUtterances(response.words, language);
    const audioDuration = response.audio_duration_secs ?? (utterances.length > 0 ? utterances[utterances.length - 1].end : 0);

    return {
        metadata: {
            audio_duration: audioDuration,
            number_of_distinct_channels: 1,
            billing_time: audioDuration,
            transcription_time: transcriptionTimeSeconds,
        },
        transcription: {
            languages: [language],
            full_transcript: response.text,
            utterances,
        },
    };
}

type TranscribeRequest = {
    audioUrl: string;
    resolve: (transcript: Transcript) => void;
    reject: (error: Error) => void;
}

class ScribeTranscriber {
    private queue: TranscribeRequest[] = [];
    private activeTranscriptions = 0;

    async transcribe(request: { audioUrl: string }): Promise<Transcript> {
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
        if (this.activeTranscriptions >= SCRIBE_MAX_CONCURRENT_TRANSCRIPTIONS || this.queue.length === 0) {
            return;
        }

        this.activeTranscriptions++;
        const request = this.queue.shift()!;

        try {
            const transcript = await this.transcribeSegment(request.audioUrl);
            request.resolve(transcript);
        } catch (error) {
            request.reject(error as Error);
        } finally {
            this.activeTranscriptions--;
            this.processQueue();
        }
    }

    private async transcribeSegment(audioUrl: string): Promise<Transcript> {
        const startedAt = Date.now();
        const response = await this.requestWithRetries(audioUrl);
        return scribeResponseToTranscript(response, (Date.now() - startedAt) / 1000);
    }

    private async requestWithRetries(audioUrl: string): Promise<ScribeResponse> {
        for (let attempt = 1; ; attempt++) {
            const result = await this.attemptRequest(audioUrl);
            if (result.ok) {
                return result.response;
            }
            if (!result.retryable || attempt >= MAX_ATTEMPTS) {
                throw result.error;
            }

            const delayMs = result.retryAfterMs ?? BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.log(`Scribe request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${Math.round(delayMs / 1000)}s: ${result.error.message}`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    private async attemptRequest(audioUrl: string): Promise<
        { ok: true; response: ScribeResponse } |
        { ok: false; retryable: boolean; retryAfterMs?: number; error: Error }
    > {
        const apiKey = getScribeKey();

        const form = new FormData();
        form.append("model_id", "scribe_v2");
        form.append("language_code", "ell");
        // Strips fillers and false starts, matching how transcript correctors write the record
        form.append("no_verbatim", "true");
        form.append("tag_audio_events", "false");
        form.append("timestamps_granularity", "word");
        // Speakers are assigned downstream by merging pyannote diarization (applyDiarization)
        form.append("diarize", "false");
        form.append("source_url", audioUrl);

        let response: Response;
        try {
            response = await fetch(SCRIBE_API_URL, {
                method: "POST",
                headers: { "xi-api-key": apiKey },
                body: form,
                signal: AbortSignal.timeout(SCRIBE_REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            // Network failures and timeouts (our AbortSignal or undici's own
            // header/body timeouts) are retryable
            return { ok: false, retryable: true, error: error as Error };
        }

        if (response.ok) {
            return { ok: true, response: await response.json() as ScribeResponse };
        }

        const body = await response.text().catch(() => "");
        const retryAfterSeconds = parseInt(response.headers.get("retry-after") ?? "", 10);
        return {
            ok: false,
            retryable: response.status === 429 || response.status >= 500,
            retryAfterMs: Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds * 1000,
            error: new Error(`Scribe API returned ${response.status}: ${body.slice(0, 500)}`),
        };
    }
}

export const scribeTranscriber = new ScribeTranscriber();
