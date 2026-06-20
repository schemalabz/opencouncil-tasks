import { aiChat, addUsage, NO_USAGE, type UsageStats } from "../lib/ai.js";
import { enrichSubjectData, type EnrichmentInput } from "../lib/subjectEnrichment.js";
import { IMPORTANCE_GUIDELINES } from "../lib/importanceGuidelines.js";
import { languageDirectiveSuffix } from "../lib/language.js";
import { CityLanguage, ProcessAgendaRequest, ProcessAgendaResult, Subject, TaskWarning, TopicLabelInfo } from "../types.js";

export type AgendaWarningCode = 'MISSING_AGENDA_ITEM_INDEX';
import { formatTopicLabels } from "../lib/promptUtils.js";
import { Task } from "./pipeline.js";
import { generateSubjectUUID, extractMeetingId } from "../utils.js";
import { logMultiPhaseUsage } from "../lib/usageLogging.js";

export const processAgenda: Task<ProcessAgendaRequest, ProcessAgendaResult> = async (request, onProgress) => {
    const meetingId = extractMeetingId(request.callbackUrl);

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`🚀 PROCESS AGENDA STARTED [${meetingId}]`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`📊 Request Details:`);
    console.log(`   • City: ${request.cityName}`);
    console.log(`   • Date: ${request.date}`);
    console.log(`   • Agenda: ${request.agendaUrl}`);
    console.log(`   • People: ${request.people.length}`);
    console.log(`   • Topic labels: ${request.topicLabels.length}`);
    console.log('───────────────────────────────────────────────────────────');

    if (!request.agendaUrl) {
        throw new Error("Agenda is required");
    }

    if (!request.agendaUrl.endsWith(".pdf")) {
        throw new Error("Agenda must be a PDF file");
    }

    console.log('');
    console.log('📄 PHASE 1: PDF Download');
    const base64 = await downloadFileToBase64(request.agendaUrl);
    const pdfSizeKB = Math.round(base64.length * 3 / 4 / 1024);
    console.log(`   Downloaded ${pdfSizeKB}KB`);

    console.log('');
    console.log('📝 PHASE 2: Extraction');
    onProgress("extraction", 0);

    const result = await aiChat<Omit<ExtractedSubject, "speakerContributions">[]>({
        model: "claude-opus-4-6",
        label: "agenda-extraction",
        systemPrompt: getSystemPrompt(request.cityLanguage),
        userPrompt: getUserPrompt(base64, request.cityName, request.cityLanguage, request.date, request.people, request.topicLabels),
        documentBase64: base64,
        outputFormat: {
            type: "json_schema",
            schema: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        description: { type: "string" },
                        agendaItemIndex: { type: ["number", "null"] },
                        locationText: { type: ["string", "null"] },
                        introducedByPersonId: { type: ["string", "null"] },
                        topicLabel: { type: ["string", "null"] },
                        topicImportance: { type: "string", enum: ["doNotNotify", "normal", "high"] },
                        proximityImportance: { type: "string", enum: ["none", "near", "wide"] },
                    },
                    required: ["name", "description", "agendaItemIndex", "locationText", "introducedByPersonId", "topicLabel", "topicImportance", "proximityImportance"],
                    additionalProperties: false
                }
            }
        }
    });

    onProgress("extraction", 1);

    const extracted = result.result;
    const extractionModel = result.resolvedModel;
    const extractionBatch = result.batchMode;
    const warnings = fillMissingAgendaIndices(extracted);

    const importanceDist = { doNotNotify: 0, normal: 0, high: 0 };
    let introducerCount = 0;
    let topicCount = 0;
    let locationTextCount = 0;
    for (const s of extracted) {
        importanceDist[s.topicImportance]++;
        if (s.introducedByPersonId) introducerCount++;
        if (s.topicLabel) topicCount++;
        if (s.locationText) locationTextCount++;
    }

    console.log(`   Extracted ${extracted.length} subjects`);
    console.log(`   Importance: ${importanceDist.high} high, ${importanceDist.normal} normal, ${importanceDist.doNotNotify} doNotNotify`);
    console.log(`   Introducers matched: ${introducerCount}/${extracted.length}`);
    console.log(`   Topics assigned: ${topicCount}/${extracted.length}`);
    console.log(`   Locations found: ${locationTextCount}/${extracted.length}`);

    const usagePhases: ({ label: string } & UsageStats)[] = [
        { label: 'Phase 2 (Extraction)', usage: result.usage, resolvedModel: extractionModel, batchMode: extractionBatch }
    ];

    console.log('');
    console.log('🔍 PHASE 3: Enrichment');
    onProgress("enrichment", 0);

    let enrichmentUsage = NO_USAGE;
    let enrichmentModel: string | undefined;
    let enrichmentBatchMode: boolean | undefined;
    const enrichmentResults = await Promise.all(
        extracted.map((s, i) => extractedSubjectToApiSubject(
            { ...s, speakerContributions: [] },
            request.cityName,
            request.cityLanguage,
            request.date
        ).then(r => {
            onProgress("enrichment", (i + 1) / extracted.length);
            return r;
        }))
    );

    const subjects = enrichmentResults.map(r => {
        enrichmentUsage = addUsage(enrichmentUsage, r.usage);
        if (enrichmentModel === undefined) {
            enrichmentModel = r.resolvedModel;
            enrichmentBatchMode = r.batchMode;
        }
        return r.result;
    });

    const geocodedCount = subjects.filter(s => s.location !== null).length;
    const webContextCount = subjects.filter(s => s.context && s.context.text !== "").length;

    console.log(`   Enriched ${subjects.length}/${extracted.length} subjects`);
    console.log(`   Geocoded: ${geocodedCount}/${locationTextCount} locations`);
    console.log(`   Web context: ${webContextCount}/${subjects.length} subjects`);

    usagePhases.push({
        label: 'Phase 3 (Enrichment)',
        usage: enrichmentUsage,
        resolvedModel: enrichmentModel,
        batchMode: enrichmentBatchMode
    });

    logMultiPhaseUsage(`📊 TOTAL TOKEN USAGE [${meetingId}]`, usagePhases);
    console.log(`✅ PROCESS AGENDA COMPLETED [${meetingId}]`);
    console.log('═══════════════════════════════════════════════════════════');

    return { subjects, warnings };
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
    cityLanguage: CityLanguage,
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
        agendaItemIndex: subject.agendaItemIndex!,
        introducedByPersonId: subject.introducedByPersonId,
        speakerContributions: subject.speakerContributions,
        discussedIn: null  // Agenda items are always independent initially
    };

    return enrichSubjectData(input, id, {
        cityName,
        cityLanguage,
        date
    });
}

export function fillMissingAgendaIndices(subjects: Array<{ agendaItemIndex: number | null }>): TaskWarning<AgendaWarningCode>[] {
    const nullCount = subjects.filter(s => s.agendaItemIndex === null).length;
    if (nullCount === 0) return [];

    const maxIndex = subjects.reduce((max, s) =>
        typeof s.agendaItemIndex === 'number' ? Math.max(max, s.agendaItemIndex) : max, 0);
    let nextIndex = maxIndex + 1;
    for (const s of subjects) {
        if (s.agendaItemIndex === null) {
            s.agendaItemIndex = nextIndex++;
        }
    }
    console.warn(`   ⚠️  ${nullCount} subject(s) missing agenda item number — assigning sequential indices`);
    return [{
        code: 'MISSING_AGENDA_ITEM_INDEX',
        severity: 'warning',
        message: `${nullCount} subject(s) had no agenda item number in the PDF — assigned sequential indices`,
    }];
}

export type ExtractedSubject = {
    name: string;
    description: string;
    agendaItemIndex: number | null;
    introducedByPersonId: string | null;
    speakerContributions: {
        speakerId: string | null;
        speakerName: string | null;
        text: string;
    }[];
    locationText: string | null;
    topicLabel: string | null;
    topicImportance: 'doNotNotify' | 'normal' | 'high';
    proximityImportance: 'none' | 'near' | 'wide';
}

export const getSystemPrompt = (cityLanguage: CityLanguage) => {
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

Είναι πολύ σημαντικό να εξάγεις ΟΛΑ τα θέματα που υπάρχουν στην ημερήσια διάταξη, χωρίς να παραλήψεις απολύτως κανένα, και να βάλεις τους σωστούς αριθμούς.${languageDirectiveSuffix(cityLanguage)}`;
}

export const getUserPrompt = (agendaPdfBase64: string, cityName: string, cityLanguage: CityLanguage, date: string, people: { id: string; name: string; role: string; party: string; }[], topicLabels: TopicLabelInfo[]) => {
    const formattedTopics = formatTopicLabels(topicLabels);

    return `Πρέπει να εξάγεις θέματα από την ημερήσια διάταξη της πόλης ${cityName} για τη συνεδρίαση που θα γίνει στις ${date}.

ΣΗΜΑΝΤΙΚΟ: Η συνεδρίαση ΔΕΝ έχει γίνει ακόμα - αυτή είναι η ημερήσια διάταξη για μελλοντική συνεδρίαση. Γράψε τις περιγραφές με τρόπο που δείχνει ότι αυτά είναι θέματα ΠΡΟΣ συζήτηση, όχι θέματα που συζητούνται αυτή τη στιγμή.

Τα άτομα που συμμετέχουν στη συνεδρίαση, και μπορεί να είναι εισηγητές θεμάτων, είναι τα εξής:
${JSON.stringify(people, null, 2)}

ΣΗΜΑΝΤΙΚΟ - Αντιστοίχιση εισηγητών:
- Η ημερήσια διάταξη συχνά αναφέρει εισηγητές με ΡΟΛΟ (π.χ. "ΕΙΣΗΓΗΤΗΣ: ΔΗΜΑΡΧΟΣ", "ΕΙΣΗΓΗΤΗΣ: ΑΝΤΙΔΗΜΑΡΧΟΣ")
- Βρες το άτομο στη λίστα με το αντίστοιχο role (case-insensitive: "ΔΗΜΑΡΧΟΣ" = "Δήμαρχος")
- Χρησιμοποίησε το id του ατόμου, όχι το όνομα του ρόλου
- Αν δεν βρίσκεις αντιστοίχιση, βάλε null

Τα topic labels που μπορεί να έχουν τα θέματα είναι (χρησιμοποίησε ΜΟΝΟ το όνομα, πριν το —):
${formattedTopics}

Παρακαλώ να εξάγεις ΟΛΑ τα θέματα από αυτό το έγγραφο.${languageDirectiveSuffix(cityLanguage)}`;
}
