import { CityLanguage, DiscussionStatus, RosterPerson } from "../../types.js";
import { aiChat, addUsage, NO_USAGE, type UsageStats } from "../../lib/ai.js";
import { batchFirstEnabled } from "../../lib/taskControl.js";
import { getSubjectDescriptionSystemPrompt } from "./prompts.js";
import { extractAndGroupUtterances, formatDiscussion } from "./speakerContributions.js";
import { CompressedTranscript, ExtractedUtterances, SubjectInProgress, UtteranceStatus } from "./types.js";

/**
 * Keeps only references a reader can follow: a link to an utterance tagged to this subject. A
 * link to any other utterance keeps its text and loses the link, and a reference written outside
 * link syntax («…» (REF:UTTERANCE:x)) is dropped.
 */
export function sanitizeReferences(description: string, utteranceIds: ReadonlySet<string>): string {
    return description
        .replace(/\[([^\]]*)\]\(REF:UTTERANCE:([^)\s]+)\)/g, (link, text: string, id: string) => (utteranceIds.has(id) ? link : text))
        .replace(/(?<!\])\s*\(REF:[A-Z]+:[^)\s]+\)/g, '');
}

const TYPE_LABEL: Record<SubjectInProgress['type'], string> = {
    IN_AGENDA: 'Θέμα ημερήσιας διάταξης',
    BEFORE_AGENDA: 'Θέμα προ ημερησίας διάταξης',
    OUT_OF_AGENDA: 'Θέμα εκτός ημερησίας διάταξης',
};

/** What the step writes for one subject: its description, who is notified of it, and why. */
export type WrittenSubject = Pick<SubjectInProgress, 'description' | 'topicImportance' | 'proximityImportance'> & {
    /** One sentence from the model on the two importance values. It stays in the run record. */
    importanceReason: string;
};

/** What the meeting knows about a subject besides its speech. */
export type SubjectFacts = {
    /** Name of the person recorded as the one who brought the subject. */
    introducedBy: string | null;
    /** Names of the subjects discussed together with this one, under it. */
    jointWith: string[];
    /** One line per person who spoke, in order of first speech: name, role, party. */
    speakers: string[];
    /** The text the agenda task wrote for an agenda item before the meeting. */
    agendaText?: string;
};

/**
 * The facts of a subject that its speech does not state: who brought it, what was discussed with
 * it, and who each speaker is. A role and a party come from the meeting's people when the speaker
 * is one of them, and from the transcript otherwise (a guest or an unidentified voice has no
 * person record, and gets no more than the transcript says).
 */
export function subjectFacts(
    subject: SubjectInProgress,
    subjects: SubjectInProgress[],
    discussion: ExtractedUtterances['allSubjectUtterances'],
    transcript: CompressedTranscript,
    people: ReadonlyMap<string, RosterPerson>
): SubjectFacts {
    const segmentOf = (speakerId: string | null, name: string | null) =>
        transcript.find(s => (speakerId ? s.speakerId === speakerId : !s.speakerId && s.speakerName === name));
    const seen = new Set<string>();
    const speakers: string[] = [];
    for (const u of discussion) {
        const key = u.speakerId ?? u.speakerName;
        if (!key || !u.speakerName || seen.has(key)) continue;
        seen.add(key);
        const person = u.speakerId ? people.get(u.speakerId) : undefined;
        const segment = segmentOf(u.speakerId, u.speakerName);
        const known = [
            person?.role ?? segment?.speakerRole,
            person?.party ?? segment?.speakerParty,
            person?.partyHead ? 'επικεφαλής της παράταξης' : null,
            person?.memberOfMeetingBody === false ? 'όχι μέλος του οργάνου' : null,
        ].filter(Boolean);
        speakers.push(`- ${u.speakerName}${known.length ? `: ${known.join(', ')}` : ''}`);
    }
    const introducer = subject.introducedByPersonId;
    return {
        introducedBy: introducer ? people.get(introducer)?.name ?? segmentOf(introducer, null)?.speakerName ?? null : null,
        jointWith: subjects.filter(s => s.discussedIn === subject.id).map(s => s.name),
        speakers,
    };
}

const place = (subject: SubjectInProgress) =>
    `${TYPE_LABEL[subject.type]}${typeof subject.agendaItemIndex === 'number' ? `, αριθμός ${subject.agendaItemIndex}` : ''}${subject.withdrawn ? ' (αποσύρθηκε ή αναβλήθηκε)' : ''}`;

/**
 * The agenda text of an agenda item: what the item is, in words the debate may never repeat. A
 * text with utterance references is an earlier summary and not the agenda text, so it is not given.
 */
const agendaTextFor = (subject: SubjectInProgress, agendaTexts: ReadonlyMap<string, string>): string | undefined => {
    const text = subject.type === 'IN_AGENDA' ? agendaTexts.get(subject.id)?.trim() : undefined;
    return text && !text.includes('REF:UTTERANCE') ? text : undefined;
};

/** What the description step is given about one subject. */
export function describeSubjectPrompt(subject: SubjectInProgress, discussion: ExtractedUtterances['allSubjectUtterances'], facts: SubjectFacts): string {
    return `
Θέμα: ${subject.name}
Είδος: ${place(subject)}${subject.locationText ? `\nΤοποθεσία: ${subject.locationText}` : ''}${facts.introducedBy ? `\n${subject.type === 'BEFORE_AGENDA' ? 'Το έθεσε' : 'Εισηγητής'}: ${facts.introducedBy}` : ''}${facts.jointWith.length ? `\nΣυζητήθηκε μαζί με: ${facts.jointWith.map(n => `«${n}»`).join(', ')}` : ''}${facts.agendaText ? `\n\nΑΠΟ ΤΗΝ ΗΜΕΡΗΣΙΑ ΔΙΑΤΑΞΗ (γράφτηκε πριν από τη συνεδρίαση):\n${facts.agendaText}` : ''}

ΟΣΟΙ ΜΙΛΗΣΑΝ (με τη σειρά που πήραν πρώτη φορά τον λόγο):
${facts.speakers.join('\n')}

Η ΣΥΖΗΤΗΣΗ:

${formatDiscussion(discussion)}
`;
}

/**
 * The description and the notification importance of a discussed subject, from all the speech
 * tagged to it. Phase 1 reads the meeting in batches, so what it writes for a subject can miss
 * whole rounds of the debate, and it cannot tell a debated subject from one that passed without a
 * word. This step sees the whole debate. It is not given the Phase 1 description, which would pull
 * the new one towards it.
 */
export async function writeSubjectDescription(
    subject: SubjectInProgress,
    discussion: ExtractedUtterances['allSubjectUtterances'],
    facts: SubjectFacts,
    administrativeBodyName?: string,
    cityLanguage?: CityLanguage
): Promise<{ written: WrittenSubject } & UsageStats> {
    const userPrompt = describeSubjectPrompt(subject, discussion, facts);
    const result = await aiChat<WrittenSubject>({
        model: "claude-opus-5-5",
        batchFirst: batchFirstEnabled(),
        // A description is a few hundred tokens; the room is for a model that reasons before it answers.
        maxTokens: 8000,
        label: `subject-description:${subject.name.slice(0, 40)}`,
        systemPrompt: getSubjectDescriptionSystemPrompt(administrativeBodyName, cityLanguage),
        userPrompt,
        outputFormat: {
            type: "json_schema",
            schema: {
                type: "object",
                properties: {
                    description: { type: "string" },
                    topicImportance: { type: "string", enum: ["doNotNotify", "normal", "high"] },
                    proximityImportance: { type: "string", enum: ["none", "near", "wide"] },
                    importanceReason: { type: "string" }
                },
                required: ["description", "topicImportance", "proximityImportance", "importanceReason"],
                additionalProperties: false
            }
        },
        cacheSystemPrompt: true
    });
    const said = new Set(discussion.map(u => u.utteranceId));
    const written = { ...result.result, description: sanitizeReferences(result.result.description.trim(), said) };
    return { written, usage: result.usage, resolvedModel: result.resolvedModel, batchMode: result.batchMode };
}

/**
 * What the step wrote, by subject id, for every primary subject somebody spoke on. A subject
 * nobody spoke on has no entry, and neither has one whose call fails.
 */
export async function writeSubjectDescriptions(
    subjects: SubjectInProgress[],
    statuses: UtteranceStatus[],
    transcript: CompressedTranscript,
    people: ReadonlyMap<string, RosterPerson>,
    agendaTexts: ReadonlyMap<string, string>,
    administrativeBodyName?: string,
    cityLanguage?: CityLanguage
): Promise<{ written: Map<string, WrittenSubject> } & UsageStats> {
    const written = new Map<string, WrittenSubject>();
    let usage = NO_USAGE;
    let resolvedModel: string | undefined;
    let batchMode: boolean | undefined;
    await Promise.all(subjects.filter(s => s.discussedIn === null && s.speakerContributions.length > 0).map(async subject => {
        const tagged = statuses.filter(s => s.subjectId === subject.id && s.status === DiscussionStatus.SUBJECT_DISCUSSION);
        const { allSubjectUtterances } = extractAndGroupUtterances(tagged, transcript);
        if (allSubjectUtterances.length === 0) return;
        try {
            const facts = { ...subjectFacts(subject, subjects, allSubjectUtterances, transcript, people), agendaText: agendaTextFor(subject, agendaTexts) };
            const result = await writeSubjectDescription(subject, allSubjectUtterances, facts, administrativeBodyName, cityLanguage);
            if (result.written.description) written.set(subject.id, result.written);
            usage = addUsage(usage, result.usage);
            resolvedModel ??= result.resolvedModel;
            batchMode ??= result.batchMode;
        } catch (error) {
            console.error(`   ⚠️  Description for "${subject.name}" not written, keeping the Phase 1 text:`, error instanceof Error ? error.message : error);
        }
    }));
    return { written, usage, resolvedModel, batchMode };
}

/**
 * Puts what the step wrote onto the subjects of the result. A subject discussed under another takes
 * that one's importance. A subject with no importance from the step (nobody spoke on it, or its call
 * failed) is not announced after the meeting; it keeps its radius, so a neighbour still hears of it.
 */
export function applyWrittenSubjects<T extends Pick<SubjectInProgress, 'id' | 'description' | 'topicImportance' | 'proximityImportance'>>(
    result: T[],
    subjects: ReadonlyArray<Pick<SubjectInProgress, 'id' | 'discussedIn'>>,
    written: ReadonlyMap<string, WrittenSubject>
): void {
    const discussedIn = new Map(subjects.map(s => [s.id, s.discussedIn]));
    for (const subject of result) {
        const own = written.get(subject.id);
        if (own) subject.description = own.description;
        const judged = written.get(discussedIn.get(subject.id) ?? subject.id);
        subject.topicImportance = judged ? judged.topicImportance : 'doNotNotify';
        if (judged) subject.proximityImportance = judged.proximityImportance;
    }
}
