import { aiChat, addUsage, NO_USAGE } from "../lib/ai.js";
import { enrichSubjectData, type EnrichmentInput } from "../lib/subjectEnrichment.js";
import { IMPORTANCE_GUIDELINES } from "../lib/importanceGuidelines.js";
import { ProcessAgendaRequest, ProcessAgendaResult, Subject } from "../types.js";
import { Task } from "./pipeline.js";
import { generateSubjectUUID } from "../utils.js";
import { logUsage } from "../lib/usageLogging.js";

export const processAgenda: Task<ProcessAgendaRequest, ProcessAgendaResult> = async (request, onProgress) => {
    console.log("Processing agenda request:", request);

    if (!request.agendaUrl) {
        throw new Error("Agenda is required");
    }

    if (!request.agendaUrl.endsWith(".pdf")) {
        throw new Error("Agenda must be a PDF file");
    }

    const base64 = await downloadFileToBase64(request.agendaUrl);

    const result = await aiChat<Omit<ExtractedSubject, "speakerContributions">[]>({
        systemPrompt: getSystemPrompt(),
        userPrompt: getUserPrompt(base64, request.cityName, request.date, request.people, request.topicLabels),
        prefillSystemResponse: "Η απάντηση σου σε JSON: [",
        prependToResponse: "[",
        documentBase64: base64
    });

    // Track usage from enrichment
    let enrichmentUsage = NO_USAGE;
    const enrichmentResults = await Promise.all(
        result.result.map(s => extractedSubjectToApiSubject(
            { ...s, speakerContributions: [] },
            request.cityName,
            request.date
        ))
    );

    // Extract subjects and accumulate usage
    const subjects = enrichmentResults.map(r => {
        enrichmentUsage = addUsage(enrichmentUsage, r.usage);
        return r.result;
    });

    console.log(`Extracted ${subjects.length} subjects`);
    logUsage('Extraction usage', result.usage);
    logUsage('Enrichment usage', enrichmentUsage);

    return { subjects };
};

const downloadFileToBase64 = async (url: string) => {
    console.log(`Downloading file from ${url}...`);
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    console.log(`Downloaded file to base64: ${base64.length} bytes`);
    return base64;
}

export const extractedSubjectToApiSubject = async (
    subject: ExtractedSubject,
    cityName: string,
    date: string
) => {
    const id = generateSubjectUUID(subject, 36);

    const input: EnrichmentInput = {
        name: subject.name,
        description: subject.description,
        locationText: subject.locationText,
        topicImportance: subject.topicImportance,
        proximityImportance: subject.proximityImportance,
        topicLabel: subject.topicLabel,
        agendaItemIndex: subject.agendaItemIndex,
        introducedByPersonId: subject.introducedByPersonId,
        speakerContributions: subject.speakerContributions
    };

    return enrichSubjectData(input, id, {
        cityName,
        date
    });
}

export type ExtractedSubject = {
    name: string;
    description: string;
    agendaItemIndex: number | "BEFORE_AGENDA" | "OUT_OF_AGENDA";
    introducedByPersonId: string | null;
    speakerContributions: {
        speakerId: string;
        text: string;
    }[];
    locationText: string | null;
    topicLabel: string | null;
    topicImportance: 'doNotNotify' | 'normal' | 'high';
    proximityImportance: 'none' | 'near' | 'wide';
}

export const getSystemPrompt = () => {
    return `Είσαι ένα σύστημα που εξάγει θέματα από τις ημερήσιες διατάξεις δημοτικών συμβουλίων διαφόρων πόλεων στην Ελλάδα. Οι απαντήσεις σου πρέπει να είναι μόνο JSON, και συγκεκριμένα ένας πίνακας (array) με objects με το ακόλουθο structure:

{
    name: string; // Ένας σύντομος τίτλος για το θέμα (2-6 λέξεις)
    description: string;  // 2-5 προτάσεις με μια σύντομη, απλή και περιεκτική περιγραφή του θέματος
                          // ΣΗΜΑΝΤΙΚΟ: Αυτή είναι ημερήσια διάταξη για ΜΕΛΛΟΝΤΙΚΗ συνεδρίαση που δεν έχει γίνει ακόμα.
                          // Γράψε την περιγραφή με ουδέτερο χρόνο που δείχνει ότι το θέμα ΘΑ συζητηθεί (όχι ότι συζητείται τώρα).
                          // ✓ Σωστά: "Το θέμα αφορά...", "Θα εξεταστεί...", "Προς έγκριση η..."
                          // ✗ Λάθος: "Συζητούνται...", "Εγκρίνεται...", "Παρουσιάζεται..."
    agendaItemIndex: number | null; // Ο αριθμός που συνοδεύει το θέμα στο έγγραφο της ημερήσιας διάταξης, αν υπάρχει
    locationText:  string | null; // Αν το θέμα αναφέρεται σε κάποια συγκεκριμένη τοποθεσία (π.χ. διεύθυνση, δρόμος, γειτονιά, ή συγκεκριμένη επιχείρηση / δημόσια δομή), η διεύθυνση του θέματος. Αν το θέμα δεν έχει τοποθεσία, ή αφορά ολόκληρο το δήμο (π.χ. ο προϋπολογισμός του Δήμου), τότε null
    introducedByPersonId: string | null; // Το id του εισηγητή του θέματος, αν αναφέρετε σαφώς στη διάταξη
    topicLabel: string | null; // Το label θέματος που ταιριάζει καλύτερα στο θέμα
    topicImportance: 'doNotNotify' | 'normal' | 'high'; // Η σημασία του θέματος για ειδοποιήσεις
    proximityImportance: 'none' | 'near' | 'wide'; // Η γεωγραφική ακτίνα επιρροής του θέματος
};

${IMPORTANCE_GUIDELINES}

Είναι πολύ σημαντικό να εξάγεις ΟΛΑ τα θέματα που υπάρχουν στην ημερήσια διάταξη, χωρίς να παραλήψεις απολύτως κανένα, και να βάλεις τους σωστούς αριθμούς.`;
}

export const getUserPrompt = (agendaPdfBase64: string, cityName: string, date: string, people: { id: string; name: string; role: string; party: string; }[], topicLabels: string[]) => {
    return `Πρέπει να εξάγεις θέματα από την ημερήσια διάταξη της πόλης ${cityName} για τη συνεδρίαση που θα γίνει στις ${date}.

ΣΗΜΑΝΤΙΚΟ: Η συνεδρίαση ΔΕΝ έχει γίνει ακόμα - αυτή είναι η ημερήσια διάταξη για μελλοντική συνεδρίαση. Γράψε τις περιγραφές με τρόπο που δείχνει ότι αυτά είναι θέματα ΠΡΟΣ συζήτηση, όχι θέματα που συζητούνται αυτή τη στιγμή.

Τα άτομα που συμμετέχουν στη συνεδρίαση, και μπορεί να είναι εισηγητές θεμάτων, είναι τα εξής:
${JSON.stringify(people, null, 2)}

Τα topic labels που μπορεί να έχουν τα θέματα είναι: ${topicLabels.join(", ")}

Παρακαλώ να εξάγεις ΟΛΑ τα θέματα από αυτό το έγγραφο.`;
}
