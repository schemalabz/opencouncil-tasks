import { Task } from "./pipeline";
import { Diarization, Transcript, Word } from "../types";
import { Utterance } from "../types";
import { DiarizationManager } from "../lib/DiarizationManager";


export const applyDiarization: Task<{ diarization: Diarization, transcript: Transcript }, Transcript> = async ({ diarization, transcript }, onProgress) => {
    const diarizationManager = new DiarizationManager(diarization);

    let skippedUtterances: Utterance[] = [];
    const newUtterances: Utterance[] = transcript.transcription.utterances.map((utterance) => {
        const speaker = diarizationManager.findBestSpeakerForUtterance(utterance);

        if (!speaker) {
            console.log(`Warning: No speaker found for utterance "${utterance.text}" (${formatTime(utterance.start)}-${formatTime(utterance.end)}), SKIPPING`);
            skippedUtterances.push(utterance);
            return null;
        }

        return {
            ...utterance,
            speaker: speaker
        };
    }).filter((utterance): utterance is Utterance => utterance !== null);

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
            utterances: newUtterances
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