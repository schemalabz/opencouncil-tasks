import { aiChat, ResultWithUsage } from "../lib/ai.js";
import { ExtractHighlightsRequest, ExtractHighlightsResult } from "../types.js";
import { Task } from "./pipeline.js";
import fs from 'fs/promises';
function shortenUtteraceIds(transcript: ExtractHighlightsRequest['transcript']): {
    shortIdToOrignalId: Record<string, string>;
    longIdToShortId: Record<string, string>;
} {
    const shortIdToOrignalId: Record<string, string> = {};
    const longIdToShortId: Record<string, string> = {};

    transcript.forEach(({ speakerSegmentId, utterances }) => {
        utterances.forEach(({ utteranceId }, index) => {
            const shortId = Array(5).fill(0).map(() => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
            shortIdToOrignalId[shortId] = utteranceId;
            longIdToShortId[utteranceId] = shortId;
        });
    });

    return {
        shortIdToOrignalId,
        longIdToShortId
    };
}

export const extractHighlights: Task<ExtractHighlightsRequest, ExtractHighlightsResult> = async (request, onProgress) => {
    const { names, transcript, topicLabels, cityName, date } = request;

    console.log(`Received a transcript with:`);
    console.log(`- ${transcript.reduce((acc, curr) => acc + curr.utterances.length, 0)} utterances`);
    console.log(`- ${names.length} names to create highlights for`);
    console.log(`- ${topicLabels.length} topic labels`);

    const { shortIdToOrignalId, longIdToShortId } = shortenUtteraceIds(transcript);
    const totalWords = transcript.reduce((acc, curr) => acc + curr.utterances.reduce((sum, u) => sum + u.text.split(/\s+/).length, 0), 0);
    console.log(`Total words in transcript: ${totalWords}`);
    const subTranscripts: ExtractHighlightsRequest['transcript'][] = [];
    const totalSegments = transcript.length;

    // First subtranscript: 0% to 40%
    const firstEnd = Math.floor(totalSegments * 0.4);
    subTranscripts.push(transcript.slice(0, firstEnd));

    // Second subtranscript: 30% to 70%
    const secondStart = Math.floor(totalSegments * 0.3);
    const secondEnd = Math.floor(totalSegments * 0.7);
    subTranscripts.push(transcript.slice(secondStart, secondEnd));

    // Third subtranscript: 60% to 100%
    const thirdStart = Math.floor(totalSegments * 0.6);
    subTranscripts.push(transcript.slice(thirdStart));

    console.log(`Created ${subTranscripts.length} sub-transcripts`);
    subTranscripts.forEach((subTranscript, index) => {
        const wordCount = subTranscript.reduce((acc, segment) =>
            acc + segment.utterances.reduce((sum, u) => sum + u.text.split(/\s+/).length, 0), 0);
        console.log(`Sub-transcript ${index + 1} word count: ${wordCount}`);
    });


    console.log(`Created ${subTranscripts.length} sub-transcripts`);

    const systemPrompt = getSystemPrompt({ cityName, date, names, topicLabels, transcript, count: 10 });

    let allHighlights: ExtractHighlightsResult['highlights'] = [];

    for (let i = 0; i < subTranscripts.length; i++) {
        console.log(`Processing sub-transcript ${i + 1} of ${subTranscripts.length}`);

        const shortenedSubTranscript = subTranscripts[i].map(({ speakerName, speakerParty, speakerSegmentId, utterances }) => ({
            speakerName,
            speakerParty,
            speakerSegmentId,
            utterances: utterances.map(({ utteranceId, text }) => ({
                utteranceId: longIdToShortId[utteranceId],
                text
            }))
        }));

        const userPrompt = getUserPrompt(shortenedSubTranscript, { skipSmallUtterances: true });
        // Write user prompt to file for debugging
        const promptFilePath = `./prompt-${i + 1}.txt`;
        await fs.writeFile(promptFilePath, userPrompt, 'utf8');
        console.log(`User prompt for sub-transcript ${i + 1} written to ${promptFilePath}`);
        console.log(`Sub-transcript ${i + 1} user prompt length: ${userPrompt.length}`);

        const highlights = await aiExtractHighlights(systemPrompt, userPrompt, (stage, progress) => {
            onProgress(stage, (i + progress) / subTranscripts.length);
        });


        allHighlights = [...allHighlights, ...highlights.result];
    }


    console.log(`Starting combining ${allHighlights.length} highlights into fewer highlights`);
    const combinedHighlights = (await aiCombineHighlights(allHighlights.map((h) => {
        return {
            name: h.name,
            utterances: h.utteranceIds.map((id) => ({
                utteranceId: id,
                text: transcript.flatMap(segment => segment.utterances).find(u => longIdToShortId[u.utteranceId] === id)?.text || '',
                personName: transcript.find(segment => segment.utterances.some(u => longIdToShortId[u.utteranceId] === id))?.speakerName || '',
                partyName: transcript.find(segment => segment.utterances.some(u => longIdToShortId[u.utteranceId] === id))?.speakerParty || ''
            }))
        }
    }))).result;


    const finalHighlights = combinedHighlights.map(({ name, utteranceIds }) => ({
        name,
        utteranceIds: utteranceIds.map((id) => shortIdToOrignalId[id])
    }));

    console.log(`Combined highlights: ${finalHighlights.length}`);
    console.log(`Combined highlights: ${JSON.stringify(finalHighlights)}`);

    return {
        highlights: finalHighlights
    };
}

let sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function combineSystemPrompt() {
    return `
        Είσαι ένα σύστημα που συνδιάζει διάφορα highlights από το ίδιο δημοτικό συμβούλιο, σε λιγότερα highlights όπου κάθε highlight
        έχει ένα μόνο θέμα. Κάθε συνδιαστικό highlight πρέπει να περιέχει 10-30 utterances, και να εκφράζει τις απόψεις όλων των ομιλητών
        που εξέφρασαν άποψη στο θέμα στα αρχικά highlights. Μπορείς να περιορίσεις τα λόγια κάποιου ομιλητή, κόβωντας κάπια
        από τα utterances του που δεν ήταν τόσο σημαντικά, ώστε να συμπεριλάβεις utterances ενός άλλου ομιλητή
        πάνω σε ένα θέμα.

        Είναι πολύ σημαντικό σε κάθε highlight να υπάρχει πολυφωνία και να ακούγονται όλες οι απόψεις.
        Είναι σημαντικό να μην χάσεις τον αντίλογο κάποιου ομιλητή. Δηλαδή, το ίδιο highlight πρέπει να περιέχει όλες τις απόψεις των ομιλητών πάνω στο θέμα.
        Κανένα highlight δε πρέπει να έχει μόνο έναν ομιλητή!
        Επίσης τα highlights πρέπει να έχουν συνοχή, αν κάποιος τα ακούσει, και να επικεντρώνονται στα σημαντικότερα
        σημεία της συζήτησης.

        Ένα εξαιρετικό highlight πρέπει να είναι σαν ένα μικρό debate. Όλα, ΑΠΟΛΥΤΩΣ όλα τα highlights που βγάζεις, πρέπει να περιέχουν
        utterances από τουλάχιστον 2 παρατάξεις (speakerParties).

        Πρέπει να παράγεις το πολύ 3 highlights συνολικά! Το κάθε highlight πρέπει να έχει διαφορετικό θέμα. Μπορείς να παραλήψεις κάποια θέματα,
        αν υπάρχουν πιο σημαντικά θέματα. Προσπάθησε να επιλέξεις θέματα που έχουν έντονο διάλογο, διαφωνίες και διαφορετικές απόψεις.
        Μπορείς να συνδιάσεις πολλά highlights από το input σου σε ένα highlight του output σου, αρκεί να διατηρείται συνοχή και να έχουν το ίδιο
        ή παρόμοιο θέμα.

        Θα δώσεις σε μια απάντηση σε JSON μορφή, με το πολύ 3 highlights, με το ακόλουθο σχήμα:
        [
            {
                "name": string,
                "utteranceIds": string[]
            }
        ]
    `;
}

function combineUserPrompt(highlights: { name: string; utterances: { utteranceId: string; text: string; personName: string }[] }[]) {
    return JSON.stringify(highlights);
}


async function aiCombineHighlights(highlights: { name: string; utterances: { utteranceId: string; text: string; personName: string }[] }[]) {
    const response: ResultWithUsage<ExtractHighlightsResult['highlights']> = await aiChat(combineSystemPrompt(), combineUserPrompt(highlights), "H απάντηση σε JSON: \n[", "[");
    return response;
}


const exampleTranscript: ExtractHighlightsRequest['transcript'] = [{
    speakerName: "Βασίλης Αναγνώστου",
    speakerParty: "Αναγέννηση τώρα",
    speakerSegmentId: "abcdefg12345678dfdasd90",
    utterances: [{
        text: "Η καθημερινότητα στην Αθήνα είναι δύσκολη.",
        utteranceId: "abcdefg1234567890"
    },
    {
        text: "Συγγνώμη, ακούγομαι καλά;",
        utteranceId: "abcdefg1234567891"
    },
    {
        text: "Συνεχίζω, με συγχωρείτε.",
        utteranceId: "abcdefg1234567892"
    },
    {
        text: "Η πολιτική του αυτόματου πιλότου φτάνει στα όριά της.",
        utteranceId: "abcdefg1234567893"
    }
    ],
},
{
    speakerName: "Χρήστος Χρήστου",
    speakerParty: "Καλύτερη Πόλη",
    speakerSegmentId: "abcdefb1234567891",
    utterances: [{
        text: "Δύσκολη ήταν η καθημερινότητα, όχι μόνο τώρα",
        utteranceId: "abcdebg1234567890"
    },
    {
        text: "Αλλά και στη δικιά σας θητεία ήταν δύσκολη, ακόμα πιο δύσκολη.",
        utteranceId: "abcdebg1234567891"
    },
    {
        text: "Πάμε σε ένα άλλο βασικό θέμα τωρα.",
        utteranceId: "abcdebg1234567892"
    },
    {
        text: "Η αθήνα δεν έχει πράσινους χόρους.",
        utteranceId: "abadefg1234567893"
    },
    {
        text: "Δε πάει άλλο αυτή η κατάσταση.",
        utteranceId: "abadefg1234567893"
    }
    ]
}
];

const expectedHighlights: ExtractHighlightsResult['highlights'] = [
    {
        name: "Καθημερινότητα",
        utteranceIds: ["abcdefg1234567890", "abcdefg1234567893", "abadefg1234567893", "abcdebg1234567891"]
    }
];

async function aiExtractHighlights(systemPrompt: string, userPrompt: string, onProgress: (stage: string, progress: number) => void): Promise<ResultWithUsage<ExtractHighlightsResult['highlights']>> {
    onProgress("extracting-highlights", 0);

    console.log(`Asking claude...`);
    const response = await aiChat<ExtractHighlightsResult['highlights']>(systemPrompt, userPrompt,
        "H απάντηση σε JSON: \n[", "["
    );

    onProgress("extracting-highlights", 1);

    return response;
}

function transcriptToPrompt(transcript: ExtractHighlightsRequest['transcript']) {
    if (transcript.some(({ speakerName }) => !speakerName || speakerName === "")) {
        throw new Error("Speaker name is null");
    }
    return transcript.map(({ speakerName, speakerParty, utterances }) => `
        <PERSON:${speakerName} (παράταξη ${speakerParty})>
        ${utterances.map((utterance) => `<U:${utterance.utteranceId}>${utterance.text}</U>`).join("\n")}
        </PERSON>
    `).join("\n");
}


function getSystemPrompt(
    { cityName, date, names, count, topicLabels, transcript }:
        { cityName: string, date: string, names: string[], count: number, topicLabels: string[], transcript: ExtractHighlightsRequest['transcript'] }) {
    let allNames = names.slice(0, count);
    while (allNames.length < count) {
        allNames.push("<ένα θέμα της δικής σου επιλογής>")
    }


    return `
        Είσαι ένα σύστημα που εξάγει highlights από την αυτοματοποιημένες απομαγνητοφώνησεις δημοτικών συμβουλίων.
        Σήμερα, θα εξάγεις highlights για το Δημοτικό Συμοβούλιο της πόλης "${cityName}", που πραγματοποιήθηκε στις "${date}".

        Μια απομαγνητοφώνηση έχει ομιλητές που λένε διάφορα utterances. Κάθε highlight περιέχει μια σειρά από ολόκληρα utterances.
        Ένα καλό highlight πρέπει να αφορά ένα συγκεκριμένο θέμα, να περιέχει 10-30 utterances από τουλάχιστον δύο ομιλητές και
        να δείχνει τις διαφορετικές απόψεις των ομιλητών για το ίδιο θέμα. Πρέπει να επιλέγονται τα πιο σηματνικά utterances, που όμως
        να έχουν μια συνοχή. Τα utterances θα παρουσιαστούν στο χρήστη σαν ένα instagram/tiktok reel, το ένα ακριβώς μετά το άλλο.
        Διάλεξε όσο γίνεται utterances που είναι ξεκάθαρα και έχουν κάποιο αντίκτυπο, χωρίς να ξεχάσεις τον αντίλογο κάποιο άλλου ομιλητή.
        Σε καμία περίπτωση δε πρέπει η επιλογή των utterances να αλλάζει σημαντικά το νόημα αυτών που ειπώθηκαν με παραπλανητικό τρόπο.

        Είναι ιδιαίτερα σημαντικά τα ακόλουθα:
        * η συνοπτικότητα (το να συμπεριλαμβάνονται μόνο όσα utterances είναι σημαντικά)
        * η συνοχή (τα utterances ενός highlight πρέπει να βγάζουν νόημα, όταν διαβάζονται το ένα μετά το άλλο και να είναι σαν μια περίληψη των απόψεων επί ενός θέματος)
        * η πολυφωνία (το να ακούγονται απόψεις πολλών ανθρώπων και παρατάξεων στο ίδιο highlight)

        Δε μπορείς να αλλάξεις utterances, ούτε να τα κόψεις στη μέση. Μπορείς μόνο να διαλέξεις κάποια από τα υπάρχοντα.

        Θέλω να φτιάξεις 10 highlights, με 10 εώς 30 περίπου utterances ανά highlight ${names.length === 0 ? " για όποια θέματα κρίνεις εσύ σημαντικά" : ", με ένα ακριβώς highlight για το καθένα από τα ακόλουθα θέματα:"}
        ${names.join(', ')}

        Θα λάβεις μια σειρά από απομαγνητοφωνήσεις ομιλητών χωρισμένες σε uttrances. Ένα utterance μοιάζει έτσι: <U:ID>TEXT UTTERED</U>
        Οι παράταξη και το όνομα του ομιλητή είναι: <PERSON:NAME (παράταξη PARTY)>UTTERANCES</PERSON>. Το ΙD του utterance
        είναι πολύ βασικο -- το χρειάζεσαι για να επιλέξεις ένα utterance για ένα highlight.

        Η απάντηση σου πρέπει να είναι σε JSON μορφή, με το ακόλουθο σχήμα:
        [
            {
                "name": string,
                "utteranceIds": string[]
            }
        ]

        Κάθε αντικείμενο αντιπροσωπεύει ένα highlight, το οποίο περιέχει utterance IDs από πολλούς ομιλητές. Το "utteranceIds" πίνακας πρέπει να περιέχει τα ID των utterances που σχηματίζουν το highlight.
        Μπορείς να περιλάβεις πολλά highlights για κάθε άτομο αν είναι κατάλληλο.

        --- ΑΡΧΗ ΠΑΡΑΔΕΙΓΜΑΤΟΣ ---

        ${transcriptToPrompt(exampleTranscript)}

        --- ΤΕΛΟΣ ΠΑΡΑΔΕΙΓΜΑΤΟΣ ---

        μια καλή απάντηση για το παραπάνω, θα ήταν:

        ${JSON.stringify(expectedHighlights)}

        Στο παράδειγμα επιλέγουμε μερικά utterances, που αν διαβαστούν το ένα μετά το άλλο δίνουν μια συνοπτική αλλά ολοκληρωμένη εικόνα της συζήτησης.


        Απάντησε μόνο με το JSON, χωρίς απολύτως τίποτα άλλο εκτός από το JSON. 
        `;
}

function getUserPrompt(transcript: ExtractHighlightsRequest['transcript'], { skipSmallUtterances }: { skipSmallUtterances: boolean } = { skipSmallUtterances: false }) {
    const filteredTranscript = skipSmallUtterances ? transcript.filter(({ utterances }) => utterances.length > 10) : transcript;
    return `
        ${transcriptToPrompt(filteredTranscript)}
    `;
}
