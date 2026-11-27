import { describe, expect, it } from 'vitest';
import { applyWrittenSubjects, sanitizeReferences, subjectFacts } from './subjectDescriptions.js';
import type { CompressedTranscript, SubjectInProgress } from './types.js';

describe('sanitizeReferences', () => {
    const tagged = new Set(['u1']);

    it('keeps a link to an utterance of the subject', () => {
        expect(sanitizeReferences('Κόστος [300 χιλιάδες](REF:UTTERANCE:u1).', tagged)).toBe('Κόστος [300 χιλιάδες](REF:UTTERANCE:u1).');
    });

    it('keeps the text and drops the link to an utterance of another subject', () => {
        expect(sanitizeReferences('Κόστος [300 χιλιάδες](REF:UTTERANCE:zz).', tagged)).toBe('Κόστος 300 χιλιάδες.');
    });

    it('drops a reference written after a quotation instead of around it', () => {
        expect(sanitizeReferences('Επεσήμανε: «μόνο 5 από 18» (REF:UTTERANCE:u1).', tagged)).toBe('Επεσήμανε: «μόνο 5 από 18».');
    });
});

describe('subjectFacts', () => {
    const subject = { id: 's1', type: 'BEFORE_AGENDA', agendaItemIndex: 'BEFORE_AGENDA', name: 'Α', introducedByPersonId: 'p1', discussedIn: null } as unknown as SubjectInProgress;
    const joined = { ...subject, id: 's2', name: 'Β', discussedIn: 's1' } as SubjectInProgress;
    const transcript = [
        { speakerId: 'p1', speakerName: 'Ένας', speakerRole: 'παλιός ρόλος', speakerParty: 'Παλιά', speakerSegmentId: 'g1', text: '', utterances: [] },
        { speakerId: null, speakerName: 'Επισκέπτης', speakerRole: 'Πρόεδρος συλλόγου', speakerParty: null, speakerSegmentId: 'g2', text: '', utterances: [] },
    ] as CompressedTranscript;
    const said = (speakerId: string | null, speakerName: string) => ({ utteranceId: 'u', text: '', speakerId, speakerName, timestamp: 0 });
    const people = new Map([['p1', { id: 'long', name: 'Ένας Πλήρης', role: 'Αντιδήμαρχος', party: 'Νέα', partyHead: true }]]);

    it('reads a listed speaker from the people of the meeting and a guest from the transcript', () => {
        const facts = subjectFacts(subject, [subject, joined], [said('p1', 'Ένας'), said(null, 'Επισκέπτης'), said('p1', 'Ένας')], transcript, people);
        expect(facts).toEqual({
            introducedBy: 'Ένας Πλήρης',
            jointWith: ['Β'],
            speakers: ['- Ένας: Αντιδήμαρχος, Νέα, επικεφαλής της παράταξης', '- Επισκέπτης: Πρόεδρος συλλόγου'],
        });
    });
});

describe('applyWrittenSubjects', () => {
    const subject = (id: string, discussedIn: string | null = null) =>
        ({ id, discussedIn, description: 'πριν', topicImportance: 'normal', proximityImportance: 'near' }) as SubjectInProgress;
    const written = new Map([['s1', { description: 'μετά', topicImportance: 'high' as const, proximityImportance: 'wide' as const, importanceReason: '' }]]);

    it('gives a discussed subject its new description and importance', () => {
        const result = [subject('s1')];
        applyWrittenSubjects(result, result, written);
        expect(result[0]).toMatchObject({ description: 'μετά', topicImportance: 'high', proximityImportance: 'wide' });
    });

    it('gives a subject discussed under another that one\'s importance and leaves its description', () => {
        const result = [subject('s1'), subject('s2', 's1')];
        applyWrittenSubjects(result, result, written);
        expect(result[1]).toMatchObject({ description: 'πριν', topicImportance: 'high', proximityImportance: 'wide' });
    });

    it('does not announce a subject the step wrote nothing for, and keeps its radius', () => {
        const result = [subject('s3')];
        applyWrittenSubjects(result, result, written);
        expect(result[0]).toMatchObject({ description: 'πριν', topicImportance: 'doNotNotify', proximityImportance: 'near' });
    });
});
