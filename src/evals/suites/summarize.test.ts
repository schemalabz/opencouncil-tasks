import { describe, expect, it } from 'vitest';
import { makeRun, makeSubject } from '../../lib/runs/fixtures.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { Subject, SummarizeResult } from '../../types.js';
import { summarizeContributions } from './summarize.js';

const said = (speakerName: string, text: string) => ({ speakerId: null, speakerName, text, order: 0 });
const subjects = (): Subject[] => [
    makeSubject({ id: 's1', name: 'Έγκριση προϋπολογισμού', agendaItemIndex: 1, speakerContributions: [said('Δήμαρχος', 'Παρουσίασε τον προϋπολογισμό.'), said('Σύμβουλος Α', 'Ζήτησε διευκρινίσεις.')] }),
    makeSubject({ id: 's2', name: 'Ηλεκτροφωτισμός πλατείας', agendaItemIndex: 2, speakerContributions: [said('Αντιδήμαρχος', 'Περιέγραψε το έργο.')] }),
    makeSubject({ id: 's3', name: 'Καθαριότητα', agendaItemIndex: 'OUT_OF_AGENDA', speakerContributions: [] }),
];
const result = (s: Subject[]): SummarizeResult => makeRun('t', s).result;

function recorded(r: SummarizeResult): ArchivedRun {
    return {
        run: { traceId: 'f'.repeat(32), taskType: 'summarize', taskVersion: 6, taskId: 'x', env: 'development', meeting: 'samothraki/oct5_2026', input: { date: '2026-10-05' }, startedAt: '2026-10-11T00:00:00Z' },
        outcome: { status: 'success', endedAt: '2026-10-11T00:01:00Z' }, phases: [], calls: [], result: r, key: 'k',
    };
}

describe('summarize suites', () => {
    const c = summarizeContributions.caseFromRun!(recorded(result(subjects())));

    it('builds a case from a recorded run: one drafted expectation per subject, cluster = city', () => {
        expect(c.id).toBe('summarize.contributions/samothraki-oct5_2026');
        expect(c.cluster).toBe('samothraki');
        expect(c.replay).toBe('f'.repeat(32));
        expect(Object.keys(c.expect)).toEqual(['subject[#1 Έγκριση προϋπολογισμού]', 'subject[#2 Ηλεκτροφωτισμός πλατείας]', 'subject[outOfAgenda Καθαριότητα]', 'extra']);
        expect(c.expect.extra.value).toEqual([]);
        expect(Object.values(c.expect).every(e => e.tier === 'drafted' && e.source === `run:${'f'.repeat(32)}`)).toBe(true);
        expect(summarizeContributions.request!(c, recorded(result(subjects())))).toEqual({ date: '2026-10-05' });
    });

    it('scores the recording itself as identical everywhere', () => {
        const out = result(subjects());
        expect(Object.values(summarizeContributions.score(out, c))).toEqual(['agree', 'agree', 'agree', 'agree']);
        expect(Object.values(summarizeContributions.detail!(out, c))).toEqual(['identical', 'identical', 'identical', 'none']);
    });

    it('reworded contributions agree (cosmetic); a lost speaker or subject does not', () => {
        const s = subjects();
        s[0] = { ...s[0], speakerContributions: [said('Δήμαρχος', 'Παρουσίασε αναλυτικά τον προϋπολογισμό.'), said('Σύμβουλος Α', 'Ζήτησε διευκρινίσεις.')] };
        s[1] = { ...s[1], speakerContributions: [] };
        const out = result([s[0], s[1]]);
        const score = summarizeContributions.score(out, c);
        expect(score['subject[#1 Έγκριση προϋπολογισμού]']).toBe('agree');
        expect(score['subject[#2 Ηλεκτροφωτισμός πλατείας]']).toBe('disagree');
        expect(score['subject[outOfAgenda Καθαριότητα]']).toBe('missing');
        const detail = summarizeContributions.detail!(out, c);
        expect(detail['subject[#1 Έγκριση προϋπολογισμού]']).toBe('cosmetic (contribs-changed:1)');
        expect(detail['subject[#2 Ηλεκτροφωτισμός πλατείας]']).toMatch(/^structural .*-speakers:Αντιδήμαρχος/);
    });

    it('disagrees on extra when the output adds a subject the recording does not have, and names it', () => {
        const out = result([...subjects(), makeSubject({ id: 's4', name: 'Επινοημένο θέμα', agendaItemIndex: 7, speakerContributions: [] })]);
        const score = summarizeContributions.score(out, c);
        expect(score.extra).toBe('disagree');
        expect(Object.entries(score).filter(([f]) => f !== 'extra').every(([, o]) => o === 'agree')).toBe(true);
        expect(summarizeContributions.detail!(out, c).extra).toBe('extra (1): #7 Επινοημένο θέμα');
        const { extra: _, ...withoutExtra } = c.expect;
        expect(summarizeContributions.score(out, { ...c, expect: withoutExtra })).not.toHaveProperty('extra');
    });

    it('pairwise shows only the subjects whose contributions differ', () => {
        const s = subjects();
        s[1] = { ...s[1], speakerContributions: [said('Αντιδήμαρχος', 'Περιέγραψε το έργο και το κόστος.')] };
        const views = summarizeContributions.pairwiseItems!(result(subjects()), result(s), c);
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ field: 'subject[#2 Ηλεκτροφωτισμός πλατείας]', sourceLabel: 'contributions:Ηλεκτροφωτισμός πλατείας' });
        expect(views[0].b).toContain('και το κόστος');
    });
});
