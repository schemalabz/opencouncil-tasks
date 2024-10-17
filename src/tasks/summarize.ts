import { aiChat, ResultWithUsage } from "../lib/ai.js";
import { SummarizeRequest, SummarizeResult, RequestOnTranscript } from "../types.js";
import { Task } from "./pipeline.js";
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

type SpeakerSegment = Omit<SummarizeRequest['transcript'][number], 'utterances'>;

const requestedSummaryWordCount = 50;

export const summarize: Task<SummarizeRequest, SummarizeResult> = async (request, onProgress) => {
    const { transcript, topicLabels, cityName, date, requestedSubjects } = request;

    const shortIdToLong = new Map<string, string>();
    const longIdToShort = new Map<string, string>();

    const addLongIdToMaps = (longId: string) => {
        if (longIdToShort.has(longId)) return;
        // short ids should be 5 characters long, a-z, 0-9
        const shortId = Math.random().toString(36).substring(2, 8);
        if (shortIdToLong.has(shortId)) {
            addLongIdToMaps(longId);
            return;
        }
        shortIdToLong.set(shortId, longId);
        longIdToShort.set(longId, shortId);
    };

    transcript.forEach(s => {
        addLongIdToMaps(s.speakerSegmentId);
        s.utterances.forEach(u => {
            addLongIdToMaps(u.utteranceId);
        });
    });

    const shortenedIdTranscript = transcript.map(s => ({
        ...s,
        speakerSegmentId: longIdToShort.get(s.speakerSegmentId)!,
        utterances: s.utterances.map(u => ({
            ...u,
            utteranceId: longIdToShort.get(u.utteranceId)!,
        })),
    }));

    const shortenedIdRequest = {
        ...request,
        transcript: shortenedIdTranscript,
    };

    const speakerSegmentSummaries = await extractSpeakerSegmentSummaries(shortenedIdRequest, onProgress);

    const subjects = await extractSubjects({
        request: shortenedIdRequest,
        speakerSegmentSummaries,
    }, onProgress);

    return {
        speakerSegmentSummaries: speakerSegmentSummaries.map(s => ({
            topicLabels: s.topicLabels,
            summary: s.summary,
            speakerSegmentId: shortIdToLong.get(s.speakerSegmentId)!,
        })),
        subjects: subjects.map(s => ({
            name: s.name,
            description: s.description,
            speakerSegmentIds: s.speakerSegmentIds.map((ssi) => shortIdToLong.get(ssi)!),
            highlightedUtteranceIds: s.highlightedUtteranceIds.map((hui) => shortIdToLong.get(hui)!),
        })),
    }
};

function uniqify<T>(arr: T[]): T[] {
    return [...new Set(arr)];
}

export const extractSubjects: Task<{
    request: RequestOnTranscript,
    speakerSegmentSummaries: SummarizeResult['speakerSegmentSummaries']
}, SummarizeResult['subjects']> = async ({ request, speakerSegmentSummaries }, onProgress) => {
    const transcript = request.transcript;

    const systemPrompt = getExtractSubjectsSystemPrompt(request.cityName, request.date);
    const transcriptParts = splitTranscript(transcript, 100000);

    const subjects = await aiExtractSubjects(systemPrompt, transcriptParts, onProgress);

    console.log(`Finished extracting subjects, with cost ${subjects.usage.input_tokens} input tokens, ${subjects.usage.output_tokens} output tokens`);

    console.log(`Subjects: ${JSON.stringify(subjects.result, null, 2)}`);

    return subjects.result.map(s => ({
        ...s,
        speakerSegmentIds: uniqify(s.speakerSegmentIds),
        highlightedUtteranceIds: uniqify(s.highlightedUtteranceIds),
    }));
}

function splitTranscript(transcript: SpeakerSegment[], maxLengthChars: number) {
    const parts: SpeakerSegment[][] = [];
    let currentPart: SpeakerSegment[] = [];
    let currentPartLength = 0;

    for (const speakerSegment of transcript) {
        const speakerSegmentLength = JSON.stringify(speakerSegment).length;
        if (currentPartLength + speakerSegmentLength > maxLengthChars) {
            parts.push(currentPart);
            currentPart = [];
            currentPartLength = 0;
        }
        currentPart.push(speakerSegment);
        currentPartLength += speakerSegmentLength;
    }
    parts.push(currentPart);
    return parts;
}

export const extractSpeakerSegmentSummaries: Task<Omit<RequestOnTranscript, 'callbackUrl'>, SummarizeResult['speakerSegmentSummaries']> = async (request, onProgress) => {
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

    const systemPrompt = getSummarizeSystemPrompt(cityName, date, topicLabels);
    const userPrompts = splitUserPrompts(segmentsToSummarize.map(speakerSegmentToPrompt), 100000);
    console.log(`System prompt: ${systemPrompt}`);
    console.log(`User prompt split into ${userPrompts.length} prompts, with lengths: ${userPrompts.map(p => p.length).join(', ')}`);

    const summariesAndLabels = await aiSummarize(systemPrompt, userPrompts, onProgress);

    console.log(`Total usage: ${summariesAndLabels.usage.input_tokens} input tokens, ${summariesAndLabels.usage.output_tokens} output tokens`);
    console.log(`All done!`);

    return summariesAndLabels.result;

}

type AiSummarizeResponse = {
    speakerSegmentId: string;
    summary: string;
    topicLabels: string[];
};

async function aiExtractSubjects(systemPrompt: string, transcriptParts: SpeakerSegment[][], onProgress: (stage: string, progress: number) => void): Promise<ResultWithUsage<SummarizeResult['subjects']>> {
    const totalUsage: Anthropic.Messages.Usage = {
        input_tokens: 0,
        output_tokens: 0,
    };

    let subjects: SummarizeResult['subjects'] = [];

    for (let i = 0; i < transcriptParts.length; i++) {

        const shortenedSubjects = subjects.map(s => ({
            name: s.name,
            description: s.description.slice(0, 1000),
            speakerSegmentIds: [],
            highlightedUtteranceIds: [],
        }));
        onProgress("extracting subjects", i / transcriptParts.length);
        const userPrompt = `Το απόσπασμα της συνεδρίασης είναι το εξής:
        ${JSON.stringify(transcriptParts[i], null, 2)}
        
        ---
        
        Η λίστα με τα subjects, όπως διαμορφώθηκε από τα προηγούμενα μέρη της συνεδρίασης, είναι η εξής:
        ${JSON.stringify(subjects, null, 2)}
        `;

        const response = await aiChat<SummarizeResult['subjects']>(systemPrompt,
            userPrompt,
            "Δώσε τα ανανεωμένα subjects, με βάση το παραπάνω απόσπασμα της συνεδρίασης, σε μορφή JSON: \n[",
            "[");

        console.log(response);

        response.result.forEach(r => {
            const existingSubject = subjects.find(s => s.name === r.name);
            if (existingSubject) {
                existingSubject.description = r.description;
                existingSubject.speakerSegmentIds = [...existingSubject.speakerSegmentIds, ...r.speakerSegmentIds];
                existingSubject.highlightedUtteranceIds = [...existingSubject.highlightedUtteranceIds, ...r.highlightedUtteranceIds];
            } else {
                subjects.push(r);
            }
        });

        console.log(`New subjects: ${JSON.stringify(subjects, null, 2)}`);
    }

    return {
        result: subjects,
        usage: totalUsage
    };


}

async function aiSummarize(systemPrompt: string, userPrompts: string[], onProgress: (stage: string, progress: number) => void): Promise<ResultWithUsage<AiSummarizeResponse[]>> {
    const responses: AiSummarizeResponse[] = [];

    const totalUsage: Anthropic.Messages.Usage = {
        input_tokens: 0,
        output_tokens: 0,
    };

    for (let i = 0; i < userPrompts.length; i++) {
        onProgress("extracting summaries", i / userPrompts.length);
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

function getExtractSubjectsSystemPrompt(cityName: string, date: string) {
    return `
        Είσαι ένα σύστημα που διαβάζει μέρη μιας απομαγνητοφωνημένης συνεδρίασης δημοτικού συμβουλίου,
        και κάνει αλλαγές σε μια λίστα με περιγραφές και στοιχεία για τα θέματα (subjects) που συζητήθηκαν
        στη συνεδρίαση.
        
        To δημοτικό συμβούλιο που θα επεξεργαστείς αφορά την πόλη "${cityName}" και η συνεδρίαση πραγματοποιήθηκε στην ημερομηνία "${date}".

        Η απομαγνητοφωνημένη συνεδρίαση αποτελείται από speaker segments, που υπόθηκαν από κάποιο ομιλητή
        που ανήκει σε κάποια παράταξη. Κάθε speaker segment έχει πολλά utterances, που αποτελούν φράσεις που
        είπε ο ομιλητής.

        Τα θέματα (subjects) αποτελούνται το καθένα από ένα σύντομο όνομα (π.χ. "Αντιπλημμυρικά έργα"),
        μια περιγραφή (π.χ. "Συζήτηση για τις πρόσφατες πλημμύρες, και διαφωνία σχετικά με τις αρμοδιότητες των δήμων")
        μια λίστα από speaker segment ids στα οποία το θέμα συζητάται,
        και μια λίστα από highligted utterance IDs, που επισημαίνουν τις φράσεις
        που είναι πιο σημαντικές για το συγκεκριμένο θέμα. Σου δίνονται στην εξής JSON μορφή:

        subjects: {
            name: string;
            description: string;
            speakerSegmentIds: string[];
            highlightedUtteranceIds: string[];
        }[]

        Τα highlighted utterance IDs χρησιμοποιούνται για να φτιάξουν αυτόματα tik-tok reels,
        κατά τα οποία προβάλλονται τα συγκεκριμένα utterances ένα προς ένα. Οπότε, τα highlighted utterances
        για ένα θέμα πρέπει να:
        - έχουν ροή και συνέχεια
        - να σχηματίζουν τις απόψεις όλων των ομιλητών και των παρατάξεων για το συγκεκριμένο θέμα
        - να είναι περιεκτικά, και να μη περιέχουν άχρηστες φράσεις, αλλά να περιλαμβάνουν το κύριο επιχειρήμα και νόημα του ομιλητή

        Η δουλειά σου είναι να προτείνεις αλλαγές στη λίστα με τις περιγραφές και τα στοιχεία για τα θέματα (subjects) του συμβουλίου.
        Μια αρχική λίστα πιθανώς να υπάρχει ήδη, σχηματισμένη από τα προηγούμενα αποσπάσματα του ίδιου δημοτικού συμβουλίου.
        Εσύ πρέπει να την αλλάξεις, ώστε να συμπεριλάβεις τις πληροφορίες του αποσπάσματος που επεξεργάζεσαι τώρα.

        Για να αλλάξεις τη λίστα (subjects), μπορείς να προσθέσεις ένα καινούργιο θέμα, ή να προσθέσεις speaker segment IDs
        και highlighted utterance IDs σε ένα ήδη υπάρχον subject.

        Η τελική λίστα που θα προκύψει με τα subjects πρέπει να περιλαμβάνει διακριτά θέματα, με σύντομους τίτλους και περιγραφές, όλα τα speakerSegmentIds που μιλάνε για αυτό το θέμα,
        και utterances που συνθέτουν ένα περιεκτικό απόσπασμα της συνεδρίασης που μιλάει για το συγκεκριμένο θέμα.

        Όλες οι απαντήσεις σου πρέπει να είναι σε μορφή JSON, στην ακόλουθη μορφή:

        {
            name: string; // Ο τίτλος του θέματος που αλλάζεις (αν δεν υπάρχει θα προστεθεί)
            description: string; // Η περιγραφή του θέματος
            speakerSegmentIds: string[]; // Τα speaker segment ids που πρέπει να προστεθούν στο θέμα
            highlightedUtteranceIds: string[]; // Τα utterance ids που πρέπει να προστεθούν στο θέμα
        }[]
        
        Δε χρειάζεται να συμπεριλάβεις στην απάντηση σου subjects που δεν αλλάζουν.
    `
}

function getSummarizeSystemPrompt(cityName: string, date: string, topicLabels: string[]) {
    const exampleTranscript: SpeakerSegment[] = [{
        speakerName: "Χρήστος Χρήστου",
        speakerParty: "Καλύτερη Πόλη",
        speakerRole: null,
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
        speakerRole: null,
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