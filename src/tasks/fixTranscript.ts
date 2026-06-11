import { FixTranscriptResult } from "../types.js";
import { FixTranscriptRequest } from "../types.js";
import { Task } from "../tasks/pipeline.js";
import { addUsage, aiChat, NO_USAGE, ResultWithUsage } from "../lib/ai.js";

const MAX_PARALLEL_API_CALLS = 20;
// Attempts per segment: the numbered-line structure is validated
// programmatically, and a count mismatch gets a fresh retry
const MAX_FIX_ATTEMPTS = 3;

const systemPrompt = `You are correcting an automatic transcription (made by ElevenLabs Scribe) of a Greek city council meeting. You receive ONE speaker segment: consecutive utterances spoken by the same person, as numbered lines:

1. <utterance>
2. <utterance>
...

OUTPUT: the same numbered lines, same count, each line corrected. No explanations. Never merge, split, reorder, or renumber lines — utterance boundaries carry timestamps and must not move, even if a sentence spans two lines.

WHAT TO FIX (in priority order):

1. NAMES — the most common error. The speech-to-text often misspells names phonetically (e.g. «Ρημάκης» for «Δημάκης», «Ξυδαροπούλου» for «Ξηνταροπούλου»). Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.

2. HOMOPHONE MISSPELLINGS — same sound, wrong letters: «απόν»→«απών», «πολεδομία»→«πολεοδομία», «κλιματολόγιο»→«κτηματολόγιο» (context: land registry), «ονομάδων»→«ονομάτων», ο/ω, η/ι/υ, αι/ε confusions. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «τριακοστή πέμπτη συνεδρίαση»→«35η συνεδρίαση», «πέντε Δεκεμβρίου του 2025»→«05/12/2025» for full dates, «άρθρο εβδομήντα πέντε»→«άρθρο 75». Money and percentages also as digits («2,5 εκατομμύρια ευρώ», «15%»).

4. Greek punctuation and accents: «;» for questions (never «?»), proper τόνοι («Μαρια;»→«Μαρία;»), capitalize proper nouns normally («ΖΕΜΕΝΟ»→«Ζεμενό»).

WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices («γραφούν» stays «γραφούν», not «εγγραφούν»). Spoken Greek in the record stays spoken Greek, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers («ναι ναι», «το γράψατε;») — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

export function buildUserPrompt(
    cityName: string,
    parties: FixTranscriptRequest['partiesWithPeople'],
    agenda: { name: string }[],
    personName: string,
    utterances: string[]
): string {
    const agendaBlock = agenda.length > 0
        ? `Agenda items of this meeting (source for street/project/entity names):\n${agenda.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}\n`
        : '';
    return `City: ${cityName}
Speaker: ${personName}
Roster (party — members):
${parties.map(p => `${p.name}: ${p.people.map(x => x.name).join(', ')}`).join('\n')}
${agendaBlock}Correct the numbered utterances:
${utterances.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
}

function countNumberedLines(text: string): number {
    return text.split('\n').filter((line) => /^\s*\d+\.\s/.test(line)).length;
}

/**
 * Parses the model's numbered-line output back into utterances.
 *
 * Lines must be numbered sequentially from 1; non-empty lines that don't start
 * the next expected number are treated as wrapped continuations of the previous
 * utterance. Returns null when the structure or count doesn't match, so the
 * caller can retry instead of corrupting utterance/timestamp alignment.
 */
export function parseNumberedUtterances(text: string, expectedCount: number): string[] | null {
    const parsed: string[] = [];

    for (const line of text.trim().split('\n')) {
        const match = line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (match && parseInt(match[1], 10) === parsed.length + 1) {
            parsed.push(match[2].trim());
        } else if (match) {
            // A numbered line with the wrong index means skipped, duplicated,
            // or reordered numbering. Folding it into the previous utterance
            // would corrupt the record silently — reject so the caller retries.
            return null;
        } else if (line.trim() === '') {
            continue;
        } else if (parsed.length > 0) {
            parsed[parsed.length - 1] += ' ' + line.trim();
        } else {
            return null; // preamble before the first numbered line
        }
    }

    return parsed.length === expectedCount ? parsed : null;
}

export const fixTranscript: Task<FixTranscriptRequest, FixTranscriptResult> = async (request, onProgress) => {
    const { transcript, partiesWithPeople, cityName, agendaItems } = request;
    console.log(`Fixing transcript for ${cityName} with ${transcript.length} segments`);
    const inputUtterances = transcript.flatMap(s => s.utterances.map(u => u.text)).length;

    const allResults = await fixSpeakerSegments(transcript, cityName, partiesWithPeople, agendaItems ?? [], onProgress);
    const markedUncertain = allResults.result.filter(r => r.markUncertain).length;
    console.log(`Proposing ${allResults.result.length} updates (${allResults.result.length / inputUtterances * 100}%), ${markedUncertain} marked uncertain`);
    console.log(`Total usage: ${allResults.usage.input_tokens} input tokens, ${allResults.usage.output_tokens} output tokens`);

    return { updateUtterances: allResults.result, usage: allResults.usage };
};

async function processSpeakerSegment(
    segment: FixTranscriptRequest['transcript'][0],
    cityName: string,
    partiesWithPeople: FixTranscriptRequest['partiesWithPeople'],
    agendaItems: { name: string }[]
): Promise<ResultWithUsage<FixTranscriptResult['updateUtterances']>> {
    if (segment.utterances.length === 0) {
        console.warn(`Speaker segment has no utterances: skipping`);
        return { result: [], usage: NO_USAGE };
    }

    const utteranceTexts = segment.utterances.map(u => u.text);
    const userPrompt = buildUserPrompt(cityName, partiesWithPeople, agendaItems, segment.speakerName || "(unknown)", utteranceTexts);

    let usage = NO_USAGE;
    let structureReminder = "";
    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        const result = await aiChat<string>({
            model: "claude-sonnet-4-6",
            label: "transcript-fix",
            systemPrompt,
            userPrompt: userPrompt + structureReminder,
            parseJson: false
        });
        usage = addUsage(usage, result.usage);

        const fixedUtterances = parseNumberedUtterances(result.result, segment.utterances.length);
        if (!fixedUtterances) {
            // aiChat pins temperature 0, so an identical retry prompt would get
            // an identical response — tell the model what was wrong instead
            const observedLines = countNumberedLines(result.result);
            const problem = observedLines === segment.utterances.length
                ? "its numbered lines were malformed (they must start at 1., increase sequentially, and have no text before the first numbered line)"
                : `it contained ${observedLines} numbered lines but the input has ${segment.utterances.length} utterances`;
            structureReminder = `\n\nIMPORTANT (retry ${attempt + 1}): your previous response could not be used because ${problem}. Output ONLY lines numbered 1. to ${segment.utterances.length}, exactly one line per input utterance, with no preamble or explanations.`;
            console.error(`Output structure mismatch for ${segment.speakerName} (attempt ${attempt}/${MAX_FIX_ATTEMPTS}): expected ${segment.utterances.length} numbered utterances, got ${observedLines}`);
            continue;
        }

        const utteranceUpdates = fixedUtterances.map((u, index) => {
            const utterance = segment.utterances[index];
            if (utterance.text.trim() === u) {
                return null; // no change, omit
            }

            return {
                utteranceId: utterance.utteranceId,
                text: u,
                markUncertain: false
            };
        }).filter(u => u !== null);

        console.log(`Fixed ${utteranceUpdates.length} (${utteranceUpdates.length / segment.utterances.length * 100}%) utterances for ${segment.speakerName}`);

        return { result: utteranceUpdates, usage };
    }

    console.error(`Giving up on segment for ${segment.speakerName} after ${MAX_FIX_ATTEMPTS} attempts`);
    return { result: [], usage };
}

async function fixSpeakerSegments(
    speakerSegments: FixTranscriptRequest['transcript'],
    cityName: string,
    partiesWithPeople: FixTranscriptRequest['partiesWithPeople'],
    agendaItems: { name: string }[],
    onProgress: (stage: string, progress: number) => void
): Promise<ResultWithUsage<FixTranscriptResult['updateUtterances']>> {
    const allResults: FixTranscriptResult['updateUtterances'] = [];
    let processedCount = 0;

    let usage = NO_USAGE;

    // Process segments in batches
    for (let i = 0; i < speakerSegments.length; i += MAX_PARALLEL_API_CALLS) {
        const batch = speakerSegments.slice(i, i + MAX_PARALLEL_API_CALLS);
        const batchPromises = batch.map(segment =>
            processSpeakerSegment(segment, cityName, partiesWithPeople, agendaItems)
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
