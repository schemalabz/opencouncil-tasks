import { aiChat, ResultWithUsage } from "../lib/ai.js";
import { SummarizeRequest, SummarizeResult } from "../types.js";
import { Task } from "./pipeline.js";
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
type SpeakerSegment = SummarizeRequest['transcript'][number];

const requestedSummaryWordCount = 50;

export const summarize: Task<SummarizeRequest, SummarizeResult> = async (request, onProgress) => {
    const { transcript, topicLabels, cityName, date } = request;
    const segmentsToSummarize = transcript.filter((t) => {
        const wordCount = t.text.split(' ').length;
        return wordCount >= 40;
    });

    const originalWordCount = transcript.map(s => s.text.split(' ').length).reduce((a, b) => a + b, 0);
    const toSummarizeWordCount = segmentsToSummarize.map(s => s.text.split(' ').length).reduce((a, b) => a + b, 0);


    console.log(`Received a transcript with:`);
    console.log(`- ${transcript.length} speaker segments`);
    console.log(`- ${topicLabels.length} topic labels`);
    console.log(`- ${originalWordCount} words`);
    console.log(`- ${toSummarizeWordCount} words to summarize (only ${Math.round(toSummarizeWordCount / originalWordCount * 100)}% of total)`);

    const systemPrompt = getSystemPrompt(cityName, date, topicLabels);
    const userPrompts = splitUserPrompts(segmentsToSummarize.map(speakerSegmentToPrompt), 50000);
    console.log(`System prompt: ${systemPrompt}`);
    console.log(`User prompt split into ${userPrompts.length} prompts, with lengths: ${userPrompts.map(p => p.length).join(', ')}`);

    const summariesAndLabels = await aiSummarize(systemPrompt, userPrompts, onProgress);

    console.log(`Total usage: ${summariesAndLabels.usage.input_tokens} input tokens, ${summariesAndLabels.usage.output_tokens} output tokens`);
    console.log(`All done!`);

    return {
        speakerSegmentSummaries: summariesAndLabels.result,
    }
}

type AiSummarizeResponse = {
    speakerSegmentId: string;
    summary: string;
    topicLabels: string[];
};

async function aiSummarize(systemPrompt: string, userPrompts: string[], onProgress: (stage: string, progress: number) => void): Promise<ResultWithUsage<AiSummarizeResponse[]>> {
    const responses: AiSummarizeResponse[] = [];

    const totalUsage: Anthropic.Messages.Usage = {
        input_tokens: 0,
        output_tokens: 0,
    };

    for (let i = 0; i < userPrompts.length; i++) {
        onProgress("summarizing", i / userPrompts.length);
        const userPrompt = userPrompts[i];
        const response = await aiChat<AiSummarizeResponse[]>(systemPrompt,
            userPrompt,
            "Με βάση τις τοποθετήσεις των συμμετεχόντων, ακολουθούν οι περιλήψεις και οι θεματικές λεζάντες σε μορφή JSON: \n[",
            "[");
        responses.push(...response.result);
        totalUsage.input_tokens += response.usage.input_tokens;
        totalUsage.output_tokens += response.usage.output_tokens;
        console.log(response);
    }

    return {
        result: responses,
        usage: totalUsage
    };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Splits a user prompt into multiple prompts of a given maximum length in characters
function splitUserPrompts(userPrompts: string[], maxLengthChars: number) {
    const prompts: string[] = [];
    let currentPrompt = "";
    for (const userPrompt of userPrompts) {
        if (currentPrompt.length + userPrompt.length > maxLengthChars) {
            prompts.push(currentPrompt);
            currentPrompt = "";
        }
        currentPrompt += userPrompt;
    }
    prompts.push(currentPrompt);
    return prompts;
}

function getSystemPrompt(cityName: string, date: string, topicLabels: string[]) {
    const exampleTranscript: SpeakerSegment[] = [{
        speakerName: "Χρήστος Χρήστου",
        speakerParty: "Καλύτερη Πόλη",
        speakerSegmentId: "abcdefg1234567890",
        text: `
        Κύριε Πρόεδρε, σύντομα, μια κουβέντα για την καθημερινότητα.
        Η Αθήνα είναι αντικειμενικά μια δύσκολη πόλη.Και η καθημερινότητα
        στην Αθήνα είναι μια πολύ δύσκολη υπόθεση.Δεν υπάρχει καμία εμβολία γι'αυτό.
        Και εμείς το ξέρουμε πάρα πολύ καλά αυτό, όπως θέλω να πιστεύω το ξέρετε κι εσείς.
        Και αν θέλουμε να είμαστε απόλυτος ειλικρινείς, η καθημερινότητα δεν κερδίζεται.
        Ποτέ.Όμως χάνεται.Χάνεται όταν δεν γίνεται μια σοβαρή προσπάθεια.
        Και πολύ φοβάμαι κύριε Πρόεδρε πως είμαστε κοντά σε αυτό το σημείο.
        Η πολιτική του αυτόματου πιλότου φτάνει στα οριάτες.
        `
    }, {
        speakerName: "Θανάσης Παπαγιώργος",
        speakerParty: "Αναγέννηση Τώρα",
        speakerSegmentId: "abcdefg1234567891",
        text: `
        Με συγχωρείτε κύριε Παπαδόπουλε, δεν ακόυγεστε καλά.Ναι με ακούτε;
    `
    }
    ];

    const expectedResponse: SummarizeResult['speakerSegmentSummaries'] = [
        {
            speakerSegmentId: "abcdefg1234567890",
            summary: "Η καθημερινότητα στην Αθήνα είναι δύσκολη. Η πολιτική του αυτόματου πιλότου φτάνει στα όριά της.",
            topicLabels: []
        }
    ];

    return `
        Είσαι ένα σύστημα που παράγει σύντομες περιλήψεις και θεματικές λεζάντες για τις τοποθετήσεις συμμετεχόντων σε δημοτικά συμβούλια.
        Σήμερα θα συντάξεις περιλήψεις για το δημοτικό συμβούλιο της πόλης "${cityName}" που πραγματοποιήθηκε στην ημερομηνία "${date}".

        Οι περιλήψεις σου πρέπει να είναι σύντομες(1 - 3 προτάσεις, μέχρι περίπου ${requestedSummaryWordCount} λέξεις),
        και να ανφέρονται στην ουσία και τα πιο σημαντικά θέματα της τοποθέτησης του εκάστοτε
        συμμετέχοντα. Χρησιμοποίησε, αν και όσο γίνεται, λέξεις που χρησιμοποίησε και ο
        συμμετέχοντας(δε χρειάζονται εισαγωγικά). Δε χρειάζεται να αναφέρεις το όνομα του
        ομιλούντα. Μην χρησιμοποιείς τον ομιλητή ως υποκείμενο της πρότασης, δηλαδή μη ξεκινάς
        τις περιλήψεις με "ο ομιλτής..." ή "ο συμμετέχων...". Αντί για αυτό, δώσε τη περίληψη μιλώντας
        ως ο ομιλητής, π.χ. "Η καθαριότητα στο δήμο είναι μεγάλο πρόβλημα".
        
        Οι τοποθετήσεις που σου παρέχονται, είναι απομαγνητοφωνημένες αυτόματα,
        και μπορεί να έχουν μικρά λάθη σε σημεία.

            Επίσης, μπορείς να διαλέξεις θεματικές λεζάντες σχετικές με την τοποθέτηση του κάθε ομιλητή.
        Οι θεματικές λεζάντες που μπορείς να χρησιμοποιήσεις είναι μόνο οι ακόλουθες:
        ${topicLabels.map(label => `- ${label}`).join('\n')}

        Οι περιλήψεις και οι θεματικές λεζάντες που παράγεις, δε πρέπει να αναφέρονται σε τεχνικά θέματα
        που ίσως να υπήρχαν στην τοποθέτηση, ούτε διαδικαστικά ζητήματα όπως οι παρουσίες που παίρνονται από
        τη γραμματέα.

        Αν μία τοποθέτηση είναι καθαρά διαδικαστική, δηλαδή δε περιέχει σημαντικά θέματα ή απόψεις, δε χρειάζεται να παράγεις περίληψη.
        Επίσης μία τοποθέτηση μπορεί να μην χρειάζεται καμία θεματική λεζάντα.

        Τα αποτελέσματα που θα παράγεις πρέπει να είναι στα ελληνικά, σε JSON, στην ακόλουθη μορφή:
    [
        { speakerSegmentId: string, summary: string, topicLabels: string[] }
    ]

        Πρέπει να απαντήσεις μόνο με JSON, και απολύτως τίποτα άλλο.

        Ακολουθεί ένα παράδειγμα:

    --- αρχή παραδείγματος-- -
        ${exampleTranscript.map(speakerSegmentToPrompt).join('\n')}
    --- τέλος παραδείγματος-- -

        Μια καλή απάντηση σε αυτό είναι η ακόλουθη:
        ${JSON.stringify(expectedResponse)}
    
        Θυμίσου πως πρέπει πάντα να απαντάς μόνο με JSON, και απολύτως τίποτα άλλο.
    `
        ;
}

const speakerSegmentToPrompt = (speakerSegment: SpeakerSegment) => {
    return `
        < SPEAKERSEGMENT id = "${speakerSegment.speakerSegmentId}" speaker = "${speakerSegment.speakerName}" party = "${speakerSegment.speakerParty}" >

            ${speakerSegment.text}

    </SPEAKERSEGMENT>
        `;
}