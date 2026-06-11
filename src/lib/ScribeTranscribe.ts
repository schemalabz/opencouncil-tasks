import dotenv from 'dotenv';
import { fetch, Agent, FormData } from "undici";
import { Transcript, Utterance, Word } from "../types.js";

dotenv.config();

// In-process cap on parallel Scribe requests. The account-wide concurrency
// limit is shared with every other environment and consumer of the API key —
// exceeding it returns 429s, which the saturation handling below waits out.
const SCRIBE_MAX_CONCURRENT_TRANSCRIPTIONS = parseInt(process.env.SCRIBE_MAX_CONCURRENT_TRANSCRIPTIONS || '15', 10);

// Cap for audio segments sent to Scribe: at ~12s per audio-minute, a 15-minute
// segment responds in ~3 minutes — keeping parallelism high and the cost of a
// timed-out or retried request bounded. All splitAudioDiarization call sites
// that feed transcription must use this.
export const MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS = 15 * 60;

const SCRIBE_API_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 5000;
// 429s mean the account-wide concurrency cap is full (possibly from outside
// this process), which can outlast any fixed attempt budget — so they get
// their own waiting rules instead of consuming attempts.
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;
const MAX_SATURATION_WAIT_MS = 30 * 60 * 1000;
// Hard per-request cap so a stalled request can't pin a concurrency slot.
// undici's default headersTimeout would give up at 5 minutes; the dispatcher
// below raises it so this AbortSignal is the single effective bound.
const SCRIBE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const scribeDispatcher = new Agent({
    headersTimeout: SCRIBE_REQUEST_TIMEOUT_MS,
    bodyTimeout: SCRIBE_REQUEST_TIMEOUT_MS,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
const UTTERANCE_PAUSE_SECONDS = 1;
const UTTERANCE_MAX_DURATION_SECONDS = 30;

// A trailing '.' ends the sentence unless the token looks like an abbreviation:
// short forms (κ., αρ., οδ.), dotted acronyms (Κ.Κ.Ε., π.χ.), or the known
// longer forms below. A missed abbreviation only causes a mid-sentence
// utterance split, but κ. is everywhere in roll-calls, so the common cases matter.
const KNOWN_ABBREVIATIONS = new Set(["δηλ", "βλ", "σελ", "αριθ", "κεφ", "λεωφ", "τηλ"]);

function endsSentence(text: string): boolean {
    // '…' is excluded: Scribe emits it when a speaker trails off mid-thought
    // and continues; the pause rule splits the genuine stops.
    if (/[!?;;]$/.test(text)) { // ';' and U+037E, the Greek question mark
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

export function scribeWordsToUtterances(words: ScribeWord[], language: string, logLabel = ""): Utterance[] {
    const utterances: Utterance[] = [];
    const flushCounts = { punctuation: 0, pause: 0, maxDuration: 0 };
    const sentenceEndWords = new Set<string>();

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
            flushCounts.pause++;
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

        if (endsSentence(entry.text)) {
            flushCounts.punctuation++;
            sentenceEndWords.add(entry.text);
            flush();
        } else if (end - currentWords[0].start >= UTTERANCE_MAX_DURATION_SECONDS) {
            flushCounts.maxDuration++;
            flush();
        }
    }
    flush();

    // Production visibility into endsSentence: a missed abbreviation shows up
    // here directly instead of as a misattributed speaker three steps downstream
    const prefix = logLabel ? `[Scribe] ${logLabel}:` : "[Scribe]";
    const wordCount = words.filter((w) => w.type === "word").length;
    console.log(`${prefix} ${wordCount} words → ${utterances.length} utterances (punctuation: ${flushCounts.punctuation}, pause: ${flushCounts.pause}, maxDuration: ${flushCounts.maxDuration})`);
    if (sentenceEndWords.size > 0) {
        const sample = [...sentenceEndWords].slice(0, 200);
        const more = sentenceEndWords.size - sample.length;
        console.log(`${prefix} sentence-end words: ${sample.join(" ")}${more > 0 ? ` (+${more} more)` : ""}`);
    }

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

export function scribeResponseToTranscript(response: ScribeResponse, transcriptionTimeSeconds: number, logLabel = ""): Transcript {
    const language = normalizeLanguageCode(response.language_code);
    const utterances = scribeWordsToUtterances(response.words, language, logLabel);
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
    label: string; // identifies the segment in logs (15 requests can be in flight at once)
    resolve: (transcript: Transcript) => void;
    reject: (error: Error) => void;
}

class ScribeTranscriber {
    private queue: TranscribeRequest[] = [];
    private activeTranscriptions = 0;
    // When ElevenLabs reports account saturation (429), every request holds
    // off until this time instead of piling more retries onto a full account
    private pausedUntil = 0;

    async transcribe(request: { audioUrl: string; label?: string }): Promise<Transcript> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                audioUrl: request.audioUrl,
                label: request.label ?? request.audioUrl.split('/').pop() ?? request.audioUrl,
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
        console.log(`[Scribe] ${request.label}: starting (${this.activeTranscriptions}/${SCRIBE_MAX_CONCURRENT_TRANSCRIPTIONS} slots active, ${this.queue.length} queued)`);

        try {
            const transcript = await this.transcribeSegment(request.audioUrl, request.label);
            request.resolve(transcript);
        } catch (error) {
            console.log(`[Scribe] ${request.label}: FAILED: ${error}`);
            request.reject(error as Error);
        } finally {
            this.activeTranscriptions--;
            this.processQueue();
        }
    }

    private async transcribeSegment(audioUrl: string, label: string): Promise<Transcript> {
        const startedAt = Date.now();
        const response = await this.requestWithRetries(audioUrl, label);
        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        const transcript = scribeResponseToTranscript(response, elapsedSeconds, label);
        console.log(`[Scribe] ${label}: transcribed ${(transcript.metadata.audio_duration / 60).toFixed(1)}min of audio in ${Math.round(elapsedSeconds)}s`);
        return transcript;
    }

    private async requestWithRetries(audioUrl: string, label: string): Promise<ScribeResponse> {
        let failures = 0;
        let saturationWaitMs = 0;
        let rateLimitStreak = 0;

        for (; ;) {
            // Wake from saturation pauses with jitter so paused requests
            // trickle back instead of re-hitting the API in a synchronized
            // wave when only a few account slots have freed
            while (Date.now() < this.pausedUntil) {
                await sleep(this.pausedUntil - Date.now() + Math.random() * 3000);
            }

            const result = await this.attemptRequest(audioUrl);
            if (result.ok) {
                return result.response;
            }

            if (result.rateLimited) {
                // Saturation isn't this request's fault: wait it out without
                // consuming the attempt budget, bounded by MAX_SATURATION_WAIT_MS.
                // Floor the wait at the base delay — a Retry-After of 0 must not
                // turn this into a zero-delay spin that never consumes the budget.
                rateLimitStreak++;
                const delayMs = Math.max(
                    BASE_RETRY_DELAY_MS,
                    result.retryAfterMs ?? Math.min(RATE_LIMIT_BACKOFF_CAP_MS, BASE_RETRY_DELAY_MS * Math.pow(2, rateLimitStreak - 1)),
                );
                saturationWaitMs += delayMs;
                if (saturationWaitMs > MAX_SATURATION_WAIT_MS) {
                    throw result.error;
                }
                this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delayMs);
                console.log(`[Scribe] ${label}: account saturated (429), holding all requests for ${Math.round(delayMs / 1000)}s (${Math.round(saturationWaitMs / 1000)}s waited of ${Math.round(MAX_SATURATION_WAIT_MS / 60000)}min budget): ${result.error.message}`);
                continue;
            }

            rateLimitStreak = 0;
            failures++;
            if (!result.retryable || failures >= MAX_ATTEMPTS) {
                throw result.error;
            }

            const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, failures - 1);
            console.log(`[Scribe] ${label}: request failed (attempt ${failures}/${MAX_ATTEMPTS}), retrying in ${Math.round(delayMs / 1000)}s: ${result.error.message}`);
            await sleep(delayMs);
        }
    }

    private async attemptRequest(audioUrl: string): Promise<
        { ok: true; response: ScribeResponse } |
        { ok: false; retryable: boolean; rateLimited?: boolean; retryAfterMs?: number; error: Error }
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

        try {
            const response = await fetch(SCRIBE_API_URL, {
                method: "POST",
                headers: { "xi-api-key": apiKey },
                body: form,
                signal: AbortSignal.timeout(SCRIBE_REQUEST_TIMEOUT_MS),
                dispatcher: scribeDispatcher,
            });

            if (response.ok) {
                return { ok: true, response: await response.json() as ScribeResponse };
            }

            const body = await response.text().catch(() => "");
            const retryAfterSeconds = parseInt(response.headers.get("retry-after") ?? "", 10);
            return {
                ok: false,
                retryable: response.status >= 500,
                rateLimited: response.status === 429,
                retryAfterMs: Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds * 1000,
                error: new Error(`Scribe API returned ${response.status}: ${body.slice(0, 500)}`),
            };
        } catch (error) {
            // Network failures, timeouts (AbortSignal or dispatcher header/body
            // timeouts), and truncated/unparseable 200 bodies are all retryable
            return { ok: false, retryable: true, error: error as Error };
        }
    }
}

export const scribeTranscriber = new ScribeTranscriber();
