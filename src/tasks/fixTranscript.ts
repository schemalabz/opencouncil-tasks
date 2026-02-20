import { FixTranscriptResult } from "../types.js";
import { FixTranscriptRequest } from "../types.js";
import { Task } from "../tasks/pipeline.js";
import { addUsage, aiChat, NO_USAGE, ResultWithUsage } from "../lib/ai.js";

const MAX_PARALLEL_API_CALLS = 20;

const systemPrompt = `You are a system responsible for improving an existing automatic transcription of city council meeting in Greece. The transcript is made up of Speaker Segments, spoken by a certain speaker, which have Utterances. You are given a single speaker segment, spoken by the same speaker, in the following format:

Utterance 1 || Utterance 2 || Utterance 3 || ... || Last Utterance

For example:

Καλησπέρα κύριοι συνάδελφοι. || Ξεκινάει η 5η συνεδρίαση || του Δημοτικού Συμβουλίου της Αθήνας


Your input speaker segment might contain mistakes that occurred as part of the speech-to-text process. You are responsible for editing the utterances to fix spelling errors, punctuation, accents (τόνοι in greek), syntax/grammar errors, obvious transcription mistakes, person and entity names.

It's important to avoid changing the meaning of what was said: your purpose is only to fix transcription mistakes, and make the transcript look more polished and correct. Your output will form the official meeting transcription.

It's important to fix spelling, grammar, and transcription mistakes (e.g. words that were transcribed incorrectly because they are acoustically similar). Do not fix factual mistakes, and don't change the meaning of what was said.

Ιt's important to fix as many grammar mistakes and spelling mistakes and mistakes in speaker and party names as possible! The final transcript must be correct and look polished.

Indicative examples of corrections you should make:
1. In the text "Ζωγράφος από το ΖΕΜΕΝΟ.", you should change it to "Ζωγράφος από το Ζεμενό.", because place names should be properly capitalized and not in all caps.

2. In the text "θα μοιραστεί στους επικεφαλείς και σε όλους τους", you should change it to "θα μοιραστεί στους επικεφαλής και σε όλους τους", because "επικεφαλής" is the correct spelling of this word.

3. In the text "Μαρια?", you should change it to "Μαρία;", because in Greek, questions should use the question mark (;) rather than the English question mark (?), and because the original text was missing an accent.

4. In the text "Θέλω να ρωτήσω ποια ήταν η δαπάνη για την πόλη του Ξυλοκάστρου και ποια ήταν για τη Δημοτική Ενότητα της Ευρωστήνης.", you should change it to "Θέλω να ρωτήσω ποια ήταν η δαπάνη για την πόλη του Ξυλοκάστρου και ποια ήταν για τη Δημοτική Ενότητα της Ευρωστίνης.", because municipal entity names should be spelled correctly ("Ευρωστίνης" is the correct spelling).

5. In the text "εσείς τα έχετε πρόχειρα;", you should change it to "εσείς; Ή δεν τα έχετε πρόχειρα;", because the context shows this was a two-part question that was incorrectly transcribed as one.

6. In the text "Κύριε Μπακούλη.", you should change it to "Κύριε Μπρακούλια.", because person names should be transcribed correctly, and context shows this is the correct spelling of the name.

7. In the text "Ήδη έγινε σηματοδότηση φάνη από χτες το βράδυ", you should change it to "Ήδη έγινε σηματοδότηση από χτες το βράδυ", because "φάνη" appears to be an erroneous transcription of background noise or unclear speech.

8. In the text "να εξασφαλίσουμε την απαρτία με την ανάγνωση των ονομάδων.", you should suggest changing "ονομάδων" to "ονομάτων", because it fixes a spelling error and makes the meaning clearer (reading names to ensure quorum, not teams).

9. In the text "Επιηκός. Παρακαλώ λίγο εσύ εκεί να ολοκληρώσεις τον κύριο Σμπομπολάκης.", you should suggest changing "Επιηκός" to "Επιεικώς", because it fixes a spelling error for the adverb meaning "leniently".

10. In the text "αφορά τη διόρθωση του κλιματολογίου., σε ένα ακίνητο που ανήκει στην περιοχή στα χωραφάκια πάνω,", you should suggest changing "κλιματολογίου" to "κτηματολογίου", because it fixes a mistranscription and makes the meaning clearer (correction of the land registry, not climatology).

11. In the text "Και βγήκε η πολεδομία και σας έγραψε για φθαίρετες εργασίες εκεί πέρα.", you should suggest changing "πολεδομία" to "πολεοδομία" and "φθαίρετες" to "αυθαίρετες", because it fixes spelling errors for the words "urban planning" and "arbitrary".

Your output should be only the input speaker segment with any fixes you applied, with the utterances separated by ||. It's important to preserve the original count of utterances (e.g. if your input had 5 utterances, you must preserve this structure and output 5 utterances). Do not output an explanation or anything else; just the utterances separated by ||.`;

function buildUserPrompt(cityName: string, partiesWithPeople: any, personName: string, utterances: string): string {
    return `You are improving the transcript for city ${cityName},
with the following parties and persons names:

${JSON.stringify(partiesWithPeople)}

Please fix the transcription mistakes and errors in the speaker segment spoken by ${personName} below:

${utterances}

Reply only with the fixed speaker segment, with the utterances separated by ||:`;
}

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

    const utterancesText = segment.utterances.map(u => u.text).join("||");
    const userPrompt = buildUserPrompt(cityName, partiesWithPeople, segment.speakerName || "(unknown)", utterancesText);

    const result = await aiChat<string>({
        model: "claude-sonnet-4-6-latest",
        systemPrompt,
        userPrompt,
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
