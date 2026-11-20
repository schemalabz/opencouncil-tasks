import { CityLanguage, DiscussionStatus } from "../../types.js";
import { aiChat, addUsage, NO_USAGE, type UsageStats } from "../../lib/ai.js";
import { batchFirstEnabled } from "../../lib/taskControl.js";
import { getSubjectDescriptionSystemPrompt } from "./prompts.js";
import { CompressedTranscript, SubjectInProgress, UtteranceStatus } from "./types.js";

export type SpeakerPosition = {
    speakerName: string;
    party: string | null;
    role: string | null;
    /** Characters of speech tagged to the subject. */
    chars: number;
    /** The speaker's contribution as Phase 2 wrote it, references included. */
    text: string;
};

/**
 * Who spoke on a subject, in order of first speech, with how much they said. Read from every
 * utterance tagged to the subject, whichever batch tagged it.
 */
export function speakerPositions(subject: SubjectInProgress, statuses: UtteranceStatus[], transcript: CompressedTranscript): SpeakerPosition[] {
    const tagged = new Set(statuses.filter(s => s.subjectId === subject.id && s.status === DiscussionStatus.SUBJECT_DISCUSSION).map(s => s.utteranceId));
    const spoke = new Map<string, { party: string | null; role: string | null; chars: number }>();
    for (const segment of transcript) {
        const key = segment.speakerId || segment.speakerName;
        if (!key) continue;
        for (const utterance of segment.utterances) {
            if (!tagged.has(utterance.utteranceId)) continue;
            const entry = spoke.get(key) ?? { party: segment.speakerParty ?? null, role: segment.speakerRole ?? null, chars: 0 };
            entry.chars += utterance.text.length;
            spoke.set(key, entry);
        }
    }
    return [...subject.speakerContributions]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .flatMap(c => {
            const who = spoke.get(c.speakerId || c.speakerName || '');
            return c.speakerName && who ? [{ speakerName: c.speakerName, ...who, text: c.text }] : [];
        });
}

/** Speech below this is a remark or a short question; the description may leave it out. */
const SUBSTANTIAL_SPEECH_CHARS = 500;

/** The description grows with the number of people who took a position, not with how long they spoke. */
export function wordLimit(positions: SpeakerPosition[]): number {
    const substantial = positions.filter(p => p.chars >= SUBSTANTIAL_SPEECH_CHARS).length;
    return [35, 60, 80, 100, 110][substantial] ?? 130;
}

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

/**
 * The order in which people took the floor on a subject: consecutive speech of one person is a
 * turn, and turns of a sentence or two (a hand-over, an interjection) are left out. A contribution
 * joins all the turns of its speaker, so without this a reply cannot be told from an opening.
 */
export function turnOrder(subject: SubjectInProgress, statuses: UtteranceStatus[], transcript: CompressedTranscript): string[] {
    const tagged = new Set(statuses.filter(s => s.subjectId === subject.id && s.status === DiscussionStatus.SUBJECT_DISCUSSION).map(s => s.utteranceId));
    const turns: Array<{ name: string; chars: number }> = [];
    for (const segment of transcript) {
        const name = segment.speakerName;
        if (!name) continue;
        const chars = segment.utterances.filter(u => tagged.has(u.utteranceId)).reduce((sum, u) => sum + u.text.length, 0);
        if (chars === 0) continue;
        const last = turns[turns.length - 1];
        if (last && last.name === name) last.chars += chars;
        else turns.push({ name, chars });
    }
    return turns.filter(t => t.chars >= MIN_TURN_CHARS).map(t => t.name);
}

const MIN_TURN_CHARS = 150;

const SENTENCE_END = /(?<=(?:\p{L}{3,}|\d+|[)\]»"])[.;·!?])\s|\n/u;

/**
 * The first sentence says what the subject is, so it carries no reference: a link there keeps
 * its text and loses the link. The prompt asks for this; figures still arrive linked.
 */
export function unlinkOpening(description: string): string {
    let read = '';
    let done = false;
    return description.replace(/\[([^\]]*)\]\(REF:[^)]*\)|[^[]+|\[/g, (part: string, linkText?: string) => {
        if (done) return part;
        const startsAt = read.length;
        read += linkText ?? part;
        const end = read.search(SENTENCE_END);
        if (end < 0) return linkText ?? part;
        done = true;
        return linkText !== undefined && end >= startsAt ? linkText : part;
    });
}

const TYPE_LABEL: Record<SubjectInProgress['type'], string> = {
    IN_AGENDA: 'Θέμα ημερήσιας διάταξης',
    BEFORE_AGENDA: 'Θέμα προ ημερησίας διάταξης',
    OUT_OF_AGENDA: 'Θέμα εκτός ημερησίας διάταξης',
};

/**
 * The final description of a discussed subject, written once from the position of every speaker.
 * Phase 1 writes a description batch by batch and keeps the old one when a later batch does not
 * return the subject, so that text can miss whole rounds of the debate; the contributions cannot,
 * since they are written from every utterance tagged to the subject.
 */
export async function writeSubjectDescription(
    subject: SubjectInProgress,
    positions: SpeakerPosition[],
    turns: string[],
    administrativeBodyName?: string,
    cityLanguage?: CityLanguage
): Promise<{ description: string } & UsageStats> {
    const speakers = positions.map((p, i) => {
        const who = [p.party, p.role].filter(Boolean).join(', ');
        const weight = p.chars >= SUBSTANTIAL_SPEECH_CHARS ? 'ουσιαστική τοποθέτηση' : 'σύντομη παρέμβαση';
        return `${i + 1}. ${p.speakerName}${who ? ` (${who})` : ''} — ${weight}\n${p.text}`;
    }).join('\n\n');
    const userPrompt = `
Θέμα: ${subject.name}
Είδος: ${TYPE_LABEL[subject.type]}${subject.withdrawn ? ' (αποσύρθηκε ή αναβλήθηκε)' : ''}
Προσωρινή περιγραφή (μπορεί να είναι ελλιπής ή να είναι μόνο το κείμενο της ημερήσιας διάταξης):
${subject.description}

ΟΡΙΟ ΜΗΚΟΥΣ: έως ${wordLimit(positions)} λέξεις συνολικά.

ΣΕΙΡΑ ΤΩΝ ΟΜΙΛΙΩΝ (ποιος πήρε τον λόγο και πότε· όποιος εμφανίζεται ξανά, απαντά ή δευτερολογεί):
${turns.join(' → ')}

ΟΙ ΤΟΠΟΘΕΤΗΣΕΙΣ, ΜΕ ΤΗ ΣΕΙΡΑ ΤΗΣ ΠΡΩΤΗΣ ΟΜΙΛΙΑΣ ΚΑΘΕ ΟΜΙΛΗΤΗ:

${speakers}
`;
    const result = await aiChat<{ description: string }>({
        model: "claude-sonnet-5-5",
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
                properties: { description: { type: "string" } },
                required: ["description"],
                additionalProperties: false
            }
        },
        cacheSystemPrompt: true
    });
    const cited = new Set(positions.flatMap(p => [...p.text.matchAll(/REF:UTTERANCE:([^)\s]+)/g)].map(m => m[1])));
    return { description: unlinkOpening(sanitizeReferences(result.result.description.trim(), cited)), usage: result.usage, resolvedModel: result.resolvedModel, batchMode: result.batchMode };
}

/**
 * New descriptions by subject id, for every primary subject somebody spoke on. A subject nobody
 * spoke on keeps the description Phase 1 gave it, and so does one whose call fails.
 */
export async function writeSubjectDescriptions(
    subjects: SubjectInProgress[],
    statuses: UtteranceStatus[],
    transcript: CompressedTranscript,
    administrativeBodyName?: string,
    cityLanguage?: CityLanguage
): Promise<{ descriptions: Map<string, string> } & UsageStats> {
    const descriptions = new Map<string, string>();
    let usage = NO_USAGE;
    let resolvedModel: string | undefined;
    let batchMode: boolean | undefined;
    await Promise.all(subjects.filter(s => s.discussedIn === null && s.speakerContributions.length > 0).map(async subject => {
        const positions = speakerPositions(subject, statuses, transcript);
        if (positions.length === 0) return;
        try {
            const written = await writeSubjectDescription(subject, positions, turnOrder(subject, statuses, transcript), administrativeBodyName, cityLanguage);
            if (written.description) descriptions.set(subject.id, written.description);
            usage = addUsage(usage, written.usage);
            resolvedModel ??= written.resolvedModel;
            batchMode ??= written.batchMode;
        } catch (error) {
            console.error(`   ⚠️  Description for "${subject.name}" not written, keeping the Phase 1 text:`, error instanceof Error ? error.message : error);
        }
    }));
    return { descriptions, usage, resolvedModel, batchMode };
}
