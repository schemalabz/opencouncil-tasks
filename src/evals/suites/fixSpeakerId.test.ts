import { describe, expect, it } from 'vitest';
import type { SpeakerIdentification } from '../../lib/speakerIdentification.js';
import { scoreSpeakerId, speakerIdCase, type SpeakerExpectation } from './fixSpeakerId.js';
import { buildBacktestInput, type MeetingApiData } from './speakerBacktest.js';

const IMPORTED = '2026-09-14T15:01:46.215Z';
const REVIEWED = '2026-09-14T16:30:00.000Z';
type Tag = MeetingApiData['transcript'][number]['speakerTag'];
const tag = (id: string, label: string, personId: string | null, over: Partial<Tag> = {}): Tag => ({ id, label, personId, createdAt: IMPORTED, updatedAt: IMPORTED, personSetBy: null, ...over });
const segment = (start: number, speakerTag: Tag, text: string) => ({ startTimestamp: start, endTimestamp: start + 10, speakerTag, utterances: [{ text }] });

const data: MeetingApiData = {
    meeting: { id: 'm1', cityId: 'demo', dateTime: '2026-09-14T07:30:00.000Z', administrativeBodyId: null, administrativeBody: { name: 'Δημοτικό Συμβούλιο' } },
    city: { name: 'Δήμος', language: 'el' },
    people: [{ id: 'p-a', name: 'Άννα Α', roles: [] }, { id: 'p-b', name: 'Βασίλης Β', roles: [] }],
    transcript: [
        segment(0, tag('t-voice', 'SPEAKER_1', 'p-a'), 'Καλησπέρα.'),
        segment(10, tag('t-review', 'Άγνωστος Ομιλητής 2', 'p-b', { personSetBy: 'user', updatedAt: REVIEWED }), 'Ευχαριστώ.'),
        segment(20, tag('t-resident', 'Κάτοικος', null, { personSetBy: 'user', updatedAt: REVIEWED }), 'Ερώτηση.'),
        segment(30, tag('t-none', 'Άγνωστος Ομιλητής 4', null), 'Ναι.'),
    ],
};
const c = speakerIdCase('demo/m1', data, new Map([['t-review', { by: 'user', at: '2026-09-15', signal: 'opencouncil:speaker-tag:person:t-review' }]]), new Date('2026-10-11T00:00:00Z'));
const labelOf = new Map(buildBacktestInput(data, { anchor: 'none' }).speakers.map(s => [s.speakerTagId, s.label]));
const named = (tagId: string, personId: string | null): SpeakerIdentification => ({
    speakerLabel: labelOf.get(tagId)!, personId, evidenceKind: 'named', contested: false, actionable: true, confidence: 90, evidence: '', alternatives: [], known: false,
});

describe('fix.speaker-id cases', () => {
    it('imports a reviewer\'s tags, drafts an untouched voiceprint match, and leaves out a speaker nobody named', () => {
        expect(c.expect['speaker[t-review]']).toMatchObject({ value: { personId: 'p-b', source: 'review' }, tier: 'imported', signal: 'opencouncil:speaker-tag:person:t-review', at: '2026-09-15' });
        expect(c.expect['speaker[t-resident]']).toMatchObject({ value: { personId: null, source: 'offRoster' }, tier: 'imported', signal: 'speaker-tag:t-resident' });
        expect(c.expect['speaker[t-voice]']).toMatchObject({ value: { personId: 'p-a', source: 'voiceprint' } satisfies SpeakerExpectation, tier: 'drafted' });
        expect(c.expect['speaker[t-none]']).toBeUndefined();
        expect(c).toMatchObject({ id: 'fix.speaker-id/demo-m1', cluster: 'demo/Δημοτικό Συμβούλιο' });
    });
});

describe('fix.speaker-id scoring', () => {
    it('agrees everywhere with the record as the answers (oracle)', () => {
        expect(scoreSpeakerId({ identifications: [named('t-voice', 'p-a'), named('t-review', 'p-b')] }, c))
            .toEqual({ 'speaker[t-voice]': 'agree', 'speaker[t-review]': 'agree', 'speaker[t-resident]': 'agree' });
    });

    it('scores no answers as missed roster speakers, never as agreement on them (null)', () => {
        expect(scoreSpeakerId({ identifications: [] }, c)).toMatchObject({ 'speaker[t-voice]': 'missing', 'speaker[t-review]': 'missing' });
    });

    it('counts a roster name on an off-roster speaker as wrong', () => {
        expect(scoreSpeakerId({ identifications: [named('t-resident', 'p-a'), named('t-review', 'p-a')] }, c))
            .toMatchObject({ 'speaker[t-resident]': 'disagree', 'speaker[t-review]': 'disagree' });
    });
});
