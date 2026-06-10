import { describe, expect, it } from 'vitest';
import { compareRuns } from './compare.js';
import { RunWithResult } from './types.js';
import { DiscussionStatus, Subject, SummarizeResult } from '../../types.js';

function makeSubject(overrides: Partial<Subject> & { id: string; name: string }): Subject {
    return {
        description: 'Περιγραφή θέματος.',
        agendaItemIndex: 1,
        introducedByPersonId: null,
        speakerContributions: [],
        topicImportance: 'normal',
        proximityImportance: 'none',
        location: null,
        topicLabel: 'Διοίκηση',
        context: null,
        discussedIn: null,
        ...overrides,
    };
}

function makeRun(traceId: string, subjects: Subject[], extras?: Partial<SummarizeResult>): RunWithResult {
    return {
        info: {
            traceId,
            timestamp: '2026-06-10T12:00:00Z',
            name: 'summarize',
            meeting: 'dev/test',
            version: 'test',
            env: 'development',
            promptsHash: null,
            isError: false,
            totalCost: null,
            latencySeconds: null,
        },
        result: {
            speakerSegmentSummaries: [],
            subjects,
            utteranceDiscussionStatuses: [],
            ...extras,
        },
    };
}

describe('compareRuns', () => {
    it('classifies identical subjects', () => {
        const subject = makeSubject({ id: 'a', name: 'Θέμα 1' });
        const comparison = compareRuns(
            makeRun('t1', [subject]),
            makeRun('t2', [makeSubject({ id: 'b', name: 'Θέμα 1' })]),
        );
        expect(comparison.subjects.matched).toHaveLength(1);
        expect(comparison.subjects.matched[0].verdict).toBe('identical');
        expect(comparison.verdictSummary).toEqual({ identical: 1, cosmetic: 0, structural: 0 });
    });

    it('classifies small description rewording as cosmetic', () => {
        const from = makeSubject({ id: 'a', name: 'Θέμα 1', description: 'Συζήτηση για το έργο της πλατείας με προϋπολογισμό 2 εκατ. ευρώ.' });
        const to = makeSubject({ id: 'b', name: 'Θέμα 1', description: 'Συζήτηση για το έργο της πλατείας, προϋπολογισμού 2 εκατ. ευρώ.' });
        const comparison = compareRuns(makeRun('t1', [from]), makeRun('t2', [to]));
        expect(comparison.subjects.matched[0].verdict).toBe('cosmetic');
    });

    it('classifies topic changes and speaker additions as structural', () => {
        const from = makeSubject({ id: 'a', name: 'Θέμα 1' });
        const to = makeSubject({
            id: 'b',
            name: 'Θέμα 1',
            topicLabel: 'Πολιτισμός',
            speakerContributions: [{ speakerId: null, speakerName: 'Νέος Ομιλητής', text: 'Τοποθέτηση.', order: 0 }],
        });
        const comparison = compareRuns(makeRun('t1', [from]), makeRun('t2', [to]));
        expect(comparison.subjects.matched[0].verdict).toBe('structural');
        expect(comparison.subjects.matched[0].changes).toContain('topic:Διοίκηση→Πολιτισμός');
        expect(comparison.subjects.matched[0].changes).toContain('+speakers:Νέος Ομιλητής');
    });

    it('treats large utterance shifts as structural', () => {
        const from = makeRun('t1', [makeSubject({ id: 'a', name: 'Θέμα 1' })], {
            utteranceDiscussionStatuses: Array.from({ length: 50 }, (_, i) => ({
                utteranceId: `u${i}`, status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'a',
            })),
        });
        const to = makeRun('t2', [makeSubject({ id: 'b', name: 'Θέμα 1' })], {
            utteranceDiscussionStatuses: Array.from({ length: 10 }, (_, i) => ({
                utteranceId: `u${i}`, status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'b',
            })),
        });
        const comparison = compareRuns(from, to);
        expect(comparison.subjects.matched[0].verdict).toBe('structural');
        expect(comparison.stats.from.totalUtterancesAssigned).toBe(50);
        expect(comparison.stats.to.totalUtterancesAssigned).toBe(10);
    });

    it('matches subjects by name when agenda classification flips between runs', () => {
        // Real case (sparta/mar12_2026): identical config, but one run classified the
        // single subject as out-of-agenda and the other as agenda item #1.
        const from = makeSubject({ id: 'a', name: 'Ενεργειακή αναβάθμιση Δημοτικής Αγοράς Σπάρτης', agendaItemIndex: 'OUT_OF_AGENDA' });
        const to = makeSubject({ id: 'b', name: 'Ενεργειακή αναβάθμιση Δημοτικής Αγοράς', agendaItemIndex: 1 });
        const comparison = compareRuns(makeRun('t1', [from]), makeRun('t2', [to]));
        expect(comparison.subjects.matched).toHaveLength(1);
        expect(comparison.subjects.matched[0].matchedBy).toBe('name');
        expect(comparison.subjects.matched[0].verdict).toBe('structural');
        expect(comparison.subjects.matched[0].changes[0]).toBe('agenda-classification:outOfAgenda→#1');
        expect(comparison.subjects.fromOnly).toHaveLength(0);
        expect(comparison.subjects.toOnly).toHaveLength(0);
    });

    it('routes non-agenda subjects to fromOnly/toOnly without matching', () => {
        const from = makeSubject({ id: 'a', name: 'Ανακοίνωση Α', agendaItemIndex: 'BEFORE_AGENDA' });
        const to = makeSubject({ id: 'b', name: 'Ανακοίνωση Β', agendaItemIndex: 'BEFORE_AGENDA' });
        const comparison = compareRuns(makeRun('t1', [from]), makeRun('t2', [to]));
        expect(comparison.subjects.matched).toHaveLength(0);
        expect(comparison.subjects.fromOnly.map(s => s.name)).toEqual(['Ανακοίνωση Α']);
        expect(comparison.subjects.toOnly.map(s => s.name)).toEqual(['Ανακοίνωση Β']);
        expect(comparison.stats.from.beforeAgenda).toBe(1);
    });

    it('reports agenda subjects missing on one side as unmatched', () => {
        const shared = makeSubject({ id: 'a', name: 'Θέμα 1' });
        const extra = makeSubject({ id: 'x', name: 'Θέμα 2', agendaItemIndex: 2 });
        const comparison = compareRuns(makeRun('t1', [shared, extra]), makeRun('t2', [makeSubject({ id: 'b', name: 'Θέμα 1' })]));
        expect(comparison.subjects.matched).toHaveLength(1);
        expect(comparison.subjects.fromOnly.map(s => s.name)).toEqual(['Θέμα 2']);
    });

    it('samples differing segment summaries, preferring substantial ones', () => {
        const fromSegments = Array.from({ length: 15 }, (_, i) => ({
            speakerSegmentId: `seg${i}`,
            topicLabels: [],
            summary: `Σύνοψη ${i}`,
            type: (i < 12 ? 'PROCEDURAL' : 'SUBSTANTIAL') as 'PROCEDURAL' | 'SUBSTANTIAL',
        }));
        const toSegments = fromSegments.map(s => ({ ...s, summary: `${s.summary} (αλλαγμένη)` }));
        const comparison = compareRuns(
            makeRun('t1', [], { speakerSegmentSummaries: fromSegments }),
            makeRun('t2', [], { speakerSegmentSummaries: toSegments }),
        );
        expect(comparison.segmentSamples).toHaveLength(10);
        const substantialCount = comparison.segmentSamples.filter(s => s.from.type === 'SUBSTANTIAL').length;
        expect(substantialCount).toBe(3);  // all 3 substantial diffs included, procedural fills the rest
    });

    it('handles a single remaining procedural slot (9 substantial + 2 procedural)', () => {
        const fromSegments = Array.from({ length: 11 }, (_, i) => ({
            speakerSegmentId: `seg${i}`,
            topicLabels: [],
            summary: `Σύνοψη ${i}`,
            type: (i < 9 ? 'SUBSTANTIAL' : 'PROCEDURAL') as 'PROCEDURAL' | 'SUBSTANTIAL',
        }));
        const toSegments = fromSegments.map(s => ({ ...s, summary: `${s.summary} (αλλαγμένη)` }));
        const comparison = compareRuns(
            makeRun('t1', [], { speakerSegmentSummaries: fromSegments }),
            makeRun('t2', [], { speakerSegmentSummaries: toSegments }),
        );
        expect(comparison.segmentSamples).toHaveLength(10);
        expect(comparison.segmentSamples.every(s => s !== undefined)).toBe(true);
    });

    it('ignores REF link differences when classifying', () => {
        const from = makeSubject({ id: 'a', name: 'Θέμα 1', description: 'Ο δήμαρχος [μίλησε](REF:UTTERANCE:abc123) για το έργο.' });
        const to = makeSubject({ id: 'b', name: 'Θέμα 1', description: 'Ο δήμαρχος [μίλησε](REF:UTTERANCE:xyz789) για το έργο.' });
        const comparison = compareRuns(makeRun('t1', [from]), makeRun('t2', [to]));
        expect(comparison.subjects.matched[0].verdict).toBe('identical');
    });
});
