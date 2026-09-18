import { describe, it, expect } from 'vitest';
import { acceptAtConfidence, aggregateSummaries, buildBacktestInput, describePerson, maySpeakAtMeeting, evidenceBreakdown, formatEvidenceTable, identificationFingerprint, estimateCostUsd, formatBacktestReport, formatMeetingTable, formatThresholdSweep, scoreBacktest, thresholdSweep, truthSource, MeetingApiData } from './speakerBacktest.js';
import { SpeakerIdentification } from '../../lib/speakerIdentification.js';

const IMPORTED = '2026-09-14T15:01:46.215Z';
const REVIEWED = '2026-09-14T16:30:00.000Z';

const role = (over: Partial<MeetingApiData['people'][number]['roles'][number]> = {}) => ({
    partyId: null, administrativeBodyId: null, isHead: false, name: null, name_en: null,
    startDate: null, endDate: null, party: null, administrativeBody: null, ...over,
});

const tag = (id: string, label: string, personId: string | null, updatedAt = IMPORTED) => ({ id, label, personId, createdAt: IMPORTED, updatedAt });

const meeting = (): MeetingApiData => ({
    meeting: { id: 'm1', cityId: 'athens', dateTime: '2026-09-14T07:30:00.000Z', administrativeBodyId: 'body', administrativeBody: { name: 'Δημοτικό Συμβούλιο' } },
    city: { name: 'Αθήνα', language: 'el' },
    people: [
        { id: 'p-mayor', name: 'Χάρης Δούκας', roles: [role({ name: 'Δήμαρχος' }), role({ partyId: 'party-a', party: { name: 'Αθήνα Τώρα' }, isHead: true })] },
        { id: 'p-chair', name: 'Μαρία Πρόεδρου', roles: [role({ administrativeBodyId: 'body', isHead: true, administrativeBody: { name: 'Δημοτικό Συμβούλιο' } })] },
        { id: 'p-old', name: 'Παλιός Σύμβουλος', roles: [role({ administrativeBodyId: 'body', endDate: '2020-01-01T00:00:00.000Z', administrativeBody: { name: 'Δημοτικό Συμβούλιο' } })] },
    ],
    transcript: [
        { startTimestamp: 10, endTimestamp: 20, speakerTag: tag('t-chair', 'SPEAKER_3', 'p-chair'), utterances: [{ text: 'Τον λόγο έχει ο κύριος Δήμαρχος.' }] },
        { startTimestamp: 0, endTimestamp: 5, speakerTag: tag('t-unknown', 'Άγνωστος Ομιλητής 2', null), utterances: [{ text: 'Παρών.' }] },
        { startTimestamp: 20, endTimestamp: 50, speakerTag: tag('t-mayor', 'Άγνωστος Ομιλητής 1', 'p-mayor', REVIEWED), utterances: [{ text: 'Ευχαριστώ.' }, { text: '  ' }] },
        { startTimestamp: 50, endTimestamp: 55, speakerTag: tag('t-chair', 'SPEAKER_3', 'p-chair'), utterances: [{ text: '' }] },
        { startTimestamp: 60, endTimestamp: 80, speakerTag: tag('t-resident', 'κ. Κάτοικος - Σύλλογος', null, REVIEWED), utterances: [{ text: 'Θέλω να πω.' }] },
        { startTimestamp: 80, endTimestamp: 90, speakerTag: tag('t-mayor-2', 'SPEAKER_5', 'p-mayor', REVIEWED), utterances: [{ text: 'Ναι.' }] },
        { startTimestamp: 90, endTimestamp: 92, speakerTag: tag('t-chair-2', 'New speaker segment', 'p-chair', REVIEWED), utterances: [{ text: 'Ευχαριστώ πολύ.' }] },
    ],
});

describe('truthSource', () => {
    it('tells an untouched voiceprint match from a reviewer link', () => {
        expect(truthSource({ label: 'SPEAKER_12', personId: 'p', createdAt: IMPORTED, updatedAt: IMPORTED })).toBe('voiceprint');
        expect(truthSource({ label: 'SPEAKER_12', personId: 'p' })).toBe('voiceprint');
        expect(truthSource({ label: 'Άγνωστος Ομιλητής 1', personId: 'p' })).toBe('review');
    });

    it('reads a later edit to a voiceprint match as a correction, and a missing person as a removal', () => {
        expect(truthSource({ label: 'SPEAKER_12', personId: 'p', createdAt: IMPORTED, updatedAt: REVIEWED })).toBe('voiceprintCorrected');
        expect(truthSource({ label: 'SPEAKER_12', personId: 'p', createdAt: IMPORTED, updatedAt: '2026-09-14T15:01:48.000Z' })).toBe('voiceprint');
        expect(truthSource({ label: 'SPEAKER_12', personId: null, createdAt: IMPORTED, updatedAt: REVIEWED })).toBe('voiceprintRemoved');
    });

    it('does not read a voiceprint error into SPEAKER_N labels from before the import told matches apart', () => {
        const OLD = '2025-11-13T10:00:00.000Z';
        const LATER = '2025-11-14T09:00:00.000Z';
        // Every speaker was SPEAKER_N then, matched or not.
        expect(truthSource({ label: 'SPEAKER_7', personId: null, createdAt: OLD, updatedAt: OLD })).toBe('none');
        expect(truthSource({ label: 'SPEAKER_4', personId: 'p', createdAt: OLD, updatedAt: LATER })).toBe('review');
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', createdAt: OLD, updatedAt: OLD })).toBe('voiceprint');
    });

    it('goes by the recorded source when a method or a reviewer set the person, whatever the timestamps say', () => {
        const hinted = { createdAt: IMPORTED, updatedAt: REVIEWED };
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', personSetBy: 'both', ...hinted })).toBe('voiceprint');
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', personSetBy: 'voiceprint', ...hinted })).toBe('voiceprint');
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', personSetBy: 'user', ...hinted })).toBe('voiceprintCorrected');
        expect(truthSource({ label: 'SPEAKER_3', personId: null, personSetBy: 'user', ...hinted })).toBe('voiceprintRemoved');
        expect(truthSource({ label: 'Άγνωστος Ομιλητής 2', personId: 'p', personSetBy: 'user', ...hinted })).toBe('review');
        expect(truthSource({ label: 'κ. Τσουκάτος', personId: null, personSetBy: 'user', ...hinted })).toBe('offRoster');
        expect(truthSource({ label: 'Άγνωστος Ομιλητής 2', personId: null, personSetBy: null, ...hinted })).toBe('none');
        // A reviewer's edit that the timestamps no longer show still counts as one.
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', personSetBy: 'user', createdAt: IMPORTED, updatedAt: IMPORTED })).toBe('voiceprintCorrected');
    });

    it('reads a tag with no recorded source as before: the untouched tags of earlier meetings have none', () => {
        const untouched = { createdAt: IMPORTED, updatedAt: IMPORTED, personSetBy: null };
        // An import's voiceprint match nobody edited keeps no source, and is still a match.
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', ...untouched })).toBe('voiceprint');
        expect(truthSource({ label: 'Άγνωστος Ομιλητής 2', personId: null, ...untouched })).toBe('none');
        // Before the import told matches apart, an edited SPEAKER_N says nothing about a voiceprint.
        const OLD = '2025-11-13T10:00:00.000Z';
        expect(truthSource({ label: 'SPEAKER_4', personId: 'p', personSetBy: 'user', createdAt: OLD, updatedAt: OLD })).toBe('review');
        expect(truthSource({ label: 'SPEAKER_3', personId: 'p', personSetBy: null, createdAt: OLD, updatedAt: OLD })).toBe('voiceprint');
    });

    it('never takes the transcript method\'s own earlier answer as the answer key', () => {
        expect(truthSource({ label: 'Άγνωστος Ομιλητής 2', personId: 'p', personSetBy: 'transcript' })).toBe('none');
    });

    it('treats labels no human wrote as unidentified', () => {
        for (const label of ['Άγνωστος Ομιλητής 3', 'άγνωστος ομιλητής 3', 'Άγνωστος Ομιλητής', 'Γραμματέας', 'New speaker segment', 'New κ. Τσουκάτος', '  ', null]) {
            expect(truthSource({ label, personId: null })).toBe('none');
        }
    });

    it('treats a typed label without a person as an off-roster speaker', () => {
        expect(truthSource({ label: 'κ. Τσουκάτος - Πρωτοβουλία Χανιωτών', personId: null })).toBe('offRoster');
        expect(truthSource({ label: 'Υπάλληλος Δήμου Αθηναίων', personId: null })).toBe('offRoster');
    });
});

describe('describePerson', () => {
    const date = new Date('2026-09-14T00:00:00Z');

    it('describes a city-level role and marks a party head', () => {
        expect(describePerson(meeting().people[0], date, 'body')).toEqual({ id: 'p-mayor', name: 'Χάρης Δούκας', role: 'Δήμαρχος', party: 'Αθήνα Τώρα', partyHead: true, memberOfMeetingBody: false });
    });

    it('describes an administrative body role and marks membership of the meeting body', () => {
        expect(describePerson(meeting().people[1], date, 'body')).toEqual({ id: 'p-chair', name: 'Μαρία Πρόεδρου', role: 'head, Δημοτικό Συμβούλιο', party: null, memberOfMeetingBody: true });
    });

    it('ignores roles that ended before the meeting', () => {
        expect(describePerson(meeting().people[2], date, 'body')).toEqual({ id: 'p-old', name: 'Παλιός Σύμβουλος', role: null, party: null, memberOfMeetingBody: false });
    });

    it('lists every active role, with the role in the meeting body first', () => {
        const person = {
            id: 'p-dual', name: 'Γ. Γιάνναρος', roles: [
                role({ name: 'Αντιδήμαρχος' }),
                role({ administrativeBodyId: 'council', administrativeBody: { name: 'Δημοτικό Συμβούλιο' } }),
                role({ administrativeBodyId: 'committee', isHead: true, name: 'Πρόεδρος', administrativeBody: { name: 'Δημοτική Επιτροπή' } }),
            ],
        };
        expect(describePerson(person, date, 'committee')).toMatchObject({ role: 'Πρόεδρος, Δημοτική Επιτροπή; Αντιδήμαρχος; Δημοτικό Συμβούλιο', memberOfMeetingBody: true });
        expect(describePerson(person, date, 'council')).toMatchObject({ role: 'Δημοτικό Συμβούλιο; Αντιδήμαρχος; Πρόεδρος, Δημοτική Επιτροπή', memberOfMeetingBody: true });
        expect(describePerson(person, date, null)).toMatchObject({ role: 'Αντιδήμαρχος; Δημοτικό Συμβούλιο; Πρόεδρος, Δημοτική Επιτροπή', memberOfMeetingBody: false });
    });
});

describe('buildBacktestInput', () => {
    it('labels speakers in order of first speech and hides stored identities', () => {
        const input = buildBacktestInput(meeting(), { anchor: 'none' });
        expect(input.speakers.map(s => [s.label, s.speakerTagId, s.source, s.speakingSeconds, s.segmentCount])).toEqual([
            ['S1', 't-unknown', 'none', 5, 1],
            ['S2', 't-chair', 'voiceprint', 15, 2],
            ['S3', 't-mayor', 'review', 30, 1],
            ['S4', 't-resident', 'offRoster', 20, 1],
            ['S5', 't-mayor-2', 'voiceprintCorrected', 10, 1],
            ['S6', 't-chair-2', 'review', 2, 1],
        ]);
        expect(input.segments.map(s => [s.speakerLabel, s.text])).toEqual([
            ['S1', 'Παρών.'],
            ['S2', 'Τον λόγο έχει ο κύριος Δήμαρχος.'],
            ['S3', 'Ευχαριστώ.'],
            ['S4', 'Θέλω να πω.'],
            ['S5', 'Ναι.'],
            ['S6', 'Ευχαριστώ πολύ.'],
        ]);
        expect(input.knownSpeakers).toEqual([]);
        expect(input.meetingDate).toBe('2026-09-14');
        expect(input.administrativeBodyName).toBe('Δημοτικό Συμβούλιο');
        expect(input.roster.filter(p => p.memberOfMeetingBody).map(p => p.id)).toEqual(['p-chair']);
    });

    it('anchors only untouched voiceprint matches', () => {
        const input = buildBacktestInput(meeting(), { anchor: 'voiceprint' });
        expect(input.knownSpeakers).toEqual([{ speakerLabel: 'S2', personId: 'p-chair' }]);
    });
});

describe('the roster', () => {
    const DATE = new Date('2026-09-14T07:30:00.000Z');
    const inBody = (id: string, type: string, over = {}) => role({ administrativeBodyId: id, administrativeBody: { name: id, type }, ...over });
    const cityLevel = (name: string, over = {}) => role({ cityId: 'athens', name, ...over });
    const person = (id: string, roles: ReturnType<typeof role>[]) => ({ id, name: id, roles });

    const city = [
        person('mayor', [cityLevel('Δήμαρχος', { isHead: true })]),
        person('former-deputy-mayor', [cityLevel('Αντιδήμαρχος', { endDate: '2025-12-31T00:00:00.000Z' }), inBody('community-a', 'community')]),
        person('councillor', [inBody('council', 'council'), role({ partyId: 'party-a', party: { name: 'Αθήνα Τώρα' } })]),
        person('committee-only-member', [inBody('committee', 'committee')]),
        person('community-a-head', [inBody('community-a', 'community', { isHead: true })]),
        person('community-a-member', [inBody('community-a', 'community')]),
        person('community-b-member', [inBody('community-b', 'community')]),
        person('no-roles', []),
    ];
    const whoMaySpeakAt = (bodyId: string) => city.filter(p => maySpeakAtMeeting(p, bodyId, DATE)).map(p => p.id);

    it('holds, as in opencouncil, the body\'s members, the council, city-level roles, community heads and people with no body', () => {
        const everywhere = ['mayor', 'councillor', 'community-a-head', 'no-roles'];
        expect(whoMaySpeakAt('council')).toEqual(everywhere);
        expect(whoMaySpeakAt('committee')).toEqual(['mayor', 'councillor', 'committee-only-member', 'community-a-head', 'no-roles']);
        expect(whoMaySpeakAt('community-a')).toEqual(['mayor', 'former-deputy-mayor', 'councillor', 'community-a-head', 'community-a-member', 'no-roles']);
    });

    it('is the meeting\'s people unless the whole city is asked for, and the whole city for a meeting with no body', () => {
        const data = { ...meeting(), people: city };
        data.meeting = { ...data.meeting, administrativeBodyId: 'council' };
        const ids = (roster: 'meeting' | 'city' | undefined) => buildBacktestInput(data, { anchor: 'none', roster }).roster.map(p => p.id);

        expect(ids(undefined)).toEqual(['mayor', 'councillor', 'community-a-head', 'no-roles']);
        expect(ids('meeting')).toEqual(ids(undefined));
        expect(ids('city')).toEqual(city.map(p => p.id));
        expect(buildBacktestInput(data, { anchor: 'none' }).cityPeople).toBe(8);

        data.meeting = { ...data.meeting, administrativeBodyId: null };
        expect(ids('meeting')).toEqual(city.map(p => p.id));
    });
});

describe('identificationFingerprint', () => {
    const fingerprint = (data: MeetingApiData, anchor: 'none' | 'voiceprint' = 'none') => identificationFingerprint(buildBacktestInput(data, { anchor }));

    it('is stable for the same meeting', () => {
        expect(fingerprint(meeting())).toBe(fingerprint(meeting()));
        expect(fingerprint(meeting())).toMatch(/^[0-9a-f]{16}$/);
    });

    it('changes when what the model is shown changes: the text, the roster, the anchors', () => {
        const base = fingerprint(meeting());

        const reworded = meeting();
        reworded.transcript[0].utterances[0].text += ' Και κάτι ακόμα.';
        expect(fingerprint(reworded)).not.toBe(base);

        const renamed = meeting();
        renamed.people[0].name += ' Β';
        expect(fingerprint(renamed)).not.toBe(base);

        // Anchoring hands the model the voiceprint-matched speakers as known.
        expect(fingerprint(meeting(), 'voiceprint')).not.toBe(base);
    });

    it('ignores the answer key: who the record says a speaker is does not change what the model was asked', () => {
        const base = buildBacktestInput(meeting(), { anchor: 'none' });
        const rekeyed = { ...base, speakers: base.speakers.map(speaker => ({ ...speaker, personId: null, source: 'none' as const })) };
        expect(identificationFingerprint(rekeyed)).toBe(identificationFingerprint(base));
    });
});

describe('scoreBacktest', () => {
    const input = buildBacktestInput(meeting(), { anchor: 'none' });
    const verdict = (speakerLabel: string, personId: string | null, confidence: number, over: Partial<SpeakerIdentification> = {}): SpeakerIdentification =>
        ({ speakerLabel, personId, evidenceKind: personId ? 'named' : null, contested: false, actionable: personId !== null, confidence, evidence: 'e', alternatives: [], known: false, ...over });

    const allOutcomesAnswers = () => [
        verdict('S1', 'p-old', 90),      // unidentified speaker → unverified
        verdict('S2', 'p-mayor', 80),    // record: chair → mismatch
        verdict('S3', 'p-mayor', 95),    // record: mayor → match
        verdict('S4', 'p-chair', 85),    // off-roster resident → wrong name
        verdict('S5', 'p-mayor', 90),    // record: mayor (after a voiceprint correction) → match
        verdict('S6', 'p-chair', 60),    // record: chair, under the threshold → missed
    ];
    const allOutcomes = () => scoreBacktest(input.speakers, allOutcomesAnswers(), acceptAtConfidence(70));

    it('scores each tag against the record', () => {
        const { scored } = allOutcomes();
        expect(scored.map(s => s.outcome)).toEqual(['unverified', 'mismatch', 'match', 'wrongOffRoster', 'match', 'missed']);
        expect(scored[5].heldBack).toBe(true);
        expect(scored[5].predictedPersonId).toBe('p-chair');
    });

    it('counts distinct people and speaking time for each method', () => {
        const { summary } = allOutcomes();
        expect(summary).toEqual({
            rosterPeople: 2,
            rosterSeconds: 57,
            offRosterSpeakers: 1,
            offRosterSeconds: 20,
            unlabelledSpeakers: 1,
            unlabelledSeconds: 5,
            // The chair's untouched match is right; the second mayor tag was a voiceprint match a reviewer changed.
            voiceprint: { peopleNamed: 1, secondsNamed: 15, correctNames: 1, wrongNames: 1, wrongSeconds: 10 },
            // The mayor is named on both tags; the chair on none, and the chair's short tag was right but under the threshold.
            model: {
                peopleNamed: 1, secondsNamed: 40, correctNames: 2, wrongNames: 2, wrongSeconds: 35, wrongOnOffRoster: 1, unverifiedNames: 1, unverifiedSeconds: 5,
                missed: { silent: { tags: 0, seconds: 0 }, heldBackRight: { tags: 1, seconds: 2 }, heldBackWrong: { tags: 0, seconds: 0 } },
            },
            // Reconciled: the model names someone else on both voiceprint tags, so both are withheld — the chair's
            // right match and the mayor's wrong one. The model answers the rest.
            combined: { peopleNamed: 1, secondsNamed: 30, correctNames: 1, wrongNames: 1, wrongSeconds: 20, unverifiedNames: 1, unverifiedSeconds: 5, withheldNames: 2, withheldSeconds: 25 },
            people: { both: 0, voiceprintOnly: 1, modelOnly: 1, neither: 0 },
            onVoiceprintTags: { agree: 0, voiceprintRight: 1, modelRight: 1, bothWrong: 0, modelSilent: 0 },
        });
    });

    it('reconciles the two methods on a voiceprint tag the way opencouncil does', () => {
        const combinedWith = (...answers: SpeakerIdentification[]) => scoreBacktest(input.speakers, answers).summary.combined;

        // S2 is the chair's standing match (15s); S5 a match a reviewer corrected to the mayor (10s).
        // Agreement, or no name the model would act on, leaves the voiceprint's name.
        expect(combinedWith(verdict('S2', 'p-chair', 90))).toMatchObject({ correctNames: 1, wrongNames: 1, withheldNames: 0 });
        expect(combinedWith(verdict('S2', 'p-mayor', 60, { evidenceKind: 'roleBehaviour', actionable: false }))).toMatchObject({ correctNames: 1, withheldNames: 0 });
        // A different name the model would act on withholds the speaker: a right match is lost...
        expect(combinedWith(verdict('S2', 'p-mayor', 90))).toMatchObject({ correctNames: 0, withheldNames: 1, withheldSeconds: 15 });
        // ...and so is a wrong one, when the model names the person the reviewer chose.
        expect(combinedWith(verdict('S5', 'p-mayor', 90))).toMatchObject({ wrongNames: 0, withheldNames: 1, withheldSeconds: 10 });
        // The model wrong as well: it may have repeated the voiceprint's person, so the name counts as published.
        expect(combinedWith(verdict('S5', 'p-chair', 90))).toMatchObject({ wrongNames: 1, wrongSeconds: 10, withheldNames: 0 });
    });

    it('counts a removed voiceprint match as a voiceprint error on an unidentified speaker', () => {
        const data = meeting();
        data.transcript.push({ startTimestamp: 100, endTimestamp: 130, speakerTag: tag('t-gone', 'SPEAKER_9', null, REVIEWED), utterances: [{ text: 'Κάτι.' }] });
        const { summary } = scoreBacktest(buildBacktestInput(data, { anchor: 'none' }).speakers, []);
        expect(summary.voiceprint).toEqual({ peopleNamed: 1, secondsNamed: 15, correctNames: 1, wrongNames: 2, wrongSeconds: 40 });
        expect(summary.combined).toMatchObject({ correctNames: 1, wrongNames: 2, wrongSeconds: 40 });
        expect(summary.model.missed.silent).toEqual({ tags: 4, seconds: 57 });
        expect(summary.onVoiceprintTags).toEqual({ agree: 0, voiceprintRight: 0, modelRight: 0, bothWrong: 0, modelSilent: 2 });
        expect(summary.unlabelledSpeakers).toBe(2);
        expect(summary.rosterPeople).toBe(2);
    });

    it('does not credit the model with speakers it was handed as known', () => {
        const anchored = buildBacktestInput(meeting(), { anchor: 'voiceprint' });
        const { scored, summary } = scoreBacktest(anchored.speakers, [
            { speakerLabel: 'S2', personId: 'p-chair', evidenceKind: null, contested: false, actionable: true, confidence: 100, evidence: 'known before identification', alternatives: [], known: true },
            verdict('S3', 'p-mayor', 95),
        ]);

        expect(scored.find(s => s.label === 'S2')).toMatchObject({ outcome: 'match', known: true });
        expect(summary.model).toMatchObject({ peopleNamed: 1, correctNames: 1, secondsNamed: 30 });
        expect(summary.onVoiceprintTags.agree).toBe(0);
        expect(summary.people).toEqual({ both: 0, voiceprintOnly: 1, modelOnly: 1, neither: 0 });
        // The voiceprint still names the anchor in the combined column.
        expect(summary.combined.peopleNamed).toBe(2);
    });

    it('adds meetings up count by count', () => {
        const first = allOutcomes().summary;
        const second = scoreBacktest(input.speakers, []).summary;
        const total = aggregateSummaries([first, second]);
        expect(total.rosterPeople).toBe(4);
        expect(total.rosterSeconds).toBe(114);
        expect(total.voiceprint).toEqual({ peopleNamed: 2, secondsNamed: 30, correctNames: 2, wrongNames: 2, wrongSeconds: 20 });
        expect(total.model.peopleNamed).toBe(1);
        expect(total.model.missed.silent.tags).toBe(4);
        expect(total.people).toEqual({ both: 0, voiceprintOnly: 2, modelOnly: 1, neither: 1 });
    });

    it('rescores the same answers at each threshold', () => {
        const answers = allOutcomesAnswers();
        const [at60, at90] = thresholdSweep([{ speakers: input.speakers, identifications: answers }], [60, 90]);
        expect(at60.summary.model.peopleNamed).toBe(2);
        expect(at60.summary.model.missed.heldBackRight.tags).toBe(0);
        expect(at90.summary.model.wrongNames).toBe(0);
        expect(formatThresholdSweep([at60, at90], 90)).toContain('90 ←');
    });

    it('estimates cost from list prices', () => {
        expect(estimateCostUsd('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBeCloseTo(4.5);
        expect(estimateCostUsd('some-unknown-model', { input_tokens: 1, output_tokens: 1 })).toBeNull();
    });

    it('scores what the pass acts on by default, and counts a name it would not act on as held back', () => {
        const answers = [
            verdict('S2', 'p-chair', 95),
            verdict('S3', 'p-mayor', 60, { evidenceKind: 'roleBehaviour', actionable: false }),
        ];
        const { scored, summary } = scoreBacktest(input.speakers, answers);
        expect(scored.find(s => s.label === 'S2')).toMatchObject({ outcome: 'match', heldBack: false, evidenceKind: 'named' });
        expect(scored.find(s => s.label === 'S3')).toMatchObject({ outcome: 'missed', heldBack: true, evidenceKind: 'roleBehaviour', predictedPersonId: 'p-mayor' });
        expect(summary.model.missed.heldBackRight.tags).toBe(1);
        // A bare threshold would have taken the role-behaviour guess.
        expect(scoreBacktest(input.speakers, answers, acceptAtConfidence(60)).scored.find(s => s.label === 'S3')?.outcome).toBe('match');
    });

    it('breaks the answers down by kind of evidence, doubted and contested names apart, then what is acted on', () => {
        const answers = [
            verdict('S2', 'p-chair', 95, { evidenceKind: 'named' }),
            verdict('S3', 'p-chair', 90, { evidenceKind: 'addressed' }),
            // A roster name on the resident, on a kind the pass acts on but under its confidence floor.
            verdict('S4', 'p-chair', 70, { evidenceKind: 'named' }),
            verdict('S6', 'p-chair', 60, { evidenceKind: 'roleBehaviour', actionable: false }),
            verdict('S5', 'p-mayor', 90, { evidenceKind: 'named', contested: true, actionable: false }),
        ];
        const rows = evidenceBreakdown([{ speakers: input.speakers, identifications: answers }]);
        const names = (label: string) => {
            const m = rows.find(r => r.label === label)!.summary.model;
            return [m.correctNames, m.wrongNames];
        };
        expect(rows.map(r => r.label)).toEqual(['named', 'rollCall', 'selfIntroduced', 'addressed', 'roleBehaviour', 'no kind given', 'under 75', 'contested', 'acted on']);
        expect(names('named')).toEqual([1, 0]);
        expect(names('addressed')).toEqual([0, 1]);
        expect(names('roleBehaviour')).toEqual([1, 0]);
        // The floor holds the doubted name back: it counts in its own row and nowhere else.
        expect(names('under 75')).toEqual([0, 1]);
        expect(names('contested')).toEqual([1, 0]);
        expect(names('acted on')).toEqual([1, 1]);

        const table = formatEvidenceTable(rows, new Set(['named', 'addressed']));
        expect(table).toMatch(/named\s+yes/);
        expect(table).toMatch(/roleBehaviour\s+no/);
        expect(table).toContain('acted on');
    });

    it('renders a per-person report and a meeting table', () => {
        const { scored, summary } = allOutcomes();
        const report = formatBacktestReport(scored, summary, input.roster, '≥ 70');
        expect(report).toContain('Χάρης Δούκας');
        expect(report).toContain('a reviewer changed the match to Χάρης Δούκας');
        expect(report).toContain('both, reconciled');
        expect(report).toContain('withheld, the methods disagree');
        expect(report).toContain('voiceprint right 1, model right 1');
        const table = formatMeetingTable([{ meeting: 'athens/m1', body: 'Σ', summary, costUsd: 0.25 }], aggregateSummaries([summary]));
        expect(table).toContain('all meetings');
        expect(table).toContain('$0.25');
    });
});
