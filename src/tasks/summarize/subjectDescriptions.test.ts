import { describe, expect, it } from 'vitest';
import { DiscussionStatus } from '../../types.js';
import { sanitizeReferences, speakerPositions, turnOrder, unlinkOpening, wordLimit, type SpeakerPosition } from './subjectDescriptions.js';
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

describe('unlinkOpening', () => {
    it('takes the link off a figure in the first sentence and keeps later links', () => {
        expect(unlinkOpening('Κατακύρωση οχήματος [στο ποσό 39.999 ευρώ](REF:UTTERANCE:u1). Ο κ. Α ζήτησε [νέα μελέτη](REF:UTTERANCE:u2).'))
            .toBe('Κατακύρωση οχήματος στο ποσό 39.999 ευρώ. Ο κ. Α ζήτησε [νέα μελέτη](REF:UTTERANCE:u2).');
    });

    it('does not end the first sentence at «κ.» or at an initial', () => {
        expect(unlinkOpening('Δωρεά του κ. Παπαστεριάδη για [το ιατρείο](REF:UTTERANCE:u1). Τέλος.')).toBe('Δωρεά του κ. Παπαστεριάδη για το ιατρείο. Τέλος.');
    });

    it('leaves a description with no link in its first sentence as it is', () => {
        const text = 'Η κεραία στην Άνω Κυψέλη. Ο κ. Α ζήτησε [έλεγχο](REF:UTTERANCE:u1).';
        expect(unlinkOpening(text)).toBe(text);
    });
});

describe('wordLimit', () => {
    const speaker = (chars: number): SpeakerPosition => ({ speakerName: 'x', party: null, role: null, chars, text: '' });

    it('grows with the speakers who took a position, not with how long they spoke', () => {
        expect(wordLimit([speaker(40_000)])).toBe(wordLimit([speaker(600)]));
        expect(wordLimit([speaker(600), speaker(600), speaker(100)])).toBeGreaterThan(wordLimit([speaker(600)]));
    });

    it('gives a large debate room for every speaker, up to a ceiling', () => {
        const debate = (n: number) => Array.from({ length: n }, () => speaker(600));
        expect(wordLimit(debate(16))).toBeGreaterThan(wordLimit(debate(8)));
        expect(wordLimit(debate(8))).toBeGreaterThan(wordLimit(debate(5)));
        expect(wordLimit(debate(60))).toBe(wordLimit(debate(30)));
    });
});

describe('speakerPositions and turnOrder', () => {
    const subject = {
        id: 's1', type: 'BEFORE_AGENDA', agendaItemIndex: 'BEFORE_AGENDA', name: 'Κεραία', description: '', topicImportance: 'normal', proximityImportance: 'none',
        introducedByPersonId: null, locationText: null, topicLabel: null, discussedIn: null,
        speakerContributions: [
            { speakerId: 'p2', speakerName: 'Β', text: 'απάντησε', order: 1 },
            { speakerId: 'p1', speakerName: 'Α', text: 'ρώτησε', order: 0 },
        ],
    } as unknown as SubjectInProgress;
    const long = 'λ'.repeat(200);
    const transcript = [
        { speakerId: 'p1', speakerName: 'Α', speakerParty: 'Χ', speakerRole: null, utterances: [{ utteranceId: 'u1', text: long }] },
        { speakerId: 'p3', speakerName: 'Πρόεδρος', speakerParty: null, speakerRole: null, utterances: [{ utteranceId: 'u2', text: 'Ο κ. Β.' }] },
        { speakerId: 'p2', speakerName: 'Β', speakerParty: 'Ψ', speakerRole: 'Αντιδήμαρχος', utterances: [{ utteranceId: 'u3', text: long }, { utteranceId: 'u9', text: 'άλλο θέμα' }] },
        { speakerId: 'p1', speakerName: 'Α', speakerParty: 'Χ', speakerRole: null, utterances: [{ utteranceId: 'u4', text: long }] },
    ] as unknown as CompressedTranscript;
    const statuses = ['u1', 'u2', 'u3', 'u4'].map(utteranceId => ({ utteranceId, status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 's1' }));

    it('lists the speakers who have a contribution, in the order they first spoke, with the speech tagged to the subject', () => {
        expect(speakerPositions(subject, statuses, transcript)).toEqual([
            { speakerName: 'Α', party: 'Χ', role: null, chars: 400, text: 'ρώτησε' },
            { speakerName: 'Β', party: 'Ψ', role: 'Αντιδήμαρχος', chars: 200, text: 'απάντησε' },
        ]);
    });

    it('shows a second turn of the same speaker and leaves out a hand-over', () => {
        expect(turnOrder(subject, statuses, transcript)).toEqual(['Α', 'Β', 'Α']);
    });
});
