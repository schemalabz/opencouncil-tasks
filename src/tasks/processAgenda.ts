import { aiChat } from "../lib/ai.js";
import { geocodeLocation } from "../lib/geocode.js";
import { enhanceSubjectWithContext } from "../lib/sonar.js";
import { ProcessAgendaRequest, ProcessAgendaResult, Subject } from "../types.js";
import { Task } from "./pipeline.js";

export const processAgenda: Task<ProcessAgendaRequest, ProcessAgendaResult> = async (request, onProgress) => {
    console.log("Processing agenda request:", request);

    if (!request.agendaUrl) {
        throw new Error("Agenda is required");
    }

    if (!request.agendaUrl.endsWith(".pdf")) {
        throw new Error("Agenda must be a PDF file");
    }

    const base64 = await downloadFileToBase64(request.agendaUrl);

    // Use extractedSubjectSchema with output: 'array' instead of prefill tricks
    const { extractedSubjectSchema } = await import("../lib/aiClient.js");
    const result = await aiChat<Omit<ExtractedSubject, "speakerSegments" | "highlightedUtteranceIds">[]>({
        systemPrompt: getSystemPrompt(),
        userPrompt: getUserPrompt(base64, request.cityName, request.date, request.people, request.topicLabels),
        documentBase64: base64,
        schema: extractedSubjectSchema,
        output: 'array'
    });

    const subjects = await Promise.all(
        result.result.map(s => extractedSubjectToApiSubject({ ...s, highlightedUtteranceIds: [], speakerSegments: [] },
            request.cityName))
    );

    console.log(`Extracted ${subjects.length} subjects`);
    const enhancedSubjects = await Promise.all(subjects.map(s => enhanceSubjectWithContext({ subject: s, cityName: request.cityName, date: request.date })));

    return { subjects: enhancedSubjects };
};

const downloadFileToBase64 = async (url: string) => {
    console.log(`Downloading file from ${url}...`);
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    console.log(`Downloaded file to base64: ${base64.length} bytes`);
    return base64;
}

export const extractedSubjectToApiSubject = async (subject: ExtractedSubject, cityName: string): Promise<Subject> => {
    const locationLatLng = subject.locationText ? await geocodeLocation(subject.locationText + ", " + cityName) : null;

    const location = subject.locationText && locationLatLng ? {
        text: subject.locationText,
        type: "point" as const,
        coordinates: [[locationLatLng.lat, locationLatLng.lng]]
    } : null;


    return {
        name: subject.name,
        description: subject.description,
        agendaItemIndex: subject.agendaItemIndex,
        speakerSegments: subject.speakerSegments.map(seg => ({
            speakerSegmentId: seg.speakerSegmentId,
            summary: seg.summary
        })),
        highlightedUtteranceIds: subject.highlightedUtteranceIds,
        context: null,
        location,
        topicLabel: subject.topicLabel,
        introducedByPersonId: subject.introducedByPersonId
    }
}

export type ExtractedSubject = {
    name: string;
    description: string;
    agendaItemIndex: number | "BEFORE_AGENDA" | "OUT_OF_AGENDA";
    introducedByPersonId: string | null;
    speakerSegments: {
        speakerSegmentId: string;
        summary: string | null;
    }[];
    highlightedUtteranceIds: string[];
    locationText: string | null;
    topicLabel: string | null;
}

export const getSystemPrompt = () => {
    return `Είσαι ένα σύστημα που εξάγει θέματα από τις ημερήσιες διατάξεις δημοτικών συμβουλίων διαφόρων πόλεων στην Ελλάδα. Οι απαντήσεις σου πρέπει να είναι μόνο JSON, και συγκεκριμένα ένας πίνακας (array) με objects με το ακόλουθο structure:

{
    name: string; // Ένας σύντομος τίτλος για το θέμα (2-6 λέξεις)
    description: string;  // 2-5 προτάσεις με μια σύντομη, απλή και περιεκτική περιγραφή του θέματος
    agendaItemIndex: number | null; // Ο αριθμός που συνοδεύει το θέμα στο έγγραφο της ημερήσιας διάταξης, αν υπάρχει
    locationText:  string | null; // Αν το θέμα αναφέρεται σε κάποια συγκεκριμένη τοποθεσία (π.χ. διεύθυνση, δρόμος, γειτονιά, ή συγκεκριμένη επιχείρηση / δημόσια δομή), η διεύθυνση του θέματος. Αν το θέμα δεν έχει τοποθεσία, ή αφορά ολόκληρο το δήμο (π.χ. ο προϋπολογισμός του Δήμου), τότε null 
    introducedByPersonId: string | null; // Το id του εισηγητή του θέματος, αν αναφέρετε σαφώς στη διάταξη 
    topicLabel: string | null; // Το label θέματος που ταιριάζει καλύτερα στο θέμα
};

Είναι πολύ σημαντικό να εξάγεις ΟΛΑ τα θέματα που υπάρχουν στην ημερήσια διάταξη, χωρίς να παραλήψεις απολύτως κανένα, και να βάλεις τους σωστούς αριθμούς.`;
}

export const getUserPrompt = (agendaPdfBase64: string, cityName: string, date: string, people: { id: string; name: string; role: string; party: string; }[], topicLabels: string[]) => {
    return `Πρέπει να εξάγεις θέματα από την ημερήσια διάταξη της πόλης ${cityName} για τη συνεδρίαση που θα γίνει στις ${date}. Όλα τα θέματα αφορούν τη πόλη.

    Τα άτομα που συμμετέχουν στη συνεδρίαση, και μπορεί να είναι εισηγητές θεμάτων, είναι τα εξής:
    ${JSON.stringify(people, null, 2)}

    Τα topic labels που μπορεί να έχουν τα θέματα είναι: ${topicLabels.join(", ")}

    Παρακαλώ να εξάγεις ΟΛΑ τα θέματα από αυτό το έγγραφο.`;
}
