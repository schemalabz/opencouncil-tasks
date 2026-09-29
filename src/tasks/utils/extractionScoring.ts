import { normalizeGreekName, changeAnchor, sameGreekPerson, type AgendaItemRef, type RawExtractedDecision, type VoteValue } from './decisionPdfExtraction.js';
import { sameDecisionNumber } from './decisionNumberCompare.js';

/**
 * Scores the production extractor against `fixtures/extraction-golden.json`.
 *
 * One outcome per field, never one per document: a page whose roll call is
 * right and whose votes are wrong is one of each, and the aggregate has to say
 * which field is weak. Labels carry their own `verified`; a contested label
 * (`false`) counts for neither side until the review round settles it.
 */

/**
 * true: a person confirmed the value. "adjudicated": settled by reading the
 * page, with the sentence that settled it kept in `evidence` — above "agreed",
 * because two readings agree when they share a blind spot, and below true.
 * "agreed": two independent readings matched. "baseline": free text held as-is.
 * false: contested, awaiting review. "unresolvable": reviewed, and the page
 * cannot settle it.
 */
export type LabelState = true | 'adjudicated' | 'agreed' | 'baseline' | 'unresolvable' | false;

/** The page's own words behind an `"adjudicated"` label, so the change can be audited and undone. */
export interface LabelEvidence {
    /** Verbatim from the page, in the spelling it prints. */
    quote: string;
    /** The document the quote was read from. */
    ada: string;
    /** 1-based page the quote is on. */
    page: number;
    /** ISO-8601 instant the adjudication produced the verdict. */
    adjudicatedAt: string;
}

export type FieldOutcome =
    | 'agree'
    | 'disagree'
    /** The extractor returned nothing where the label holds a value. */
    | 'missing'
    /** Label is `verified: false` — the review round has not settled it. */
    | 'contested'
    /** Label is `verified: "unresolvable"` — reviewed, and the page cannot settle it. */
    | 'unlabelled';

export const FIELDS = ['rollCall', 'attendanceChanges', 'perVoteAbsence', 'votes', 'subject', 'excerpt', 'mayor', 'presidedBy', 'decisionAttendance'] as const;
export type Field = (typeof FIELDS)[number];

/**
 * What the page ties a stated change to. `nothing` is a value, not a gap: the
 * page states an arrival or a departure in prose and gives it no reference of
 * any kind. A page that states no change at all carries no anchor.
 */
export const LABEL_ANCHORS = ['agenda_item', 'decision_number', 'phase', 'this_document', 'nothing'] as const;
export type LabelAnchorKind = (typeof LABEL_ANCHORS)[number];

/** Labels seeded before the vocabulary settled spell `phase` as `session_phase`. */
export const STORED_LABEL_ANCHORS = [...LABEL_ANCHORS, 'session_phase'] as const;
export type StoredLabelAnchor = (typeof STORED_LABEL_ANCHORS)[number];

/** One arrival or departure as the label holds it. */
export interface LabelledChange {
    name: string | null;
    type: 'arrival' | 'departure' | null;
    agendaItem: AgendaItemRef | null;
    timing: 'during' | 'after' | null;
}

/**
 * What a page states about arrivals and departures.
 *
 * Discriminated on `stated`, so a label cannot say the page records no change
 * and list some at the same time. That combination used to be representable and
 * no scorer read `stated`, so such a label silently scored its list anyway.
 * `asExtracted` may be empty under `stated: true`: the page states changes and
 * the extractor that seeded the label lost them all, which is the disagreement
 * the review round is for.
 */
export type AttendanceChangesLabel = { verified: LabelState; evidence?: LabelEvidence } & (
    | { stated: false; anchoredBy?: never; asExtracted?: never }
    | { stated: true; anchoredBy: StoredLabelAnchor; asExtracted: LabelledChange[] }
);

export interface ExtractionLabel {
    rollCall: {
        presentMembers: string[];
        absentMembers: string[];
        verified: LabelState;
        /** Present only on `verified: "adjudicated"`. */
        evidence?: LabelEvidence;
    };
    attendanceChanges: AttendanceChangesLabel;
    votes: {
        phraseAsPrinted: string | null;
        carriesTally: boolean;
        namedVoters: 'none' | 'dissenters_only' | 'all';
        asExtracted: Array<{ name: string | null; vote: VoteValue | null }>;
        verified: LabelState;
        /** Present only on `verified: "adjudicated"`. */
        evidence?: LabelEvidence;
    };
    /** The mayor's presence as the page states it; absent from labels that were never reviewed for it. */
    mayor?: { present: boolean; verified: LabelState; evidence?: LabelEvidence };
    /** Who the page says presided in the mayor's or president's place; `name: null` when the page says nobody did. Absent from labels never reviewed for it. */
    presidedBy?: { name: string | null; verified: LabelState; evidence?: LabelEvidence };
    /** The page's own list of who was present for THIS decision (ΤΑ ΜΕΛΗ after the decision text); `members: null` when the page prints none. Absent from labels never reviewed for it. */
    decisionAttendance?: { members: string[] | null; verified: LabelState; evidence?: LabelEvidence };
    /** The decision's own number as printed («ΠΡΑΞΗ 95», «Αριθμός Απόφασης 167/2026»), never the protocol number. Not scored yet: the pages that carry it stored text as their number (C8). */
    decisionNumber?: { number: string; verified: LabelState; evidence?: LabelEvidence };
    subject: {
        agendaItemNumber: number | null;
        isOutOfAgenda: boolean;
        verified: LabelState;
        /** Present only on `verified: "adjudicated"`. */
        evidence?: LabelEvidence;
    };
    excerpt: {
        chars: number;
        extractionFlaggedIncomplete: boolean;
        verified: LabelState;
        /** Present only on `verified: "adjudicated"`. */
        evidence?: LabelEvidence;
    };
    /** Members the page says were absent for this decision's vote; absent when the page states none. */
    perVoteAbsence?: {
        /** Out for this decision's own vote («Κατά τη διαδικασία της ψηφοφορίας απουσίαζε…»). */
        members: string[];
        /**
         * Out for decisions the page names by number («Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ ο κ. …»),
         * one entry per person. The reader keeps these pinned to the numbers, so they are compared
         * here and never with `members`, whether or not the range covers this decision.
         * `decisionNumberTo` is null when the page names one decision.
         */
        byDecisionNumber?: Array<{ name: string; decisionNumber: string; decisionNumberTo: string | null }>;
        verified: LabelState;
        /** Present only on `verified: "adjudicated"`. */
        evidence?: LabelEvidence;
    };
}

export interface FieldScore {
    outcome: FieldOutcome;
    /** Human-readable account of the difference; empty on agree. */
    detail: string;
}

export type DocumentScore = Record<Field, FieldScore>;

/** Excerpt length may drift this much against its baseline before it counts as changed. */
export const EXCERPT_DRIFT_TOLERANCE = 0.15;

const nameSet = (names: Array<string | null | undefined>): Set<string> =>
    new Set(names.filter((n): n is string => !!n).map(normalizeGreekName));

/**
 * Set difference over names. A key that is not a name (a vote or change key
 * with a prefix) compares exactly; a bare name matches its abbreviated or
 * middle-name form the way the pipeline matches it, so «Αθανασάκης Σ.» in
 * one list and «Σπύρος Αθανασάκης» in the other is not a disagreement.
 */
function setDiff(label: Set<string>, got: Set<string>): { onlyLabel: string[]; onlyGot: string[] } {
    const same = (a: string, b: string) => a === b || sameGreekPerson(a, b) || sameGreekPerson(b, a);
    return {
        onlyLabel: [...label].filter((n) => ![...got].some((g) => same(n, g))),
        onlyGot: [...got].filter((n) => ![...label].some((l) => same(n, l))),
    };
}

const describeDiff = (what: string, d: { onlyLabel: string[]; onlyGot: string[] }): string =>
    [
        d.onlyLabel.length ? `${what} lost: ${d.onlyLabel.join(', ')}` : '',
        d.onlyGot.length ? `${what} extra: ${d.onlyGot.join(', ')}` : '',
    ].filter(Boolean).join('; ');

function gate(state: LabelState): FieldOutcome | null {
    if (state === false) return 'contested';
    if (state === 'unresolvable') return 'unlabelled';
    return null;
}

export function scoreRollCall(label: ExtractionLabel['rollCall'], got: RawExtractedDecision | null): FieldScore {
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    const wantPresent = nameSet(label.presentMembers);
    const wantAbsent = nameSet(label.absentMembers);
    if (!got || (got.presentMembers.length === 0 && got.absentMembers.length === 0)) {
        return wantPresent.size + wantAbsent.size === 0
            ? { outcome: 'agree', detail: '' }
            : { outcome: 'missing', detail: 'no roll call extracted' };
    }
    const dp = setDiff(wantPresent, nameSet(got.presentMembers));
    const da = setDiff(wantAbsent, nameSet(got.absentMembers));
    const detail = [describeDiff('present', dp), describeDiff('absent', da)].filter(Boolean).join('; ');
    return { outcome: detail ? 'disagree' : 'agree', detail };
}

const anchorKey = (item: AgendaItemRef | null, timing: string | null): string =>
    item ? `${timing ?? ''} ${item.nonAgendaReason === 'outOfAgenda' ? 'OA' : '#'}${item.agendaItemIndex}` : 'session';

export function scoreAttendanceChanges(label: ExtractionLabel['attendanceChanges'], got: RawExtractedDecision | null): FieldScore {
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    const sessionChanges = (got?.attendanceChanges ?? []).filter(c => c.type !== 'absent_for_vote');
    // A page that records no arrival or departure: anything the extractor
    // returned is invented, and there is no anchor to compare.
    if (!label.stated) {
        return sessionChanges.length === 0
            ? { outcome: 'agree', detail: '' }
            : { outcome: 'disagree', detail: `changes extra: ${sessionChanges.length} where the page states none` };
    }
    // The anchor is part of the fact: a departure "after #5" and one "during #5"
    // put the member on opposite sides of that item's vote.
    // A change is the person and the direction. Its position is compared only
    // when both sides pin it to an agenda item; a decision number, a clock time
    // or a phase is checked as an anchor kind below, because labels seeded
    // from the old extractor cannot spell those values.
    // Labels written before the vocabulary settled say session_phase; the page's anchor is the phase.
    const anchoredBy: LabelAnchorKind = label.anchoredBy === 'session_phase' ? 'phase' : label.anchoredBy;
    const labelKey = (c: { name: string | null; type: string | null; agendaItem: AgendaItemRef | null; timing: string | null }) => {
        const positional = anchoredBy === 'agenda_item';
        return `${c.type} ${c.name ? normalizeGreekName(c.name) : '?'}${positional ? ` @ ${anchorKey(c.agendaItem, c.timing)}` : ''}`;
    };
    const key = (c: { name: string | null; type: string | null; agendaItem: AgendaItemRef | null; timing: string | null; anchor?: { kind: string } }) => {
        const positional = anchoredBy === 'agenda_item' && (!c.anchor || c.anchor.kind === 'agenda_item' || c.anchor.kind === 'session_start' || c.anchor.kind === 'session_end');
        return `${c.type} ${c.name ? normalizeGreekName(c.name) : '?'}${positional ? ` @ ${anchorKey(c.agendaItem, c.timing)}` : ''}`;
    };
    const want = new Set(label.asExtracted.map(labelKey));
    const have = new Set(sessionChanges.map(key));
    if (want.size > 0 && have.size === 0) return { outcome: 'missing', detail: `${want.size} change(s) lost` };
    const d = setDiff(want, have);
    const problems: string[] = [];
    const diff = describeDiff('changes', d);
    if (diff) problems.push(diff);
    // The anchor is a fact of its own: a change pinned to a decision number
    // that comes back pinned to an agenda item will be replayed wrongly.
    //
    // `this_document` used to be exempt because a per-vote absence carries that
    // anchor and is filtered out above, so the check had nothing to look at. But
    // Argos states «είχαν αποχωρήσει … κατά την λήψη της παρούσας απόφασης» and
    // prints an ΑΠΟΧΩΡΗΣΑΝΤΕΣ list, which are ordinary departures pinned to this
    // document's own item. Exempting the kind meant the scorer agreed with a
    // reading that left them unanchored, where `changeAnchor` makes them
    // `session_end` and the replay places them after every subject — the member
    // is derived present for the very decision the page says they missed.
    if (anchoredBy !== 'nothing' && sessionChanges.length > 0) {
        const kinds = new Set(sessionChanges.map(c => changeAnchor(c).kind));
        if (!kinds.has(anchoredBy)) problems.push(`anchor: page ${anchoredBy}, extracted ${[...kinds].join('/')}`);
    }
    return { outcome: problems.length ? 'disagree' : 'agree', detail: problems.join('; ') };
}

/** Whether the page says the mayor was present; scored only where the fixture carries a `mayor` label. */
export function scoreMayor(label: ExtractionLabel['mayor'] | undefined, got: RawExtractedDecision | null): FieldScore {
    if (!label) return { outcome: 'unlabelled', detail: '' };
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    if (!got || got.mayorPresent == null) return { outcome: 'missing', detail: 'mayor not read' };
    return got.mayorPresent.present === label.present
        ? { outcome: 'agree', detail: '' }
        : { outcome: 'disagree', detail: `page ${label.present ? 'present' : 'absent'}, extracted ${got.mayorPresent.present ? 'present' : 'absent'}` };
}

/**
 * Whoever the page says chaired in the president's or mayor's place. The
 * derivation exempts that person from the per-decision list, so a misread here
 * seats or unseats a councillor for a whole session.
 */
export function scorePresidedBy(label: ExtractionLabel['presidedBy'] | undefined, got: RawExtractedDecision | null): FieldScore {
    if (!label) return { outcome: 'unlabelled', detail: '' };
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    if (!got) return { outcome: 'missing', detail: 'nothing read' };
    const have = got.presidedBy?.name ?? null;
    if (label.name === null) return have === null ? { outcome: 'agree', detail: '' } : { outcome: 'disagree', detail: `page names nobody presiding, extracted ${have}` };
    if (have === null) return { outcome: 'missing', detail: `page says ${label.name} presided` };
    return (sameGreekPerson(label.name, have) || sameGreekPerson(have, label.name)) ? { outcome: 'agree', detail: '' } : { outcome: 'disagree', detail: `page ${label.name}, extracted ${have}` };
}

/** ΤΑ ΜΕΛΗ after the decision text: the list the derivation takes as this decision's attendance where the body prints one. */
export function scoreDecisionAttendance(label: ExtractionLabel['decisionAttendance'] | undefined, got: RawExtractedDecision | null): FieldScore {
    if (!label) return { outcome: 'unlabelled', detail: '' };
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    if (!got) return { outcome: 'missing', detail: 'nothing read' };
    const have = nameSet(got.decisionAttendance?.present ?? []);
    if (label.members === null) return have.size === 0 ? { outcome: 'agree', detail: '' } : { outcome: 'disagree', detail: `page prints no list, extracted ${have.size} names` };
    const want = nameSet(label.members);
    if (want.size > 0 && have.size === 0) return { outcome: 'missing', detail: `${want.size}-name list lost` };
    const detail = describeDiff('listed', setDiff(want, have));
    return { outcome: detail ? 'disagree' : 'agree', detail };
}

/**
 * «Κατά τη διαδικασία της ψηφοφορίας απουσίαζε…»: who the page excludes from this vote.
 * An absence the reader pins to decision numbers is compared with `byDecisionNumber`,
 * the range included, because the replay places it on those decisions and not on this one.
 */
export function scorePerVoteAbsence(label: ExtractionLabel['perVoteAbsence'] | undefined, got: RawExtractedDecision | null): FieldScore {
    if (!label) return { outcome: 'unlabelled', detail: '' };
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    const absences = (got?.attendanceChanges ?? []).filter(c => c.type === 'absent_for_vote');
    const numbered = absences.filter(c => changeAnchor(c).kind === 'decision_number').map(c => {
        const a = changeAnchor(c);
        return { name: c.name, decisionNumber: a.decisionNumber ?? '', decisionNumberTo: a.decisionNumberTo ?? null };
    });
    const want = nameSet(label.members);
    const have = nameSet(absences.filter(c => changeAnchor(c).kind !== 'decision_number').map(c => c.name));
    const wantNumbered = label.byDecisionNumber ?? [];
    if (want.size + wantNumbered.length > 0 && have.size + numbered.length === 0) {
        return { outcome: 'missing', detail: `${want.size + wantNumbered.length} absent-for-vote lost` };
    }
    type Numbered = { name: string; decisionNumber: string; decisionNumberTo: string | null };
    const lastOf = (n: Numbered) => n.decisionNumberTo ?? n.decisionNumber;
    const span = (n: Numbered) => `${n.decisionNumber}–${lastOf(n)}`;
    // A label writes "31" where the page prints "31/2026"; the number before the slash decides.
    const sameNumber = (x: string, y: string) => x === y || sameDecisionNumber(x, y);
    const same = (a: Numbered, b: Numbered) => sameNumber(a.decisionNumber, b.decisionNumber) && sameNumber(lastOf(a), lastOf(b))
        && (sameGreekPerson(a.name, b.name) || sameGreekPerson(b.name, a.name));
    const show = (n: Numbered) => `${normalizeGreekName(n.name)} @ ${span(n)}`;
    const numberedDiff = {
        onlyLabel: wantNumbered.filter(w => !numbered.some(h => same(w, h))).map(show),
        onlyGot: numbered.filter(h => !wantNumbered.some(w => same(w, h))).map(show),
    };
    const detail = [describeDiff('absent for vote', setDiff(want, have)), describeDiff('absent by number', numberedDiff)].filter(Boolean).join('; ');
    return { outcome: detail ? 'disagree' : 'agree', detail };
}

/**
 * The page names dissenters and declarers; it almost never names who voted for.
 * A FOR the page does not print is not the task's to state, so FOR entries are
 * compared only where the page listed every voter.
 */
export function scoreVotes(label: ExtractionLabel['votes'], got: RawExtractedDecision | null): FieldScore {
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    const problems: string[] = [];
    if (label.phraseAsPrinted && !got?.voteResult) {
        return { outcome: 'missing', detail: `vote phrase lost («${label.phraseAsPrinted}»)` };
    }
    const tallyInStructured = Object.values(got?.voteTally ?? {}).some(v => typeof v === 'number');
    if (label.carriesTally && got?.voteResult && !/\d/.test(got.voteResult) && !tallyInStructured) {
        problems.push(`tally dropped from «${label.phraseAsPrinted}» → «${got.voteResult}»`);
    }
    const compare = (v: { vote: VoteValue | null }) => label.namedVoters === 'all' || v.vote !== 'FOR';
    const key = (v: { name: string | null; vote: VoteValue | null }) => `${v.vote} ${v.name ? normalizeGreekName(v.name) : '?'}`;
    const want = new Set(label.asExtracted.filter(compare).map(key));
    const have = new Set((got?.voteDetails ?? []).filter(compare).map(key));
    const d = describeDiff('voters', setDiff(want, have));
    if (d) problems.push(d);
    return { outcome: problems.length ? 'disagree' : 'agree', detail: problems.join('; ') };
}

/** Null is a correct answer: three bodies never print an item number. */
export function scoreSubject(label: ExtractionLabel['subject'], got: RawExtractedDecision | null): FieldScore {
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    const info = got?.subjectInfo ?? null;
    const gotNumber = info?.agendaItemIndex ?? null;
    const gotOA = info?.nonAgendaReason === 'outOfAgenda';
    const fmt = (n: number | null, oa: boolean) => (n == null ? 'none' : `${oa ? 'OA' : '#'}${n}`);
    if (gotNumber === label.agendaItemNumber && (gotNumber == null || gotOA === label.isOutOfAgenda)) {
        return { outcome: 'agree', detail: '' };
    }
    return {
        outcome: 'disagree',
        detail: `page ${fmt(label.agendaItemNumber, label.isOutOfAgenda)}, extracted ${fmt(gotNumber, gotOA)}`,
    };
}

/**
 * Free text cannot be scored by equality; the baseline holds today's length
 * so a future run that drops or doubles the text shows up as changed.
 */
export function scoreExcerpt(label: ExtractionLabel['excerpt'], got: RawExtractedDecision | null): FieldScore {
    const gated = gate(label.verified);
    if (gated) return { outcome: gated, detail: '' };
    const chars = got?.decisionExcerpt?.length ?? 0;
    // A person confirmed the text is on the page but not its length: presence is the fact.
    if (label.verified === true) {
        if (chars === 0) return { outcome: 'missing', detail: 'no excerpt' };
        const flagged = !!got?.incomplete;
        return flagged === label.extractionFlaggedIncomplete
            ? { outcome: 'agree', detail: '' }
            : { outcome: 'disagree', detail: `incomplete ${label.extractionFlaggedIncomplete} → ${flagged}` };
    }
    if (chars === 0 && label.chars > 0) return { outcome: 'missing', detail: 'no excerpt' };
    const drift = label.chars === 0 ? (chars === 0 ? 0 : 1) : Math.abs(chars - label.chars) / label.chars;
    const flagged = !!got?.incomplete;
    const problems: string[] = [];
    if (drift > EXCERPT_DRIFT_TOLERANCE) problems.push(`length ${label.chars} → ${chars}`);
    if (flagged !== label.extractionFlaggedIncomplete) problems.push(`incomplete ${label.extractionFlaggedIncomplete} → ${flagged}`);
    return { outcome: problems.length ? 'disagree' : 'agree', detail: problems.join('; ') };
}

export function scoreDocument(label: ExtractionLabel, got: RawExtractedDecision | null): DocumentScore {
    return {
        rollCall: scoreRollCall(label.rollCall, got),
        attendanceChanges: scoreAttendanceChanges(label.attendanceChanges, got),
        perVoteAbsence: scorePerVoteAbsence(label.perVoteAbsence, got),
        votes: scoreVotes(label.votes, got),
        subject: scoreSubject(label.subject, got),
        excerpt: scoreExcerpt(label.excerpt, got),
        mayor: scoreMayor(label.mayor, got),
        presidedBy: scorePresidedBy(label.presidedBy, got),
        decisionAttendance: scoreDecisionAttendance(label.decisionAttendance, got),
    };
}

export type FieldTally = Record<FieldOutcome, number>;

export function tallyScores(scores: DocumentScore[]): Record<Field, FieldTally> {
    const out = {} as Record<Field, FieldTally>;
    for (const f of FIELDS) {
        out[f] = { agree: 0, disagree: 0, missing: 0, contested: 0, unlabelled: 0 };
        for (const s of scores) out[f][s[f].outcome]++;
    }
    return out;
}
