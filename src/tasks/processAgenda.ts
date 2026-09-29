import { aiChat, addUsage, NO_USAGE, type UsageStats } from "../lib/ai.js";
import { enrichSubjectData, type EnrichmentInput } from "../lib/subjectEnrichment.js";
import { IMPORTANCE_GUIDELINES } from "../lib/importanceGuidelines.js";
import { languageDirectiveSuffix } from "../lib/language.js";
import { fetchAgendaDocument, type AgendaDocument } from "../lib/documentConversion.js";
import { AGENDA_ITEM_TITLE_RULES, normalizeAgendaItemTitle } from "../lib/agendaItemTitle.js";
import { CityLanguage, CountryCode, ProcessAgendaRequest, ProcessAgendaResult, Subject, TaskWarning, TopicLabelInfo } from "../types.js";

export type AgendaWarningCode =
    | 'MISSING_AGENDA_ITEM_INDEX'
    | 'MISSING_AGENDA_ITEM_TITLE'
    | 'INCONSISTENT_AGENDA_SECTION'
    | 'PARTIAL_AGENDA_SECTIONS'
    | 'DUPLICATE_AGENDA_ITEM_INDEX';
import { formatTopicLabels } from "../lib/promptUtils.js";
import { Task } from "./pipeline.js";
import { generateSubjectUUID, extractMeetingId } from "../utils.js";
import { logMultiPhaseUsage } from "../lib/usageLogging.js";

export const AGENDA_EXTRACTION_SCHEMA = {
    type: "array",
    items: {
        type: "object",
        properties: {
            name: { type: "string" },
            description: { type: "string" },
            agendaItemTitle: { type: ["string", "null"] },
            agendaItemIndex: { type: ["number", "null"] },
            agendaSectionIndex: { type: ["number", "null"] },
            agendaSectionTitle: { type: ["string", "null"] },
            locationText: { type: ["string", "null"] },
            introducedByPersonId: { type: ["string", "null"] },
            topicLabel: { type: ["string", "null"] },
            topicImportance: { type: "string", enum: ["doNotNotify", "normal", "high"] },
            proximityImportance: { type: "string", enum: ["none", "near", "wide"] },
        },
        required: ["name", "description", "agendaItemTitle", "agendaItemIndex", "agendaSectionIndex", "agendaSectionTitle", "locationText", "introducedByPersonId", "topicLabel", "topicImportance", "proximityImportance"],
        additionalProperties: false
    }
};

export type AgendaExtraction = {
    extracted: ExtractedSubject[];
    warnings: TaskWarning<AgendaWarningCode>[];
    extraction: UsageStats;
};

/** Phases 1 and 2: the document and the model's reading of it, normalized. No enrichment. */
export const extractAgendaSubjects = async (
    request: Omit<ProcessAgendaRequest, 'callbackUrl'>,
    onProgress: (stage: string, progressPercent: number) => void
): Promise<AgendaExtraction> => {
    if (!request.agendaUrl) {
        throw new Error("Agenda is required");
    }

    console.log('');
    console.log('📄 PHASE 1: Document Download');
    const agenda = await fetchAgendaDocument(request.agendaUrl);

    console.log('');
    console.log('📝 PHASE 2: Extraction');
    onProgress("extraction", 0);

    const result = await aiChat<Omit<ExtractedSubject, "speakerContributions">[]>({
        model: "claude-opus-4-6",
        label: "agenda-extraction",
        systemPrompt: getSystemPrompt(request.cityLanguage),
        userPrompt: getUserPrompt(agenda, request.cityName, request.cityLanguage, request.date, request.people, request.topicLabels),
        documentBase64: agenda.kind === 'pdf' ? agenda.base64 : undefined,
        outputFormat: {
            type: "json_schema",
            schema: AGENDA_EXTRACTION_SCHEMA
        }
    });

    onProgress("extraction", 1);

    const extracted: ExtractedSubject[] = result.result.map(s => ({ ...s, speakerContributions: [] }));
    // Sections first: a filled number depends on its section, and the
    // duplicate check depends on both.
    const warnings = normalizeExtractedSections(extracted);
    warnings.push(...fillMissingAgendaIndices(extracted));
    warnings.push(...warnDuplicateAgendaPositions(extracted));
    warnings.push(...normalizeExtractedTitles(extracted));

    const importanceDist = { doNotNotify: 0, normal: 0, high: 0 };
    let introducerCount = 0;
    let topicCount = 0;
    let locationTextCount = 0;
    let titledCount = 0;
    let sectionedCount = 0;
    for (const s of extracted) {
        importanceDist[s.topicImportance]++;
        if (s.introducedByPersonId) introducerCount++;
        if (s.topicLabel) topicCount++;
        if (s.locationText) locationTextCount++;
        if (s.agendaItemTitle !== null) titledCount++;
        if (s.agendaSectionIndex !== null) sectionedCount++;
    }
    const sectionCount = new Set(extracted.map(s => s.agendaSectionIndex).filter(i => i !== null)).size;

    console.log(`   Extracted ${extracted.length} subjects`);
    console.log(`   Importance: ${importanceDist.high} high, ${importanceDist.normal} normal, ${importanceDist.doNotNotify} doNotNotify`);
    console.log(`   Introducers matched: ${introducerCount}/${extracted.length}`);
    console.log(`   Topics assigned: ${topicCount}/${extracted.length}`);
    console.log(`   Locations found: ${locationTextCount}/${extracted.length}`);
    console.log(`   Agenda item titles kept: ${titledCount}/${extracted.length}`);
    console.log(`   Sections: ${sectionCount} (${sectionedCount}/${extracted.length} subjects sectioned)`);

    return {
        extracted,
        warnings,
        extraction: { usage: result.usage, resolvedModel: result.resolvedModel, batchMode: result.batchMode },
    };
};

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

    const { extracted, warnings, extraction } = await extractAgendaSubjects(request, onProgress);
    const locationTextCount = extracted.filter(s => s.locationText).length;

    const usagePhases: ({ label: string } & UsageStats)[] = [
        { label: 'Phase 2 (Extraction)', ...extraction }
    ];

    console.log('');
    console.log('🔍 PHASE 3: Enrichment');
    onProgress("enrichment", 0);

    let enrichmentUsage = NO_USAGE;
    let enrichmentModel: string | undefined;
    let enrichmentBatchMode: boolean | undefined;
    const enrichmentResults = await Promise.all(
        extracted.map((s, i) => extractedSubjectToApiSubject(
            s,
            request.cityName,
            request.cityLanguage,
            request.country,
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

export const extractedSubjectToApiSubject = async (
    subject: ExtractedSubject,
    cityName: string,
    cityLanguage: CityLanguage,
    country: CountryCode | undefined,
    date: string
) => {
    const id = generateSubjectUUID(subject, 36);

    const input: EnrichmentInput = {
        name: subject.name,
        description: subject.description,
        agendaItemTitle: subject.agendaItemTitle,
        locationText: subject.locationText,
        topicImportance: subject.topicImportance,
        proximityImportance: subject.proximityImportance,
        topicLabel: subject.topicLabel,
        agendaItemIndex: subject.agendaItemIndex!,
        agendaSection: subject.agendaSectionIndex !== null && subject.agendaSectionTitle !== null
            ? { index: subject.agendaSectionIndex, title: subject.agendaSectionTitle }
            : null,
        introducedByPersonId: subject.introducedByPersonId,
        speakerContributions: subject.speakerContributions,
        discussedIn: null  // Agenda items are always independent initially
    };

    return enrichSubjectData(input, id, {
        cityName,
        cityLanguage,
        country,
        date
    });
}

export function fillMissingAgendaIndices(
    subjects: Array<{ agendaItemIndex: number | null; agendaSectionIndex?: number | null }>
): TaskWarning<AgendaWarningCode>[] {
    const nullCount = subjects.filter(s => s.agendaItemIndex === null).length;
    if (nullCount === 0) return [];

    // A gap is filled after the last number of its own section, so section 2
    // never borrows a number from section 1's range.
    const lastBySection = new Map<number | null, number>();
    for (const s of subjects) {
        if (typeof s.agendaItemIndex !== 'number') continue;
        const section = s.agendaSectionIndex ?? null;
        lastBySection.set(section, Math.max(lastBySection.get(section) ?? 0, s.agendaItemIndex));
    }
    for (const s of subjects) {
        if (s.agendaItemIndex !== null) continue;
        const section = s.agendaSectionIndex ?? null;
        const next = (lastBySection.get(section) ?? 0) + 1;
        s.agendaItemIndex = next;
        lastBySection.set(section, next);
    }
    console.warn(`   ⚠️  ${nullCount} subject(s) missing agenda item number — assigning sequential indices`);
    return [{
        code: 'MISSING_AGENDA_ITEM_INDEX',
        severity: 'warning',
        message: `${nullCount} subject(s) had no agenda item number in the agenda document — assigned sequential indices`,
    }];
}

type SectionedSubject = {
    name: string;
    /** The printed number, when the item has one. The collapse rule reads it so
     *  that dropping the sections cannot merge two numbering domains into one. */
    agendaItemIndex?: number | null;
    agendaSectionIndex: number | null;
    agendaSectionTitle: string | null;
};

/**
 * Normalizes the sections in place. A section's identity is the printed index
 * alone. Titles are folded (whitespace, trailing stop, case) for comparison
 * only, so a stray stop or a casing variant never splits a section; each item
 * keeps the title the model returned. A half-filled section is dropped, a
 * single section shared by the whole agenda means the agenda has one list, and
 * the sections are renumbered 1..K in the order of the model's own indices, not
 * the order the items arrived in. Reports what it dropped, what it left uneven,
 * and any index the model gave more than one title; it never guesses a section
 * for an item.
 *
 * One index carrying two titles stays ONE section. Splitting it would shift the
 * index of every later section, and the app matches an agenda item by its
 * (section, number) position, so a shift makes it prune and recreate rows under
 * new public ids.
 */
export function normalizeExtractedSections(subjects: SectionedSubject[]): TaskWarning<AgendaWarningCode>[] {
    const warnings: TaskWarning<AgendaWarningCode>[] = [];

    const inconsistent: string[] = [];
    for (const s of subjects) {
        const title = s.agendaSectionTitle?.trim().replace(/\s+/g, ' ') || null;
        const index = typeof s.agendaSectionIndex === 'number' ? s.agendaSectionIndex : null;
        if ((title === null) !== (index === null)) {
            inconsistent.push(s.name);
            s.agendaSectionIndex = null;
            s.agendaSectionTitle = null;
        } else {
            s.agendaSectionIndex = index;
            s.agendaSectionTitle = title;
        }
    }
    if (inconsistent.length > 0) {
        console.warn(`   ⚠️  ${inconsistent.length} subject(s) came back with half a section: ${inconsistent.join(' | ')}`);
        warnings.push({
            code: 'INCONSISTENT_AGENDA_SECTION',
            severity: 'warning',
            message: `${inconsistent.length} subject(s) came back with a section index but no title, or a title but no index, and were treated as unsectioned: ${inconsistent.join(' | ')}`,
        });
    }

    const sectioned = subjects.filter(s => s.agendaSectionIndex !== null);
    if (sectioned.length === 0) return warnings;

    if (sectioned.length < subjects.length) {
        const unsectioned = subjects.filter(s => s.agendaSectionIndex === null).map(s => s.name);
        console.warn(`   ⚠️  ${unsectioned.length} subject(s) have no section while ${sectioned.length} do: ${unsectioned.join(' | ')}`);
        warnings.push({
            code: 'PARTIAL_AGENDA_SECTIONS',
            severity: 'warning',
            message: `${unsectioned.length} subject(s) have no section while ${sectioned.length} do: ${unsectioned.join(' | ')}`,
        });
    }

    // The distinct titles the model wrote under each index, keyed by the folded
    // form and valued by the first verbatim spelling, which is what a person reads.
    const titlesByIndex = new Map<number, Map<string, string>>();
    for (const s of sectioned) {
        const titles = titlesByIndex.get(s.agendaSectionIndex!) ?? new Map<string, string>();
        const folded = foldSectionTitle(s.agendaSectionTitle);
        if (!titles.has(folded)) titles.set(folded, s.agendaSectionTitle!);
        titlesByIndex.set(s.agendaSectionIndex!, titles);
    }

    // The same printed index with more than one title means the model was inconsistent.
    // The items stay in one section; a person is told to look at the document.
    let ambiguous = false;
    for (const [index, titles] of titlesByIndex) {
        if (titles.size <= 1) continue;
        ambiguous = true;
        const titleList = [...titles.values()].join(' | ');
        console.warn(`   ⚠️  section index ${index} carries more than one title: ${titleList}`);
        warnings.push({
            code: 'INCONSISTENT_AGENDA_SECTION',
            severity: 'warning',
            message: `Section index ${index} carries more than one title, and was kept as one section: ${titleList}`,
        });
    }

    // One section for the whole agenda is no section at all: the agenda has one
    // list. Unless dropping it would put two items on the same printed number —
    // then the section is the only thing telling them apart and it stays.
    const indices = [...titlesByIndex.keys()].sort((a, b) => a - b);
    if (indices.length === 1 && !ambiguous && !collapseWouldRepeatANumber(subjects)) {
        for (const s of subjects) {
            s.agendaSectionIndex = null;
            s.agendaSectionTitle = null;
        }
        return warnings;
    }

    const renumbered = new Map(indices.map((index, position) => [index, position + 1]));
    for (const s of sectioned) s.agendaSectionIndex = renumbered.get(s.agendaSectionIndex!)!;

    return warnings;
}

/**
 * The section title as it is compared: the agenda item rules (whitespace, trailing
 * stop, blank to null), then case, accents and the final sigma folded away. Greek
 * headings are printed in capitals, which carry no accents, so «ΓΕΝΙΚΑ ΘΕΜΑΤΑ» and
 * «Γενικά Θέματα» are the same heading and must fold to the same string. An
 * item keeps its verbatim title; only the comparison sees this form.
 */
function foldSectionTitle(title: string | null): string {
    const lowered = normalizeAgendaItemTitle(title)?.toLocaleLowerCase('el');
    if (!lowered) return '';
    return lowered.normalize('NFD').replace(/\p{M}/gu, '').replace(/\u03c2/g, '\u03c3');
}

/**
 * Whether dropping every section would leave two items sharing one printed
 * number. An item with no number cannot collide: fillMissingAgendaIndices gives
 * it a free one within its section afterwards.
 */
function collapseWouldRepeatANumber(subjects: SectionedSubject[]): boolean {
    const seen = new Set<number>();
    for (const s of subjects) {
        if (typeof s.agendaItemIndex !== 'number') continue;
        if (seen.has(s.agendaItemIndex)) return true;
        seen.add(s.agendaItemIndex);
    }
    return false;
}

/**
 * Reports every (section, number) pair that more than one subject carries. The
 * subjects are returned as they are: the app matches by name before position,
 * and the warning is the signal that the document needs a look.
 */
export function warnDuplicateAgendaPositions(
    subjects: Array<{ name: string; agendaItemIndex: number | null; agendaSectionIndex: number | null }>
): TaskWarning<AgendaWarningCode>[] {
    const byPosition = new Map<string, string[]>();
    const labelByKey = new Map<string, string>();
    for (const s of subjects) {
        if (s.agendaItemIndex === null) continue;
        const key = `${s.agendaSectionIndex ?? '-'}:${s.agendaItemIndex}`;
        byPosition.set(key, [...(byPosition.get(key) ?? []), s.name]);
        labelByKey.set(key, s.agendaSectionIndex === null ? `#${s.agendaItemIndex}` : `${s.agendaSectionIndex}:${s.agendaItemIndex}`);
    }
    const duplicates = [...byPosition].filter(([, names]) => names.length > 1);
    if (duplicates.length === 0) return [];

    const detail = duplicates.map(([key, names]) => `${labelByKey.get(key)}: ${names.join(' / ')}`).join(' | ');
    console.warn(`   ⚠️  ${duplicates.length} agenda position(s) carry more than one subject: ${detail}`);
    return [{
        code: 'DUPLICATE_AGENDA_ITEM_INDEX',
        severity: 'warning',
        message: `${duplicates.length} agenda position(s) (section:number) carry more than one subject — ${detail}`,
    }];
}

/** Normalizes every extracted title in place and reports the subjects left without one. */
export function normalizeExtractedTitles(subjects: Array<{ name: string; agendaItemTitle: string | null }>): TaskWarning<AgendaWarningCode>[] {
    const missing: string[] = [];
    for (const s of subjects) {
        s.agendaItemTitle = normalizeAgendaItemTitle(s.agendaItemTitle);
        if (s.agendaItemTitle === null) missing.push(s.name);
    }
    if (missing.length === 0) return [];
    console.warn(`   ⚠️  ${missing.length} subject(s) came back without an agenda item title: ${missing.join(' | ')}`);
    return [{
        code: 'MISSING_AGENDA_ITEM_TITLE',
        severity: 'warning',
        message: `${missing.length} subject(s) came back without the verbatim agenda item title; the minutes fall back to the summary name for: ${missing.join(' | ')}`,
    }];
}

export type ExtractedSubject = {
    name: string;
    description: string;
    agendaItemTitle: string | null;
    agendaItemIndex: number | null;
    agendaSectionIndex: number | null;
    agendaSectionTitle: string | null;
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
    return `Είσαι ένα σύστημα που εξάγει θέματα από τις ημερήσιες διατάξεις δημοτικών συμβουλίων διαφόρων πόλεων. Οι απαντήσεις σου πρέπει να είναι μόνο JSON, και συγκεκριμένα ένας πίνακας (array) με objects με το ακόλουθο structure:

{
    name: string; // Ένας σύντομος τίτλος για το θέμα (2-6 λέξεις)
    description: string;  // 2-5 προτάσεις με μια σύντομη, απλή και περιεκτική περιγραφή του θέματος
                          // ΣΗΜΑΝΤΙΚΟ: Αυτή είναι ημερήσια διάταξη για ΜΕΛΛΟΝΤΙΚΗ συνεδρίαση που δεν έχει γίνει ακόμα.
                          // Γράψε την περιγραφή με ουδέτερο χρόνο που δείχνει ότι το θέμα ΘΑ συζητηθεί (όχι ότι συζητείται τώρα).
                          // ✓ Σωστά: "Το θέμα αφορά...", "Θα εξεταστεί...", "Προς έγκριση η..."
                          // ✗ Λάθος: "Συζητούνται...", "Εγκρίνεται...", "Παρουσιάζεται..."
    agendaItemTitle: string | null; // Ο τίτλος του θέματος ΟΠΩΣ ΑΚΡΙΒΩΣ είναι γραμμένος στην ημερήσια διάταξη — βλ. τους κανόνες παρακάτω. null μόνο αν το κείμενο δεν διαβάζεται.
                          // Οι κανόνες για το πεδίο, μαζί με την εξαίρεση γλώσσας, είναι παρακάτω.
    agendaItemIndex: number | null; // Ο αριθμός που συνοδεύει το θέμα στο έγγραφο της ημερήσιας διάταξης, αν υπάρχει — βλ. τους κανόνες για τις ενότητες παρακάτω
    agendaSectionIndex: number | null; // Η σειρά της ενότητας στην οποία ανήκει το θέμα (1 για την πρώτη ενότητα του εγγράφου). null όταν το έγγραφο έχει μία μόνο αριθμημένη λίστα.
    agendaSectionTitle: string | null; // Η επικεφαλίδα της ενότητας ΟΠΩΣ ΑΚΡΙΒΩΣ είναι γραμμένη, σε μία γραμμή. null όταν το agendaSectionIndex είναι null.
    locationText:  string | null; // Αν το θέμα αναφέρεται σε κάποια συγκεκριμένη τοποθεσία (π.χ. διεύθυνση, δρόμος, γειτονιά, ή συγκεκριμένη επιχείρηση / δημόσια δομή), η διεύθυνση του θέματος.
                          // Γράψε ΜΟΝΟ το τοπωνύμιο· ΜΗΝ προσθέτεις πόλη, περιοχή ή χώρα — μπαίνουν αυτόματα αργότερα.
                          // ΕΞΑΙΡΕΣΗ ΓΛΩΣΣΑΣ (ισχύει ΜΟΝΟ για το locationText και το agendaItemTitle, όχι για τα υπόλοιπα πεδία): κράτα το τοπωνύμιο στη γλώσσα και το αλφάβητο που χρησιμοποιεί το έγγραφο — ΜΗΝ μεταφράζεις και ΜΗΝ μεταγράφεις μεταξύ αλφαβήτων.
                          // Αν το θέμα δεν έχει τοποθεσία, ή αφορά ολόκληρο το δήμο (π.χ. ο προϋπολογισμός του Δήμου), τότε null
    introducedByPersonId: string | null; // Το id του εισηγητή του θέματος, αν αναφέρετε σαφώς στη διάταξη
    topicLabel: string | null; // Το label θέματος που ταιριάζει καλύτερα στο θέμα
    topicImportance: 'doNotNotify' | 'normal' | 'high'; // Η σημασία του θέματος για ειδοποιήσεις
    proximityImportance: 'none' | 'near' | 'wide'; // Η γεωγραφική ακτίνα επιρροής του θέματος
};

${IMPORTANCE_GUIDELINES}

${AGENDA_ITEM_TITLE_RULES}

ΚΑΝΟΝΕΣ ΓΙΑ ΤΗΝ ΑΡΙΘΜΗΣΗ ΚΑΙ ΤΙΣ ΕΝΟΤΗΤΕΣ:
- Το agendaItemIndex είναι ο αριθμός που είναι τυπωμένος δίπλα στο θέμα. ΜΗΝ αλλάζεις την αρίθμηση και ΜΗΝ συνεχίζεις την αρίθμηση από τη μία ενότητα στην επόμενη. Αν δύο ενότητες ξεκινούν και οι δύο από το 1, τα δύο πρώτα θέματά τους παίρνουν και τα δύο agendaItemIndex 1.
- Ενότητα είναι μια επικεφαλίδα που ομαδοποιεί αριθμημένα θέματα και κάτω από την οποία η αρίθμηση ξεκινά ξανά, ή που αλλάζει το νόημα των θεμάτων που ακολουθούν. Παραδείγματα: «ΓΕΝΙΚΑ ΘΕΜΑΤΑ» και «ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ»· «Α. Θέματα σύμφωνα με την παρ.2» και «Β. Τακτικά θέματα»· μια δεύτερη ΠΡΟΣΚΛΗΣΗ μέσα στο ίδιο έγγραφο με δικά της ΘΕΜΑΤΑ.
- Το agendaSectionIndex είναι η σειρά της ενότητας μέσα στο έγγραφο, ξεκινώντας από το 1. Το agendaSectionTitle είναι η επικεφαλίδα ΟΠΩΣ ΑΚΡΙΒΩΣ είναι γραμμένη στο έγγραφο, σε μία γραμμή, αντιγραμμένη αυτούσια. ΜΗΝ συνθέτεις δικό σου τίτλο, ΜΗΝ συνδυάζεις δύο γραμμές και ΜΗΝ προσθέτεις αριθμό πρόσκλησης, ώρα ή άλλα στοιχεία που δεν βρίσκονται στη γραμμή της επικεφαλίδας. Όταν το έγγραφο περιέχει περισσότερες από μία προσκλήσεις, χρησιμοποίησε τη γραμμή που ονομάζει το όργανο της κάθε πρόσκλησης, π.χ. «ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ».
- Όταν το έγγραφο έχει μία μόνο αριθμημένη λίστα θεμάτων, βάλε null και στα δύο πεδία σε ΟΛΑ τα θέματα. ΜΗΝ επινοείς ενότητα.

Είναι πολύ σημαντικό να εξάγεις ΟΛΑ τα θέματα που υπάρχουν στην ημερήσια διάταξη, χωρίς να παραλήψεις απολύτως κανένα, και να βάλεις τους σωστούς αριθμούς.${languageDirectiveSuffix(cityLanguage)}`;
}

export const getUserPrompt = (agenda: AgendaDocument, cityName: string, cityLanguage: CityLanguage, date: string, people: { id: string; name: string; role: string; party: string; }[], topicLabels: TopicLabelInfo[]) => {
    const formattedTopics = formatTopicLabels(topicLabels);

    // A PDF agenda rides along as a document block; a .docx was converted to
    // HTML, so its content goes in the prompt itself.
    const convertedDocument = agenda.kind === 'html'
        ? `\n\nΤο έγγραφο της ημερήσιας διάταξης (μετατροπή από αρχείο Word σε HTML — η δομή του, επικεφαλίδες, λίστες και πίνακες, διατηρείται):\n\n${agenda.html}\n`
        : '';

    return `Πρέπει να εξάγεις θέματα από την ημερήσια διάταξη της πόλης ${cityName} για τη συνεδρίαση που θα γίνει στις ${date}.${convertedDocument}

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
