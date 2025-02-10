import { FixTranscriptResult } from "../types.js";
import { FixTranscriptRequest } from "../types.js";
import { Task } from "../tasks/pipeline.js";
import fs from 'fs';
import { addUsage, aiWithAdaline, NO_USAGE, ResultWithUsage } from "../lib/ai.js";

const adalineProjectId = "e1ca2400-8500-4f55-8471-54166eb7e29c";
const MAX_PARALLEL_API_CALLS = 20;

export const fixTranscript: Task<FixTranscriptRequest, FixTranscriptResult> = async (request, onProgress) => {
    const { transcript, partiesWithPeople, cityName } = request;
    console.log(`Fixing transcript for ${cityName} with ${transcript.length} segments`);
    const inputUtterances = transcript.flatMap(s => s.utterances.map(u => u.text)).length;

    const allResults = await fixSpeakerSegments(transcript, cityName, partiesWithPeople, onProgress);
    const markedUncertain = allResults.result.filter(r => r.markUncertain).length;
    console.log(`Proposing ${allResults.result.length} updates (${allResults.result.length / inputUtterances * 100}%), ${markedUncertain} marked uncertain`);
    console.log(`Total usage: ${allResults.usage.input_tokens} input tokens, ${allResults.usage.output_tokens} output tokens`);

    return { updateUtterances: allResults.result, usage: allResults.usage };
};

async function processSpeakerSegment(segment: FixTranscriptRequest['transcript'][0], cityName: string, partiesWithPeople: any): Promise<ResultWithUsage<FixTranscriptResult['updateUtterances']>> {
    if (segment.utterances.length === 0) {
        console.warn(`Speaker segment has no utterances: skipping`);
        return { result: [], usage: NO_USAGE };
    }

    const result = await aiWithAdaline<string>({
        projectId: adalineProjectId,
        variables: {
            cityName: cityName,
            personName: segment.speakerName || "(unknown)",
            utterances: segment.utterances.map(u => u.text).join("||"),
            partiesWithPeople: JSON.stringify(partiesWithPeople)
        },
        parseJson: false
    });

    const fixedUtterances = result.result.split("||");

    if (fixedUtterances.length !== segment.utterances.length) {
        console.error(`Fixed utterances length does not match original utterances length: input had ${segment.utterances.length} utterances, output has ${fixedUtterances.length} utterances`);
        return { result: [], usage: NO_USAGE };
    }

    const utteranceUpdates = fixedUtterances.map((u, index) => {
        const utterance = segment.utterances[index];
        if (utterance.text.trim() === u.trim()) {
            return null; // no change, omit
        }

        return {
            utteranceId: utterance.utteranceId,
            text: u,
            markUncertain: false
        };
    }).filter(u => u !== null);

    console.log(`Fixed ${utteranceUpdates.length} (${utteranceUpdates.length / segment.utterances.length * 100}%) utterances for ${segment.speakerName}`);

    return { result: utteranceUpdates, usage: result.usage };
}

async function fixSpeakerSegments(speakerSegments: FixTranscriptRequest['transcript'], cityName: string, partiesWithPeople: any, onProgress: (stage: string, progress: number) => void): Promise<ResultWithUsage<FixTranscriptResult['updateUtterances']>> {
    const allResults: FixTranscriptResult['updateUtterances'] = [];
    let processedCount = 0;

    let usage = NO_USAGE;

    // Process segments in batches
    for (let i = 0; i < speakerSegments.length; i += MAX_PARALLEL_API_CALLS) {
        const batch = speakerSegments.slice(i, i + MAX_PARALLEL_API_CALLS);
        const batchPromises = batch.map(segment =>
            processSpeakerSegment(segment, cityName, partiesWithPeople)
        );

        const batchResults = await Promise.all(batchPromises);
        processedCount += batch.length;
        console.log(`Processed ${processedCount} of ${speakerSegments.length} speaker segments (${processedCount / speakerSegments.length * 100}%)`);
        onProgress("processing speaker segments", processedCount / speakerSegments.length);

        for (const results of batchResults) {
            allResults.push(...results.result);
            usage = addUsage(usage, results.usage);
        }
    }

    return { result: allResults, usage };
}