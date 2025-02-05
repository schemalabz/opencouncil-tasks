import { FixTranscriptResult } from "../types.js";
import { FixTranscriptRequest } from "../types.js";
import { Task } from "../tasks/pipeline.js";
import fs from 'fs';
import { aiWithAdaline } from "../lib/ai.js";

const adalineProjectId = "e1ca2400-8500-4f55-8471-54166eb7e29c";
const MAX_BATCH_SIZE = 50000;

export const fixTranscript: Task<FixTranscriptRequest, FixTranscriptResult> = async (request, onProgress) => {
    const { transcript, partiesWithPeople, cityName } = request;
    console.log(`Fixing transcript for ${cityName} with ${transcript.length} segments`);

    const simplifiedTranscript = simplifyTranscript(transcript);
    const batches = splitIntoSizedBatches(simplifiedTranscript, MAX_BATCH_SIZE);
    console.log(`Split transcript into ${batches.length} batches`);

    const allResults = await processBatches(batches, cityName, partiesWithPeople, onProgress);
    const markedUncertain = allResults.filter(r => r.markUncertain).length;
    console.log(`Proposing ${allResults.length} updates, ${markedUncertain} marked uncertain`);

    return { updateUtterances: allResults };
};

function simplifyTranscript(transcript: any[]) {
    return transcript.map((s) => ({
        speakerName: s.speakerName,
        speakerParty: s.speakerParty,
        speakerRole: s.speakerRole,
        utterances: s.utterances.map((u: any) => ({
            text: u.text,
            utteranceId: u.utteranceId
        }))
    }));
}

function splitIntoSizedBatches(transcript: any[], maxSize: number) {
    const batches: any[] = [];
    let currentBatch: any[] = [];
    let currentSize = 0;

    for (const segment of transcript) {
        const segmentStr = JSON.stringify(segment);
        if (currentSize + segmentStr.length > maxSize) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }
        currentBatch.push(segment);
        currentSize += segmentStr.length;
    }
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

async function processBatches(batches: any[], cityName: string, partiesWithPeople: any, onProgress: (stage: string, progress: number) => void) {
    const allResults: FixTranscriptResult['updateUtterances'] = [];

    for (let i = 0; i < batches.length; i++) {
        onProgress("processing transcript batches", i / batches.length);

        const result = await aiWithAdaline<FixTranscriptResult['updateUtterances']>({
            projectId: adalineProjectId,
            variables: {
                cityName: cityName,
                transcript: JSON.stringify(batches[i]),
                partiesWithPeople: JSON.stringify(partiesWithPeople)
            }
        });

        allResults.push(...result.result);
    }

    return allResults;
}