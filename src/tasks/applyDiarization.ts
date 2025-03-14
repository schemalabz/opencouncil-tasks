import { Task } from "./pipeline.js";
import { Diarization, Transcript, TranscriptWithSpeakerIdentification, DiarizationSpeaker } from "../types.js";
import { Utterance } from "../types.js";
import { DiarizationManager } from "../lib/DiarizationManager.js";

/**
 * Applies diarization data to a transcript
 * 
 * This solves the problem of aligning two independently
 * processed data sources (diarization and transcription) that
 * may have slight timing differences.
 */
export const applyDiarization: Task<{ diarization: Diarization, speakers: DiarizationSpeaker[], transcript: Transcript }, TranscriptWithSpeakerIdentification> = async ({ diarization, speakers, transcript }, onProgress) => {
    const diarizationManager = new DiarizationManager(diarization, speakers);

    let skippedUtterances: Utterance[] = [];
    console.log(`Last utterance ends at ${formatTime(transcript.transcription.utterances[transcript.transcription.utterances.length - 1].end)}`);
    console.log(`Last diarization ends at ${formatTime(diarization[diarization.length - 1].end)}`);
    const newUtterances: (Utterance & { drift: number })[] = transcript.transcription.utterances.map((utterance) => {
        const speaker = diarizationManager.findBestSpeakerForUtterance(utterance);

        if (!speaker) {
            console.log(`Warning: No speaker found for utterance "${utterance.text}" (${formatTime(utterance.start)}-${formatTime(utterance.end)}), SKIPPING`);
            skippedUtterances.push(utterance);
            return null;
        }

        return {
            ...utterance,
            speaker: speaker.speaker,
            drift: speaker.drift
        };
    }).filter((utterance): utterance is Utterance & { drift: number } => utterance !== null);

    const speakerUtteranceCount = newUtterances.reduce((acc, curr) => {
        acc[curr.speaker] = (acc[curr.speaker] || 0) + 1;
        return acc;
    }, {} as Record<number, number>);

    console.log(`Listing ${skippedUtterances.length} skipped utterances:`);
    for (const utterance of skippedUtterances) {
        console.log(`\t${utterance.text} (${formatTime(utterance.start)}-${formatTime(utterance.end)})`);
    }

    console.log(`Applied diarization to transcript of ${transcript.transcription.utterances.length} utterances:`);
    console.log(`\t${newUtterances.length} utterances`);
    console.log(`\t${Object.keys(speakerUtteranceCount).length} speakers`);
    console.log(`\t${skippedUtterances.length} (${((skippedUtterances.length / transcript.transcription.utterances.length) * 100).toFixed(2)}%) utterances skipped`);
    console.log(`\tDrift cost: ${diarizationManager.getDriftCost()} s^2`);

    return {
        ...transcript,
        transcription: {
            ...transcript.transcription,
            utterances: newUtterances,
            speakers: diarizationManager.getSpeakerInfo()
        }
    };
}

// formats seconds as hh:mm:ss
function formatTime(time: number): string {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}