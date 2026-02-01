import { Task } from "./pipeline.js";
import dotenv from 'dotenv';
import { Transcript } from "../types.js";
import { gladiaTranscriber } from "../lib/GladiaTranscribe.js";

dotenv.config();

export interface TranscribeArgs {
    segments: { url: string; start: number }[];
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
const alphabeticNumber = (num: number): string => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    do {
        result = alphabet[num % 26] + result;
        num = Math.floor(num / 26);
    } while (num > 0);
    return result;
}

export const transcribe: Task<TranscribeArgs, Transcript> = async ({ segments, customVocabulary, customPrompt }, onProgress) => {
    let completedSegments = 0;
    const totalSegments = segments.length;

    let transcriptPromises = segments.map(async ({ url, start }) => {
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        const transcript = await gladiaTranscriber.transcribe({ audioUrl: fullUrl, customVocabulary, customPrompt });
        completedSegments++;
        onProgress("transcribing", (completedSegments / totalSegments) * 100);
        return { ...transcript, start };
    });

    const results = await Promise.all(transcriptPromises);

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


    return combineTranscripts(startIndexedResults);
};
