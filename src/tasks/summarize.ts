import { aiChat, ResultWithUsage } from "../lib/ai.js";
import { SummarizeRequest, SummarizeResult, RequestOnTranscript, SubjectContext } from "../types.js";
import { Task } from "./pipeline.js";
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { ExtractedSubject, extractedSubjectToApiSubject } from "./processAgenda.js";
import { IdCompressor, formatTime } from "../utils.js";
import { enhanceSubjectWithContext } from "../lib/sonar.js";
dotenv.config();

type SpeakerSegment = Omit<SummarizeRequest['transcript'][number], 'utterances'>;

const requestedSummaryWordCount = 50;
const compressIds = (request: SummarizeRequest, idCompressor: IdCompressor) => {
    const shortenedIdTranscript = request.transcript.map(s => ({
        ...s,
        speakerSegmentId: idCompressor.addLongId(s.speakerSegmentId),
        utterances: s.utterances.map(u => ({
            ...u,
            utteranceId: idCompressor.addLongId(u.utteranceId),
        })),
    }));

    return {
        ...request,
        transcript: shortenedIdTranscript,
    };
};

const decompressIds = (result: SummarizeResult, idCompressor: IdCompressor): SummarizeResult => {
    return {
        speakerSegmentSummaries: result.speakerSegmentSummaries.map(s => ({
            ...s,
            speakerSegmentId: idCompressor.getLongId(s.speakerSegmentId),
        })),
        subjects: result.subjects.map(s => ({
            ...s,
            speakerSegments: s.speakerSegments.map(seg => ({
                speakerSegmentId: idCompressor.getLongId(seg.speakerSegmentId),
                summary: seg.summary
            })),
            highlightedUtteranceIds: s.highlightedUtteranceIds.map(hui =>
                idCompressor.getLongId(hui)
            ),
        })),
    };
};

export const summarize: Task<SummarizeRequest, SummarizeResult> = async (request, onProgress) => {
    const { additionalInstructions, existingSubjects, requestedSubjects } = request;
    const idCompressor = new IdCompressor();
    const shortenedIdRequest = compressIds(request, idCompressor);

    const speakerSegmentSummaries = await extractSpeakerSegmentSummaries(shortenedIdRequest, onProgress);

    const subjects = await extractSubjects({
        request: shortenedIdRequest,
        additionalInstructions,
        existingSubjects,
        requestedSubjects,
    }, onProgress);

    console.log(`Extracted ${subjects.length} subjects`);

    const enhancedSubjects = await Promise.all(subjects.map(s => enhanceSubjectWithContext({
        subject: s,
        cityName: request.cityName,
        date: request.date
    })));

    return decompressIds({
        speakerSegmentSummaries,
        subjects: enhancedSubjects
    }, idCompressor);
};

export const extractSubjects: Task<{
    request: RequestOnTranscript,
    requestedSubjects: SummarizeRequest['requestedSubjects'],
    existingSubjects: SummarizeRequest['existingSubjects'],
    additionalInstructions?: string;
}, SummarizeResult['subjects']> = async ({ request, requestedSubjects, existingSubjects, additionalInstructions }, onProgress) => {
    const transcript = request.transcript;

    const systemPrompt = getExtractSubjectsSystemPrompt(request.cityName, request.date, request.topicLabels, additionalInstructions);
    const transcriptParts = splitTranscript(transcript, 130000);

    const subjects = await aiExtractSubjects(systemPrompt, transcriptParts, existingSubjects.map(s => ({
        ...s,
        locationText: s.location?.text ?? null,
    })), requestedSubjects, onProgress);

    console.log(`Finished extracting subjects, with cost ${subjects.usage.input_tokens} input tokens, ${subjects.usage.output_tokens} output tokens`);

    console.log(`Subjects: ${JSON.stringify(subjects.result, null, 2)}`);

    return Promise.all(subjects.result.map(s => extractedSubjectToApiSubject(s, request.cityName)));
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

export const extractSpeakerSegmentSummaries: Task<Omit<RequestOnTranscript & { additionalInstructions?: string }, 'callbackUrl'>, SummarizeResult['speakerSegmentSummaries']> = async (request, onProgress) => {
    const { transcript, topicLabels, cityName, date, additionalInstructions } = request;
    const segmentsToSummarize = transcript.filter((t) => {
        const wordCount = t.text.split(' ').length;
        return wordCount >= 10;
    });

    const originalWordCount = transcript.map(s => s.text.split(' ').length).reduce((a, b) => a + b, 0);
    const toSummarizeWordCount = segmentsToSummarize.map(s => s.text.split(' ').length).reduce((a, b) => a + b, 0);


    console.log(`Received a transcript with:`);
    console.log(`- ${transcript.length} speaker segments`);
    console.log(`- ${topicLabels.length} topic labels`);
    console.log(`- ${originalWordCount} words`);
    console.log(`- ${toSummarizeWordCount} words to summarize (only ${Math.round(toSummarizeWordCount / originalWordCount * 100)}% of total)`);

    const systemPrompt = getSummarizeSystemPrompt(cityName, date, topicLabels, additionalInstructions);
    const userPrompts = splitUserPrompts(segmentsToSummarize.map(speakerSegmentToPrompt), 200000);
    console.log(`User prompt split into ${userPrompts.length} prompts, with lengths: ${userPrompts.map(p => p.length).join(', ')}`);

    const summariesAndLabels = await aiSummarize(systemPrompt, userPrompts, onProgress);

    console.log(`Total usage: ${summariesAndLabels.usage.input_tokens} input tokens, ${summariesAndLabels.usage.output_tokens} output tokens`);
    console.log(`Summaries extrafted!`);

    return summariesAndLabels.result;
}

type AiSummarizeResponse = {
    speakerSegmentId: string;
    summary: string;
    topicLabels: string[];
    type: "SUBSTANTIAL" | "PROCEDURAL";
};

async function aiExtractSubjects(systemPrompt: string, transcriptParts: SpeakerSegment[][], existingSubjects: ExtractedSubject[], requestedSubjects: SummarizeRequest['requestedSubjects'], onProgress: (stage: string, progress: number) => void): Promise<ResultWithUsage<ExtractedSubject[]>> {
    const totalUsage: Anthropic.Messages.Usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };

    let subjects: ExtractedSubject[] = existingSubjects;
    console.log(`Starting with ${subjects.length} existing subjects`);

    for (let i = 0; i < transcriptParts.length; i++) {
        try {
            onProgress("extracting subjects", i / transcriptParts.length);
            const userPrompt = `Το απόσπασμα της συνεδρίασης είναι το εξής:
            ${JSON.stringify(transcriptParts[i], null, 2)}
            
            ---

            ${requestedSubjects.length > 0 ? `Αν στο παραπάνω transcript αναφέρεται κάποιο από τα ακόλουθα θέματα, είναι σημαντικό να το συμπεριλάβεις (ή να το ανανεώσεις αν υπάρχει ήδη): ${requestedSubjects.map(s => `- ${s}`).join('\n')}` : ""}
            
            \nΗ λίστα με τα υπάρχοντα subjects, όπως διαμορφώθηκε από τα προηγούμενα μέρη της συνεδρίασης και την ημερήσια διάταξη, είναι η εξής:
            ${JSON.stringify(subjects, null, 2)}
            `;

            const response = await aiChat<ExtractedSubject[]>({
                systemPrompt,
                userPrompt,
                prefillSystemResponse: "Δώσε τα ανανεωμένα subjects σε μορφή JSON array. Μην προσθέσεις σχόλια ή επεξηγήσεις μέσα στο JSON:\n[",
                prependToResponse: "[",
            });

            if (!Array.isArray(response.result)) {
                console.warn("Invalid response format from AI, skipping...");
                continue;
            }

            response.result.forEach(r => {
                const existingSubject = subjects.find(s => s.name === r.name);
                if (existingSubject) {
                    existingSubject.description = r.description;
                    existingSubject.locationText = r.locationText;
                    // TODO
                    // existingSubject.introducedByPersonId = r.introducedByPersonId;
                    existingSubject.topicLabel = r.topicLabel;
                    existingSubject.speakerSegments = [...existingSubject.speakerSegments, ...r.speakerSegments].filter((segment, index, self) =>
                        index === self.findIndex(s => s.speakerSegmentId === segment.speakerSegmentId)
                    );
                    existingSubject.highlightedUtteranceIds = [...existingSubject.highlightedUtteranceIds, ...r.highlightedUtteranceIds];
                    console.log(`Updated subject ${existingSubject.name} with ${r.speakerSegments.length} speaker segments, in total now ${existingSubject.speakerSegments.length} speaker segments`);
                } else {
                    console.log(`Adding new subject ${r.name} (with ${r.speakerSegments.length} speaker segments)`);
                    subjects.push(r);
                }
            });

            console.log(`Total subjects: ${subjects.length}`);
        } catch (error) {
            console.error("Error processing transcript part", i, error);
            continue;
        }
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
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };

    for (let i = 0; i < userPrompts.length; i++) {
        onProgress("extracting summaries", i / userPrompts.length);
        const userPrompt = userPrompts[i];
        const response = await aiChat<AiSummarizeResponse[]>({
            systemPrompt,
            userPrompt,
            prefillSystemResponse: "Με βάση τις τοποθετήσεις των συμμετεχόντων, ακολουθούν οι περιλήψεις και οι θεματικές λεζάντες σε μορφή JSON: \n[",
            prependToResponse: "[",
        });
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

function getExtractSubjectsSystemPrompt(cityName: string, date: string, topicLabels: string[], additionalInstructions?: string) {
    return `
        Είσαι ένα σύστημα που διαβάζει μέρη μιας απομαγνητοφωνημένης συνεδρίασης δημοτικού συμβουλίου,
        και κάνει αλλαγές σε μια λίστα με περιγραφές και στοιχεία για τα θέματα (subjects) που συζητήθηκαν
        στη συνεδρίαση.
        
        To δημοτικό συμβούλιο που θα επεξεργαστείς αφορά την πόλη "${cityName}" και η συνεδρίαση πραγματοποιήθηκε στην ημερομηνία "${date}".

        Η απομαγνητοφωνημένη συνεδρίαση αποτελείται από speaker segments, που υπόθηκαν από κάποιο ομιλητή
        που ανήκει σε κάποια παράταξη. Κάθε speaker segment έχει πολλά utterances, που αποτελούν φράσεις που
        είπε ο ομιλητής.

        Τα θέματα (subjects) αποτελούνται το καθένα από:
        - ένα σύντομο όνομα (π.χ. "Αντιπλημμυρικά έργα")
        - μια περιγραφή
        - μια λίστα από speaker segments: κάθε speaker segment έχει ένα speaker segment id και ένα summary. Το summary περιγράφει το τι είπε ο ομιλητής στο segment επί του θέματος:
          δε χρειάζεται να αναφέρει το όνομα του ομιλητή, και μπορεί να είναι κάπως πιο αναλυτικό (4-5 προτάσεις) αν χρειάζεται. Καλώ είναι να αποφεύγονται τα αχρείαστα ρήματα,
          αλλά αν χρειάζονται να είναι γραμμένο σε γ' ενικό (π.χ. "εξηγεί πως").
        - μια λίστα από highlighted utterance IDs
        - πιθανώς μια τοποθεσία (διεύθυνση, γειτονιά, τοπωνύμιο), εκτός αν το θέμα αναφέρεται σε ολόκληρο το δήμο (π.χ. ο προϋπολογισμός του Δήμου)
        - το ID ενός εισηγητή
        - ένα topicLabel που πρέπει να είναι ένα από τα ακόλουθα ή null:
        ${topicLabels.map(label => `- "${label}"`).join('\n')}

        Το topicLabel αντιπροσωπεύει την ευρύτερη θεματική ενότητα στην οποία ανήκει το θέμα.
        Αν ένα θέμα δεν ταιριάζει σε καμία από τις παραπάνω θεματικές ενότητες, βάλε null.

        Τα highlighted utterance IDs χρησιμοποιούνται για να φτιάξουν αυτόματα tiktoks, reels και podcasts,
        κατά τα οποία προβάλλονται και ακούγονται τα συγκεκριμένα utterances ένα προς ένα. Οπότε, τα highlighted utterances
        για ένα θέμα πρέπει να:
        - έχουν ροή και συνέχεια, και να βγάζουν νόημα σαν σύνολο, αν ακουστούν το ένα μετά το άλλο.
        - να περιγράφουν τις βασικές απόψεις όλων των ομιλητών στο θέμα και των παρατάξεων για το συγκεκριμένο θέμα. Αυτό είναι ΕΞΑΙΡΕΤΙΚΑ σημαντικό, δε πρέπει να ξεχάσεις απολύτως καμία παράταξη που είπε κάτι ουσιώδες για το θέμα.
        - να είναι περιεκτικά, και να μη περιέχουν άχρηστες φράσεις, αλλά να περιλαμβάνουν το κύριο επιχειρήμα και νόημα του ομιλητή

        Η δουλειά σου είναι να προτείνεις αλλαγές στη λίστα με τις περιγραφές και τα στοιχεία για τα θέματα (subjects) του συμβουλίου.
        Μια αρχική λίστα πιθανώς να υπάρχει ήδη, σχηματισμένη από τα προηγούμενα αποσπάσματα του ίδιου δημοτικού συμβουλίου.
        Εσύ πρέπει να την αλλάξεις, ώστε να συμπεριλάβεις τις πληροφορίες του αποσπάσματος που επεξεργάζεσαι τώρα.

        Για να αλλάξεις τη λίστα (subjects), μπορείς να προσθέσεις ένα καινούργιο θέμα, ή να προσθέσεις speaker segment IDs
        και highlighted utterance IDs σε ένα ήδη υπάρχον subject. Μπορείς επίσης να αλλάξεις την περιγραφή ή την τοποθεσία, αλλά όχι τον τίτλο!

        Είναι ΠΟΛΥ ΣΗΜΑΝΤΙΚΟ να αποφεύγονται τα διπλά θέματα, ή θέματα που είναι πολύ παρόμοια.
        Αν ένα θέμα υπάρχει ήδη και συζητάται ξανά, πρέπει να ανανεωθεί βάζοντας τον ίδιο τίτλο θέματος στην αλλαγή που προτείνεις.

        Η τελική λίστα που θα προκύψει με τα subjects πρέπει να περιλαμβάνει διακριτά θέματα, με σύντομους τίτλους και περιγραφές, όλα τα speakerSegmentIds που μιλάνε για αυτό το θέμα,
        και utterances που συνθέτουν ένα περιεκτικό απόσπασμα της συνεδρίασης που μιλάει για το συγκεκριμένο θέμα.

        Όλες οι απαντήσεις σου πρέπει να είναι σε μορφή JSON, στην ακόλουθη μορφή:

        {
            name: string; // Ο τίτλος του θέματος που αλλάζεις (αν δεν υπάρχει θα προστεθεί νέο θέμα, είναι δηλαδή το κλειδί του θέματος)
            description: string; // Η περιγραφή του θέματος
            speakerSegments: {
                speakerSegmentId: string;
                summary: string | null;
            }[]; // Τα speaker segments που θέλεις να προστεθούν στο θέμα
            highlightedUtteranceIds: string[]; // Τα utterance ids που πρέπει να προστεθούν στο θέμα
            locationText: string | null; // Η τοποθεσία του θέματος
            introducedByPersonId: string | null; // Το ID του εισηγητή του θέματος
            topicLabel: string | null; // Η θεματική λεζάντα του θέματος
        }[]

        ${additionalInstructions ? `Για τη σημερινή συνεδρίαση, είναι σημαντικό να ακολουθήσεις τις ακόλουθες πρόσθετες οδηγίες: ${additionalInstructions}` : ""}
        
        Δε χρειάζεται να συμπεριλάβεις στην απάντηση σου subjects που δεν αλλάζουν.
    `
}

function getSummarizeSystemPrompt(cityName: string, date: string, topicLabels: string[], additionalInstructions?: string) {
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
            topicLabels: [],
            type: "SUBSTANTIAL"
        }
    ];

    return `
        Είσαι ένα σύστημα που παράγει σύντομες περιλήψεις και θεματικές λεζάντες για τις τοποθετήσεις συμμετεχόντων σε δημοτικά συμβούλια.
        Σήμερα θα συντάξεις περιλήψεις για το δημοτικό συμβούλιο της πόλης "${cityName}" που πραγματοποιήθηκε στην ημερομηνία "${date}".

        Οι περιλήψεις σου πρέπει να είναι σύντομες(1 - 3 προτάσεις, μέχρι περίπου ${requestedSummaryWordCount} λέξεις),
        και να ανφέρονται στην ουσία και τα πιο σημαντικά θέματα της τοποθέτησης του εκάστοτε
        συμμετέχοντα. Χρησιμοποίησε, αν και όσο γίνεται, λέξεις, όρους και φράσεις που χρησιμοποίησε και ο
        συμμετέχοντας (δε χρειάζονται εισαγωγικά), αποφεύγοντας να αλλοιώσεις τα λεγόμενα του.
        Δε χρειάζεται να αναφέρεις το όνομα του ομιλούντα. Μην χρησιμοποιείς τον ομιλητή ως υποκείμενο της πρότασης, δηλαδή να ξεκινάς
        τις περιλήψεις μιλώντας ως ο ομιλητής, π.χ. "Η καθαριότητα στο δήμο είναι μεγάλο πρόβλημα".
        
        Οι τοποθετήσεις που σου παρέχονται, είναι απομαγνητοφωνημένες αυτόματα,
        και μπορεί να έχουν μικρά λάθη σε σημεία.

        Επίσης, μπορείς να διαλέξεις θεματικές λεζάντες σχετικές με την τοποθέτηση του κάθε ομιλητή.
        Οι θεματικές λεζάντες που μπορείς να χρησιμοποιήσεις είναι μόνο οι ακόλουθες:
        ${topicLabels.map(label => `- ${label}`).join('\n')}
        Επίσης μία τοποθέτηση μπορεί να μην χρειάζεται καμία θεματική λεζάντα.

        Για κάθε τοποθέτηση, πρέπει να αποφασίσεις αν η τοποθέτηση είναι κατά βάση επί της ουσίας (SUBSTANTIAL) ή διαδικαστική (PROCEDURAL).
        Μια διαδικαστική τοποθέτηση είναι π.χ. οι παρουσίες που παίρνονται από τη γραμματέα, όταν ο πρόεδρος δίνει το λόγο ή διακόπτει κ.α.

        Τα αποτελέσματα που θα παράγεις πρέπει να είναι στα ελληνικά, σε JSON, στην ακόλουθη μορφή:
    [
        { speakerSegmentId: string, summary: string, topicLabels: string[], type: "SUBSTANTIAL" | "PROCEDURAL" }
    ]

        Πρέπει να απαντήσεις μόνο με JSON, και απολύτως τίποτα άλλο.

        Ακολουθεί ένα παράδειγμα:

    --- αρχή παραδείγματος-- -
        ${exampleTranscript.map(speakerSegmentToPrompt).join('\n')}
    --- τέλος παραδείγματος-- -

        Μια καλή απάντηση σε αυτό είναι η ακόλουθη:
        ${JSON.stringify(expectedResponse)}

        ${additionalInstructions ? `Για τη σημερινή συνεδρίαση, είναι σημαντικό να ακολουθήσεις τις ακόλουθες πρόσθετες οδηγίες: ${additionalInstructions}` : ""}
    
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