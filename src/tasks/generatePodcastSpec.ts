import { Task } from "./pipeline.js";
import { GeneratePodcastSpecRequest, GeneratePodcastSpecResult, PodcastPart } from "../types.js";
import { aiChat } from "../lib/ai.js";

type InternalPodcastSpec = {
    parts: ({
        type: "host";
        text: string;
    } | {
        type: "audio";
        utteranceIds: string[];
    })[]
};

const dataDir = process.env.DATA_DIR || "./data";

type SubjectsForPrompt = {
    name: string; // Το όνομα του θέματος
    description: string; // Μια περιγραφή
    speakerSegments: {
        speakerName: string | null; // Το όνομα του ομιλιτή
        speakerParty: string | null; // Η παράταξη του ομιλιτή
        speakerRole: string | null; // Η θέση του ομιλητή (π.χ. αντιδήμαρχος), αν υπάρχει
        utterances: {
            text: string; // Το κείμενο της φράσης που ειπώθηκε από τον ομιλητή
            utteranceId: string; // το αναγνωριστικό της φράσης που ειπώθηκε, που μπορούμε να χρησιμοποιήσουμε για να τη συμπεριλάβουμε στο ηχητικό απόσπασμα
        }[]
    }[]
    allocation: 'onlyMention' | 'full' | 'skip'; // full = αναφερόμαστε σε αυτό το θέμα στο κύριο κομμάτι, onlyMention = αναφέρομαστε στο θέμα μόνο στην ενότητα 4, πριν κλείσουμε.
    allocatedMinutes: number; // O χρόνος που πρέπει να αφιερώσουμε στο θέμα κατά προσέγγιση.
}[];

const getSubjectsForPrompt = (subjects: GeneratePodcastSpecRequest['subjects'], transcript: GeneratePodcastSpecRequest['transcript']): SubjectsForPrompt => {
    const subjectsToInclude = subjects.filter((s) => s.allocation != 'skip');

    return subjectsToInclude.map(subject => {
        const utterancesGroupedBySpeakerSegment: {
            speakerName: string | null; // Το όνομα του ομιλιτή
            speakerParty: string | null; // Η παράταξη του ομιλιτή
            speakerRole: string | null; // Η θέση του ομιλητή (π.χ. αντιδήμαρχος), αν υπάρχει
            utterances: {
                text: string; // Το κείμενο της φράσης που ειπώθηκε από τον ομιλητή
                utteranceId: string; // το αναγνωριστικό της φράσης που ειπώθηκε, που μπορούμε να χρησιμοποιήσουμε για να τη συμπεριλάβουμε στο ηχητικό απόσπασμα
            }[]
        }[] = [];

        subject.highlightedUtteranceIds.forEach(utteranceId => {


            const speakerSegment = transcript.find((s) => s.utterances.some((u) => u.utteranceId === utteranceId));

            if (!speakerSegment) {
                throw new Error(`Speaker segment for utterance ${utteranceId} not found!`);
            }

            const utterance = speakerSegment.utterances.find((u) => u.utteranceId === utteranceId);
            if (!utterance) {
                throw new Error(`Utterance ${utteranceId} not found!`);
            }

            const lastUtterance = utterancesGroupedBySpeakerSegment[utterancesGroupedBySpeakerSegment.length - 1];
            if (lastUtterance && lastUtterance.speakerName === speakerSegment.speakerName) {
                lastUtterance.utterances.push({
                    text: utterance.text,
                    utteranceId: utterance.utteranceId
                });
            } else {
                utterancesGroupedBySpeakerSegment.push({
                    speakerName: speakerSegment.speakerName,
                    speakerParty: speakerSegment.speakerParty,
                    speakerRole: speakerSegment.speakerRole,
                    utterances: [{
                        text: utterance.text,
                        utteranceId: utterance.utteranceId
                    }]
                });
            }
        });

        return {
            name: subject.name,
            description: subject.description,
            speakerSegments: utterancesGroupedBySpeakerSegment.map((s) => ({
                speakerName: s.speakerName,
                speakerParty: s.speakerParty,
                speakerRole: s.speakerRole,
                utterances: s.utterances.map((u) => ({
                    text: u.text,
                    utteranceId: u.utteranceId
                }))
            })),
            allocation: subject.allocation,
            allocatedMinutes: subject.allocatedMinutes
        }
    });
};

export const generatePodcastSpec: Task<GeneratePodcastSpecRequest, GeneratePodcastSpecResult> = async (request, onProgress) => {
    const { transcript, subjects, additionalInstructions } = request;

    const systemPrompt = getSystemPrompt(subjects, additionalInstructions);
    const subjectsToInclude = subjects.filter((s) => s.allocation != 'skip');
    const subjectsForPrompt = getSubjectsForPrompt(subjectsToInclude, transcript);


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

    subjectsForPrompt.forEach(s => {
        addLongIdToMaps(s.name);
        s.speakerSegments.forEach(ss => {
            ss.utterances.forEach(u => {
                addLongIdToMaps(u.utteranceId);
            });
        });
    });

    const shortIdSubjectsForPrompt = subjectsForPrompt.map(s => ({
        ...s,
        speakerSegments: s.speakerSegments.map(ss => ({
            ...ss,
            utterances: ss.utterances.map(u => ({
                ...u,
                utteranceId: longIdToShort.get(u.utteranceId)!
            }))
        }))
    }));

    console.log(JSON.stringify(shortIdSubjectsForPrompt, null, 2));

    console.log(`Getting podcast spec...`);
    const result = await aiChat<InternalPodcastSpec>(systemPrompt, JSON.stringify(shortIdSubjectsForPrompt), "To podcast spec σε JSON:\n{", "{");
    console.log(`Got podcast spec with ${result.usage.input_tokens} input tokens and ${result.usage.output_tokens} output tokens!`);

    const internalPodcastSpecWithShortIds = result.result;
    const internalPodcastSpecParts: PodcastPart[] = internalPodcastSpecWithShortIds.parts.map((p) => {
        if (p.type === "audio") {
            return {
                type: "audio",
                utteranceIds: p.utteranceIds.map(id => shortIdToLong.get(id)!)
            }
        }
        return p;
    });

    console.log(JSON.stringify(internalPodcastSpecParts, null, 2));

    return {
        parts: internalPodcastSpecParts
    };
};

export const getSystemPrompt = (subjects: GeneratePodcastSpecRequest['subjects'], additionalInstructions?: string) => {
    return `
    Είσαι ένα σύστημα που φτιάχνει περιγραφές (specs) για podcasts που αποτελούν
    συνόψεις δημοτικών συμβουλίων. Τα podcasts δημοσιεύονται από τον οργανισμό
    OpenCouncil.

    Τα podcast αποτελούνται από ενότητες. Κάθε ενότητα είναι είτε ενότητα παρουσιαστή ("host")
    είτε ένα ηχητικό απόσπασμα (audio) από την ίδια την συνεδρίαση του δημοτικού συμβουλίου.
    Ένα ηχητικό απόσπασμα μπορεί να περιέχει αποσπάσματα από την ομιλία μόνο ενός ομιλητή,
    αλλά φυσικά μπορούμε να έχουμε πολλά αποσπάσματα από πολλούς ομιλητές.

    H δομή του podcast είναι η εξής:

    1. Το podcast ξεκινάει με μια εισαγωγή, που είναι της εξής μορφής:
    
    "Ακούτε το podcast του ΟpenCouncil για το δήμο Χ. Αυτό το podcast δημιουργήθηκε
    αυτόματα από το ΟpenCouncil.gr, και συνοψίζει με αντικειμενικό τρόπο τα θέματα
    που συζητούνται στο δήμο Χ. Μπορείτε να μάθετε περισσότερα στο opencouncil.gr.

    Στο σημερινό επισόδειο θα μιλήσουμε για τα θέματα του δημοτικού συμβουλίου της
    23ης Σεπτεμβρίου 2023, και θα ακούσουμε αποσπάσματα από τη συνεδρίαση."

    2. Στη συνέχεια, περιγράφονται τα κύρια περιεχόμενα του σημερινού podcast, π.χ.
    "Στη σημερινή συνεδρίαση, συζητήθηκε το Χ, Υ και Ζ."
    
    3. Το κύριο μέρος του podcast μιλάει για τα θέματα που αναφέρθηκαν στα περιεχόμενα, το ένα μετά το άλλο. Κάθε θέμα πρέπει να περιλαμβάνει
       και ηχητικά αποσπάσματα από τους ομιλητές που μίλησαν για το θέμα αυτό.
    3α. Στην αρχή κάθε θέματος, εξηγούμε πως ξεκινάμε με το πρώτο θέμα ή πως συνεχίζουμε με το επόμενο,
        και δίνουμε μια περιγραφή του θέματος.
    3β. Στη συνέχεια του κάθε θέματος, για κάθε ομιλητή που μίλησε επί του θέματος, τον προλογίζουμε και λέμε λίγα λόγια αυτά που
        είπε, πριν παραθέσουμε το ηχητικό απόσπασμα από την ίδια την ομιλία του. Μπορούμε να παραλήψουμε utterances που δεν είναι ουσιώδη και
        δεν αφορούν το θέμα. Όμως είναι εξαιρετικά σημαντικό τα utterances που περιέχονται σε κάθε speakerSegment να έχουν συνοχή
        και να βγάζουν νόημα όταν διαβαστούν το ένα μετά το άλλο.

    4. Έπειτα, κλείνουμε ονομάζοντας τα υπόλοιπα θέματα στα οποία δε προλάβαμε να αναφερθούμε,
       λέγοντας πως ο ακροατής μπορεί να μάθε περισσότερα για αυτά στο opencouncil.gr.
       Ευχαριστούμε και ζητάμε να μας ακολουθήσουν και να πατήσουν like.

    Τα θέματα σου δίνονται σε JSON, υπό το ακόλουθο σχήμα:
    subjects: {
        name: string; // Το όνομα του θέματος
        description: string; // Μια περιγραφή
        speakerSegments: {
            speakerName: string; // Το όνομα του ομιλιτή
            speakerParty: string; // Η παράταξη του ομιλιτή
            speakerRole: string?; // Η θέση του ομιλητή (π.χ. αντιδήμαρχος), αν υπάρχει
            utterances: { // Όλα τα utterances πρέπει να ανήκουν στον ίδιο ομιλητή
                text: string; // Το κείμενο της φράσης που ειπώθηκε από τον ομιλητή
                utteranceId: string; // το αναγνωριστικό της φράσης που ειπώθηκε, που μπορούμε να χρησιμοποιήσουμε για να τη συμπεριλάβουμε στο ηχητικό απόσπασμα
            }
        }[]
        allocation: 'onlyMention' | 'full'; // full = αναφερόμαστε σε αυτό το θέμα στο κύριο κομμάτι, onlyMention = αναφέρομαστε στο θέμα μόνο στην ενότητα 4, πριν κλείσουμε.
    }[];


    Η περιγραφή ενός podcast που θα παράγεις, πρέπει να είναι πάλι σε JSON, με το ακόλουθο σχήμα:
    parts:  ({
        type: "host";
        text: string;
    } | {
        type: "audio";
        speakerId: string; // Το id του ομιλητή στο δήμο
        utteranceIds: string[]; // Τα ids τών utterances (φράσεις) που πρέπει να περιλαμβάνονται στο ηχητικό απόσπασμα
    })[];

    Είναι σημαντικό να μην ξεχάσεις να συμπεριλάβεις ένα ή περισσότερα audio parts για κάθε ένα από τα βασικά ('full')
    θέματα του podcast! Δεν πρέπει να υπάρχει full θέμα χωρίς ηχητικό.
    Φρόντισε το podcast να είναι ενδιαφέρον, και να εστιάζει σε σημεία διαφωνίας μεταξύ των ομιλητών, αν υπάρχουν.

    Το πιο σημαντικό ζήτημα είναι να υπάρχει πολυφωνία και να εκφράζονται οι απόψεις όλων των παρατάξεων που μίλησαν για ένα θέμα.
    Θυμίσου πως τα utterances που επιλέγονται από κάθε speaker segment πρέπει να βγάζουν νόημα,
    όταν διαβαστούν το ένα μετά το άλλο, αφού θα αποτελέσουν ένα ηχητικό απόσπασμα που θα ακούσει ο ακροατής.
    
    ${additionalInstructions ? `Για το σημερινό podcast, πρέπει να ακολουθήσεις τις ακόλουθες πρόσθετες οδηγίες: ${additionalInstructions}` : ""}

    Απάντησε μόνο με το JSON που ζητείται, και απολύτως τίποτα άλλο.
    `;
};

