import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
    scoreRollCall, scoreAttendanceChanges, scorePerVoteAbsence, scoreVotes, scoreSubject, scoreExcerpt, scoreMayor, scorePresidedBy, scoreDecisionAttendance, tallyScores, scoreDocument,
    STORED_LABEL_ANCHORS,
    type ExtractionLabel, type StoredLabelAnchor,
} from './extractionScoring.js';
import type { RawExtractedDecision } from './decisionPdfExtraction.js';

const extraction = (over: Partial<RawExtractedDecision> = {}): RawExtractedDecision => ({
    presentMembers: [], absentMembers: [], mayorPresent: null, decisionExcerpt: '', decisionNumber: null,
    references: '', voteResult: null, voteDetails: [], attendanceChanges: [], discussionOrder: null,
    subjectInfo: null, incomplete: false, attendanceFormat: 'explicit_present_absent', compositionMembers: null, presidedBy: null, actingSecretary: null, subjectHeading: '', decisionAttendance: null,
    voteTally: { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null }, ...over,
});

describe('scoreRollCall', () => {
    it('matches names through tonos and nickname differences, the way the pipeline does', () => {
        const label: ExtractionLabel['rollCall'] = {
            presentMembers: ['ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ (ΓΙΩΡΓΟΣ)'], absentMembers: ['Κορλού Όλγα'], verified: 'agreed',
        };
        const got = extraction({ presentMembers: ['Παπαδόπουλος Γεώργιος'], absentMembers: ['ΚΟΡΛΟΥ ΟΛΓΑ'] });
        expect(scoreRollCall(label, got).outcome).toBe('agree');
    });

    it('names who was lost and who was invented', () => {
        const label: ExtractionLabel['rollCall'] = { presentMembers: ['Α Β', 'Γ Δ'], absentMembers: [], verified: true };
        const s = scoreRollCall(label, extraction({ presentMembers: ['Α Β', 'Ε Ζ'] }));
        expect(s.outcome).toBe('disagree');
        expect(s.detail).toContain('lost: γ δ');
        expect(s.detail).toContain('extra: ε ζ');
    });

    it('does not count a contested label for either side', () => {
        const label: ExtractionLabel['rollCall'] = { presentMembers: ['Α Β'], absentMembers: [], verified: false };
        expect(scoreRollCall(label, extraction()).outcome).toBe('contested');
    });
});

describe('scoreAttendanceChanges', () => {
    const departure = { name: 'Κορλού Όλγα', type: 'departure' as const, agendaItem: { agendaItemIndex: 5, nonAgendaReason: null }, timing: 'after' as const };
    it('treats the anchor as part of the fact', () => {
        const label: ExtractionLabel['attendanceChanges'] = { stated: true, anchoredBy: 'agenda_item', asExtracted: [departure], verified: 'agreed' };
        const during = extraction({ attendanceChanges: [{ ...departure, timing: 'during', rawText: '' }] });
        expect(scoreAttendanceChanges(label, during).outcome).toBe('disagree');
    });
    it('reports a stated change the extractor returned nothing for as missing', () => {
        const label: ExtractionLabel['attendanceChanges'] = { stated: true, anchoredBy: 'agenda_item', asExtracted: [departure], verified: 'agreed' };
        expect(scoreAttendanceChanges(label, extraction()).outcome).toBe('missing');
    });
});

describe('anchors and per-vote absence', () => {
    it('a change the page pins to a decision number must come back so pinned', () => {
        const label: ExtractionLabel['attendanceChanges'] = {
            stated: true, anchoredBy: 'decision_number',
            asExtracted: [{ name: 'Λυδία Βέρα', type: 'departure', agendaItem: null, timing: null }], verified: true,
        };
        const asItem = extraction({ attendanceChanges: [{ name: 'Λυδία Βέρα', type: 'departure', agendaItem: null, timing: null, rawText: '' }] });
        expect(scoreAttendanceChanges(label, asItem).detail).toContain('anchor: page decision_number');
        const pinned = extraction({ attendanceChanges: [{ name: 'Λυδία Βέρα', type: 'departure', agendaItem: null, timing: null, rawText: '',
            anchor: { kind: 'decision_number', agendaItem: null, decisionNumber: '286', phase: null, timing: 'during' } }] });
        expect(scoreAttendanceChanges(label, pinned).outcome).toBe('agree');
    });
    it('per-vote absence is scored on its own and ignored by the session changes', () => {
        const label: ExtractionLabel['perVoteAbsence'] = { members: ['Γεώργιος Ρεμούνδος'], verified: true };
        const got = extraction({ attendanceChanges: [{ name: 'Γεώργιος Ρεμούνδος', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: '' }] });
        expect(scorePerVoteAbsence(label, got).outcome).toBe('agree');
        expect(scorePerVoteAbsence(label, extraction()).outcome).toBe('missing');
        expect(scoreAttendanceChanges({ stated: false, verified: true }, got).outcome).toBe('agree');
    });
    // ΡΟΨΘΩ6Μ-2Υ8 is decision 3; its roll call says «Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ ο κ. Εμμ. Βελεγράκης».
    it('an absence the page states for a range of decisions is compared by its numbers, not with this decision', () => {
        const label: ExtractionLabel['perVoteAbsence'] = {
            members: [], byDecisionNumber: [{ name: 'Βελεγράκης Εμμανουήλ', decisionNumber: '31', decisionNumberTo: '40' }], verified: 'adjudicated',
        };
        const change = (anchor: NonNullable<RawExtractedDecision['attendanceChanges'][number]['anchor']>) =>
            extraction({ attendanceChanges: [{ name: 'Εμμ. Βελεγράκης', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: '', anchor }] });
        const ranged = { kind: 'decision_number' as const, agendaItem: null, decisionNumber: '31', decisionNumberTo: '40', phase: null, timing: null };
        expect(scorePerVoteAbsence(label, change(ranged)).outcome).toBe('agree');

        const onThisDecision = scorePerVoteAbsence(label, change({ ...ranged, kind: 'this_document', decisionNumber: null, decisionNumberTo: null }));
        expect(onThisDecision.outcome).toBe('disagree');
        expect(onThisDecision.detail).toContain('absent for vote extra: εμμ. βελεγρακης');

        const oneDecision = scorePerVoteAbsence(label, change({ ...ranged, decisionNumberTo: null }));
        expect(oneDecision.detail).toContain('absent by number lost: βελεγρακης εμμανουηλ @ 31–40');
        expect(scorePerVoteAbsence(label, extraction()).outcome).toBe('missing');
    });

    it('compares the ends of a range by their numbers, whether or not they carry the year', () => {
        const label: ExtractionLabel['perVoteAbsence'] = {
            members: [], byDecisionNumber: [{ name: 'Βελεγράκης Εμμανουήλ', decisionNumber: '31', decisionNumberTo: '40' }], verified: 'adjudicated',
        };
        const change = (decisionNumber: string, decisionNumberTo: string | null) => extraction({ attendanceChanges: [{
            name: 'Εμμ. Βελεγράκης', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: '',
            anchor: { kind: 'decision_number', agendaItem: null, decisionNumber, decisionNumberTo, phase: null, timing: null },
        }] });
        expect(scorePerVoteAbsence(label, change('31/2026', '40/2026')).outcome).toBe('agree');
        expect(scorePerVoteAbsence(label, change('31/2026', '41/2026')).outcome).toBe('disagree');
        expect(scorePerVoteAbsence(label, change('310/2026', '40/2026')).outcome).toBe('disagree');
    });
});

describe('scoreVotes', () => {
    const base: ExtractionLabel['votes'] = {
        phraseAsPrinted: 'Κατά πλειοψηφία', carriesTally: false, namedVoters: 'dissenters_only',
        asExtracted: [{ name: 'Α Β', vote: 'AGAINST' }], verified: 'agreed',
    };
    it('ignores FOR entries when the page only names dissenters', () => {
        const got = extraction({ voteResult: 'Κατά πλειοψηφία', voteDetails: [{ name: 'Α Β', vote: 'AGAINST' }, { name: 'Γ Δ', vote: 'FOR' }] });
        expect(scoreVotes(base, got).outcome).toBe('agree');
    });
    it('a dropped dissenter is a disagreement, not a lost value', () => {
        const got = extraction({ voteResult: 'Κατά πλειοψηφία', voteDetails: [] });
        const s = scoreVotes(base, got);
        expect(s.outcome).toBe('disagree');
        expect(s.detail).toContain('AGAINST α β');
    });
    it('a declaration stored as a vote is a disagreement', () => {
        const label = { ...base, asExtracted: [{ name: 'Α Β', vote: 'PRESENT' as const }] };
        const got = extraction({ voteResult: 'Κατά πλειοψηφία', voteDetails: [{ name: 'Α Β', vote: 'AGAINST' }] });
        expect(scoreVotes(label, got).outcome).toBe('disagree');
    });
    it('a tally the page prints must survive into the phrase', () => {
        const label = { ...base, phraseAsPrinted: 'με 12 υπέρ και 3 κατά', carriesTally: true };
        expect(scoreVotes(label, extraction({ voteResult: 'Κατά πλειοψηφία', voteDetails: [{ name: 'Α Β', vote: 'AGAINST' }] })).outcome).toBe('disagree');
        expect(scoreVotes(label, extraction({ voteResult: 'με 12 υπέρ και 3 κατά', voteDetails: [{ name: 'Α Β', vote: 'AGAINST' }] })).outcome).toBe('agree');
    });
});

describe('scoreSubject', () => {
    it('null is the right answer when the page prints no number', () => {
        const label: ExtractionLabel['subject'] = { agendaItemNumber: null, isOutOfAgenda: true, verified: true };
        expect(scoreSubject(label, extraction()).outcome).toBe('agree');
        const invented = extraction({ subjectInfo: { agendaItemIndex: 1, nonAgendaReason: 'outOfAgenda' } });
        expect(scoreSubject(label, invented)).toEqual({ outcome: 'disagree', detail: 'page none, extracted OA1' });
    });
    it('the same number as a regular item and as an out-of-agenda item are different answers', () => {
        const label: ExtractionLabel['subject'] = { agendaItemNumber: 2, isOutOfAgenda: true, verified: true };
        expect(scoreSubject(label, extraction({ subjectInfo: { agendaItemIndex: 2, nonAgendaReason: null } })).outcome).toBe('disagree');
    });
});

describe('scoreExcerpt', () => {
    const label: ExtractionLabel['excerpt'] = { chars: 1000, extractionFlaggedIncomplete: false, verified: 'baseline' };
    it('tolerates small drift and flags a large one', () => {
        expect(scoreExcerpt(label, extraction({ decisionExcerpt: 'x'.repeat(1100) })).outcome).toBe('agree');
        expect(scoreExcerpt(label, extraction({ decisionExcerpt: 'x'.repeat(400) })).outcome).toBe('disagree');
        expect(scoreExcerpt(label, extraction()).outcome).toBe('missing');
    });
});

describe('label states', () => {
    it('an unresolvable label counts for neither side', () => {
        const label: ExtractionLabel['votes'] = { phraseAsPrinted: null, carriesTally: false, namedVoters: 'none', asExtracted: [], verified: 'unresolvable' };
        expect(scoreVotes(label, extraction()).outcome).toBe('unlabelled');
    });
    it('an adjudicated label is scored like any other', () => {
        const label: ExtractionLabel['subject'] = { agendaItemNumber: 2, isOutOfAgenda: false, verified: 'adjudicated' };
        expect(scoreSubject(label, extraction({ subjectInfo: { agendaItemIndex: 2, nonAgendaReason: null } })).outcome).toBe('agree');
        expect(scoreSubject(label, extraction({ subjectInfo: { agendaItemIndex: 3, nonAgendaReason: null } })).outcome).toBe('disagree');
    });
    it('a confirmed excerpt is scored on presence, not length', () => {
        const label: ExtractionLabel['excerpt'] = { chars: 0, extractionFlaggedIncomplete: false, verified: true };
        expect(scoreExcerpt(label, extraction({ decisionExcerpt: 'x'.repeat(3000) })).outcome).toBe('agree');
        expect(scoreExcerpt(label, extraction()).outcome).toBe('missing');
    });
});

describe('tallyScores', () => {
    it('counts per field, not per document', () => {
        const label: ExtractionLabel = {
            rollCall: { presentMembers: ['Α Β'], absentMembers: [], verified: 'agreed' },
            attendanceChanges: { stated: false, verified: 'agreed' },
            votes: { phraseAsPrinted: 'Ομόφωνα', carriesTally: false, namedVoters: 'none', asExtracted: [], verified: false },
            subject: { agendaItemNumber: 3, isOutOfAgenda: false, verified: 'agreed' },
            excerpt: { chars: 10, extractionFlaggedIncomplete: false, verified: 'baseline' },
        };
        const got = extraction({ presentMembers: ['Α Β'], voteResult: 'Ομόφωνα', decisionExcerpt: 'x'.repeat(10) });
        const t = tallyScores([scoreDocument(label, got)]);
        expect(t.rollCall.agree).toBe(1);
        expect(t.votes.contested).toBe(1);
        expect(t.subject.disagree).toBe(1);
    });
});

describe('scorePresidedBy', () => {
    it('is unlabelled until a page was reviewed for it', () => {
        expect(scorePresidedBy(undefined, extraction()).outcome).toBe('unlabelled');
    });
    it('a page naming nobody agrees only with an empty reading', () => {
        expect(scorePresidedBy({ name: null, verified: true }, extraction()).outcome).toBe('agree');
        // Argos 99ΣΔΩΨΔ-4ΗΚ: the deputy mayor stood in for the mayor; the reader once called that presiding.
        expect(scorePresidedBy({ name: null, verified: true }, extraction({ presidedBy: { name: 'Παναγιώτης Καμπόσος', rawText: '' } })).outcome).toBe('disagree');
    });
    it('matches the chair through case and name order', () => {
        const got = extraction({ presidedBy: { name: 'ΜΕΤΙΚΑΡΙΔΗΣ ΘΕΟΔΩΡΟΣ', rawText: '' } });
        expect(scorePresidedBy({ name: 'Θεόδωρος Μετικαρίδης', verified: true }, got).outcome).toBe('agree');
        expect(scorePresidedBy({ name: 'Τίνα Καφατσάκη', verified: true }, extraction()).outcome).toBe('missing');
    });
});

describe('scoreDecisionAttendance', () => {
    it('a page with no list agrees only with an empty reading', () => {
        expect(scoreDecisionAttendance({ members: null, verified: true }, extraction()).outcome).toBe('agree');
        expect(scoreDecisionAttendance({ members: null, verified: true }, extraction({ decisionAttendance: { present: ['Α Β'], rawText: '' } })).outcome).toBe('disagree');
    });
    it('compares the list as a set of names and says who differs', () => {
        const label = { members: ['Α Β', 'Γ Δ'], verified: true as const };
        expect(scoreDecisionAttendance(label, extraction({ decisionAttendance: { present: ['Γ Δ', 'Α Β'], rawText: '' } })).outcome).toBe('agree');
        const s = scoreDecisionAttendance(label, extraction({ decisionAttendance: { present: ['Α Β', 'Ε Ζ'], rawText: '' } }));
        expect(s.outcome).toBe('disagree'); expect(s.detail).toContain('γ δ'); expect(s.detail).toContain('ε ζ');
        expect(scoreDecisionAttendance(label, extraction()).outcome).toBe('missing');
    });
});

describe('scoreMayor', () => {
    it('is unlabelled without a label, missing when the page was not read for it', () => {
        expect(scoreMayor(undefined, extraction()).outcome).toBe('unlabelled');
        expect(scoreMayor({ present: true, verified: true }, extraction()).outcome).toBe('missing');
    });
    it('agrees and disagrees on the flag', () => {
        const got = extraction({ mayorPresent: { present: false, rawText: 'Απουσίαζε η Δήμαρχος' } });
        expect(scoreMayor({ present: false, verified: 'agreed' }, got).outcome).toBe('agree');
        expect(scoreMayor({ present: true, verified: 'agreed' }, got)).toEqual({ outcome: 'disagree', detail: 'page present, extracted absent' });
    });
    it('a legacy session_phase label scores a phase anchor as agreeing', () => {
        const label: ExtractionLabel['attendanceChanges'] = { stated: true, anchoredBy: 'session_phase', verified: 'agreed',
            asExtracted: [{ name: 'Λυδία Βέρα', type: 'arrival' as const, agendaItem: null, timing: null }] };
        const got = extraction({ attendanceChanges: [{ name: 'Λυδία Βέρα', type: 'arrival', agendaItem: null, timing: null, rawText: '',
            anchor: { kind: 'phase', agendaItem: null, decisionNumber: null, phase: 'pre_agenda', timing: null } }] });
        expect(scoreAttendanceChanges(label, got).outcome).toBe('agree');
    });
});

describe('scoreVotes with a structured tally', () => {
    it('a count that moved from the phrase into voteTally still counts as carried', () => {
        const label = { phraseAsPrinted: 'Εγκρίνεται με ΥΠΕΡ: 10 ψήφους', carriesTally: true, namedVoters: 'none' as const, asExtracted: [], verified: 'agreed' as const };
        const got = extraction({ voteResult: 'ΟΜΟΦΩΝΑ', voteTally: { FOR: 10, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null } });
        expect(scoreVotes(label, got).outcome).toBe('agree');
    });
});

// ===========================================================================
// The fixture is the scorer's only ground truth, and the label type disciplines
// the TypeScript that reads it, never the JSON on disk. The shapes it forbids
// are the ones that used to score a weaker comparison in silence: a label
// saying the page records no change while listing some had its list compared
// anyway, because no scorer read `stated`.
// ===========================================================================

describe('fixtures/extraction-golden.json', () => {
    const labels = (JSON.parse(readFileSync('fixtures/extraction-golden.json', 'utf-8')) as {
        cities: Array<{ cityId: string; bodies: Array<{ documents?: Array<{ ada: string; extraction: ExtractionLabel }> }> }>;
    }).cities.flatMap(c => c.bodies.flatMap(b => (b.documents ?? []).map(d => ({ where: `${c.cityId}/${d.ada}`, ac: d.extraction.attendanceChanges }))));

    it('holds the labels the measurement reports on', () => {
        expect(labels.length).toBeGreaterThan(100);
    });

    it('carries an anchor and a list exactly when it says the page states a change', () => {
        const wrong = labels.filter(({ ac }) => ac.stated
            ? !STORED_LABEL_ANCHORS.includes(ac.anchoredBy as StoredLabelAnchor) || !Array.isArray(ac.asExtracted)
            : ac.anchoredBy !== undefined || ac.asExtracted !== undefined);
        expect(wrong.map(l => l.where)).toEqual([]);
    });
});
