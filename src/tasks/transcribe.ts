import { Task } from "./pipeline.js";
import dotenv from 'dotenv';
import { Transcript } from "../types.js";
import { scribeTranscriber, MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS } from "../lib/ScribeTranscribe.js";
import { createScopedLogger } from "./utils/scopedLogger.js";
import { formatTime } from "../utils.js";

dotenv.config();

const log = createScopedLogger("transcribe");

export interface TranscribeArgs {
    segments: { url: string; start: number }[];
    // Accepted for API compatibility but not sent to Scribe v2: the validated
    // configuration uses no context prompt or vocabulary (Scribe's keyterms
    // parameter exists but hasn't been benchmarked)
    customVocabulary?: string[];
    customPrompt?: string;
}

const combineTranscripts = (transcripts: Transcript[]): Transcript => {

    const unique = <T>(arr: T[]): T[] => {
        return Array.from(new Set(arr));
    }
    const combinedTranscript: Transcript = {
        metadata: {
            audio_duration: transcripts.reduce((acc, curr) => acc + curr.metadata.audio_duration, 0),
            number_of_distinct_channels: transcripts.reduce((acc, curr) => curr.metadata.number_of_distinct_channels > acc ? curr.metadata.number_of_distinct_channels : acc, 0),
            billing_time: transcripts.reduce((acc, curr) => acc + curr.metadata.billing_time, 0),
            transcription_time: transcripts.reduce((acc, curr) => acc + curr.metadata.transcription_time, 0),
        },
        transcription: {
            languages: unique(transcripts.flatMap((transcript) => transcript.transcription.languages)),
            full_transcript: transcripts.reduce((acc, curr) => acc + " " + curr.transcription.full_transcript, ""),
            utterances: transcripts.flatMap((transcript) => transcript.transcription.utterances),
        }
    };

    return combinedTranscript;
}

export const transcribe: Task<TranscribeArgs, Transcript> = async ({ segments, customVocabulary, customPrompt }, onProgress) => {
    let completedSegments = 0;
    const totalSegments = segments.length;
    const startedAt = Date.now();

    if (customVocabulary?.length || customPrompt) {
        log("Note: customVocabulary/customPrompt are not used with Scribe v2, ignoring");
    }

    const segmentLabel = (index: number) => `segment ${index + 1}/${totalSegments} @ ${formatTime(segments[index].start)}`;

    const transcribeSegment = async ({ url, start }: TranscribeArgs['segments'][0], index: number) => {
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        const transcript = await scribeTranscriber.transcribe({ audioUrl: fullUrl, label: segmentLabel(index) });

        // Audio longer than any segment can be means the file doesn't belong
        // to this run's segmentation (stale upload or CDN cache). Its
        // timestamps would land in other segments' ranges — publishing that
        // would silently corrupt the record, so fail loudly instead.
        // A single segment is exempt: callers like the CLI's transcribe-single
        // pass unsplit audio of arbitrary length, and with one segment at
        // offset zero there are no other ranges to corrupt.
        const maxExpected = MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS + 60;
        if (totalSegments > 1 && transcript.metadata.audio_duration > maxExpected) {
            throw new Error(`${segmentLabel(index)}: transcribed audio is ${Math.round(transcript.metadata.audio_duration)}s long, but segments are capped at ${MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS}s — ${fullUrl} does not match this run's segmentation`);
        }

        completedSegments++;
        log(`${segmentLabel(index)} done (${completedSegments}/${totalSegments} segments complete)`);
        onProgress("transcribing", (completedSegments / totalSegments) * 100);
        return { ...transcript, start };
    };

    log(`transcribing ${totalSegments} segments`);

    // One segment exhausting its retries must not discard the others: by this
    // point the expensive download/diarization work is already done, so give
    // failed segments a second pass — sequentially, after the parallel burst
    // is over — before failing the pipeline.
    const settled = await Promise.allSettled(segments.map(transcribeSegment));

    const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ index, reason: result.reason }] : []);
    if (failures.length > 0) {
        log(`${failures.length} of ${totalSegments} segments failed, retrying them sequentially:`);
        for (const failure of failures) {
            log(`\t${segmentLabel(failure.index)}: ${failure.reason}`);
        }
    }

    const results: (Transcript & { start: number })[] = [];
    for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        results.push(result.status === "fulfilled" ? result.value : await transcribeSegment(segments[i], i));
    }

    const startIndexedResults = results.map((transcript, index) => {
        return {
            ...transcript,
            transcription: {
                ...transcript.transcription,
                utterances: transcript.transcription.utterances.map((utterance) => {
                    return {
                        ...utterance,
                        start: utterance.start + transcript.start,
                        end: utterance.end + transcript.start,
                        speaker: utterance.speaker + 1000 * index,
                        words: utterance.words.map((word) => {
                            return {
                                ...word,
                                start: word.start + transcript.start,
                                end: word.end + transcript.start,
                            }
                        })
                    }
                })
            }
        } as Transcript
    });

    const combined = combineTranscripts(startIndexedResults);
    log(`combined ${results.length} segments in ${Math.round((Date.now() - startedAt) / 1000)}s: ${formatTime(combined.metadata.audio_duration)} of audio, ${combined.transcription.utterances.length} utterances`);
    return combined;
};
