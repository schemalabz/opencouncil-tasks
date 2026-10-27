import { describe, expect, it } from 'vitest';
import { makeSubject } from '../../lib/runs/fixtures.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { ExtractedSubject } from '../../tasks/processAgenda.js';
import type { ProcessAgendaResult, Subject } from '../../types.js';
import { modesForSuite } from '../registry/registry.js';
import { agendaContext, agendaExtraction, type AgendaExtractionOutput } from './agenda.js';

const subject = (n: number, title: string, name: string, over: Partial<Subject> = {}): Subject =>
    makeSubject({ id: `s${n}`, name, agendaItemIndex: n, agendaItemTitle: title, agendaSection: null, context: { text: `Πλαίσιο ${n}`, citationUrls: [] }, ...over });

const recordedSubjects = () => [
    subject(1, 'Έγκριση προϋπολογισμού 2027', 'Προϋπολογισμός 2027'),
    subject(2, 'Κοπή δένδρου στην πλατεία Άνοιξη', 'Κοπή δένδρου'),
    subject(3, 'Εκμίσθωση κυλικείου 5ου Λυκείου', 'Κυλικείο 5ου Λυκείου'),
];

function recorded(subjects: Subject[]): ArchivedRun {
    return {
        run: { traceId: 'a'.repeat(32), taskType: 'processAgenda', taskVersion: 6, taskId: 'x', env: 'development', meeting: 'zografou/sep8_2026', input: { agendaUrl: 'u' }, startedAt: '2026-10-10T00:00:00Z' },
        outcome: { status: 'success', endedAt: '2026-10-10T00:01:00Z' }, phases: [], calls: [], key: 'k',
        result: { subjects, warnings: [], meetingRecord: null, meetingsInAgenda: [] } satisfies ProcessAgendaResult,
    };
}

const extracted = (s: Subject): ExtractedSubject => ({
    name: s.name, description: s.description, agendaItemTitle: s.agendaItemTitle ?? null, agendaItemIndex: s.agendaItemIndex as number,
    agendaSectionIndex: s.agendaSection?.index ?? null, agendaSectionTitle: s.agendaSection?.title ?? null, introducedByPersonId: null,
    speakerContributions: [], locationText: null, topicLabel: s.topicLabel, topicImportance: s.topicImportance, proximityImportance: s.proximityImportance, meetingIndex: 0,
});
const output = (subjects: Subject[]): AgendaExtractionOutput => ({ subjects: subjects.map(extracted), warnings: [] });

describe('agenda.extraction', () => {
    const c = agendaExtraction.caseFromRun!(recorded(recordedSubjects()));

    it('expects each recorded agenda item, drafted, and no item beyond them', () => {
        expect(c.id).toBe('agenda.extraction/zografou-sep8_2026');
        expect(Object.keys(c.expect)).toEqual([
            'item[#1 Έγκριση προϋπολογισμού 2027]', 'item[#2 Κοπή δένδρου στην πλατεία Άνοιξη]', 'item[#3 Εκμίσθωση κυλικείου 5ου Λυκείου]', 'extra',
        ]);
        expect(c.expect['item[#1 Έγκριση προϋπολογισμού 2027]'].value).toEqual({ number: 1, section: null, title: 'Έγκριση προϋπολογισμού 2027', kind: 'agenda', name: 'Προϋπολογισμός 2027' });
        expect(Object.values(c.expect).every(e => e.tier === 'drafted' && e.source === `run:${'a'.repeat(32)}`)).toBe(true);
    });

    it('scores the recording itself as identical everywhere', () => {
        expect(Object.values(agendaExtraction.score(output(recordedSubjects()), c))).toEqual(['agree', 'agree', 'agree', 'agree']);
        expect(agendaExtraction.detail!(output(recordedSubjects()), c).extra).toBe('none');
    });

    it('names the fields that changed, a lost item and an extra one; a reworded name is not a change', () => {
        const [budget, tree] = recordedSubjects();
        const out = output([
            { ...budget, name: 'Ο προϋπολογισμός' },
            { ...tree, agendaItemIndex: 4, agendaSection: { index: 1, title: 'ΓΕΝΙΚΑ ΘΕΜΑΤΑ' } },
            subject(5, 'Αποδοχή δωρεάς', 'Δωρεά'),
        ]);
        expect(agendaExtraction.score(out, c)).toEqual({
            'item[#1 Έγκριση προϋπολογισμού 2027]': 'agree',
            'item[#2 Κοπή δένδρου στην πλατεία Άνοιξη]': 'disagree',
            'item[#3 Εκμίσθωση κυλικείου 5ου Λυκείου]': 'missing',
            extra: 'disagree',
        });
        const detail = agendaExtraction.detail!(out, c);
        expect(detail['item[#2 Κοπή δένδρου στην πλατεία Άνοιξη]']).toBe('changed (number section)');
        expect(detail.extra).toBe('extra (1): #5 Αποδοχή δωρεάς');
    });

    it('pairs items that share a printed number across sections by position, in order', () => {
        const sectioned = [
            subject(1, 'Πρώτο θέμα Α', 'Α1', { agendaSection: { index: 1, title: 'Α' } }),
            subject(1, 'Πρώτο θέμα Β', 'Β1', { agendaSection: { index: 2, title: 'Β' } }),
        ];
        const cs = agendaExtraction.caseFromRun!(recorded(sectioned));
        expect(Object.keys(cs.expect)).toEqual(['item[1.1 Πρώτο θέμα Α]', 'item[2.1 Πρώτο θέμα Β]', 'extra']);
        expect(Object.values(agendaExtraction.score(output([...sectioned].reverse()), cs))).toEqual(['agree', 'agree', 'agree']);
    });
});

describe('agenda.context', () => {
    it('scores context changes like summarize.context and shares its failure modes', () => {
        const c = agendaContext.caseFromRun!(recorded(recordedSubjects()));
        const s = recordedSubjects();
        s[0] = { ...s[0], context: { text: 'Άλλη διατύπωση του πλαισίου.', citationUrls: [] } };
        s[1] = { ...s[1], context: { text: '', citationUrls: [] } };
        const result: ProcessAgendaResult = { subjects: s, warnings: [], meetingRecord: null, meetingsInAgenda: [] };
        expect(Object.values(agendaContext.score(result, c))).toEqual(['agree', 'disagree', 'agree', 'agree']);
        expect(modesForSuite('agenda.context').map(m => m.slug)).toEqual(expect.arrayContaining(['context_disclaimer_preamble', 'context_empty_after_error']));
    });
});
