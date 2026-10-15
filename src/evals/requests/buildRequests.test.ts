import { describe, expect, it } from 'vitest';
import { buildFixTranscriptRequest, buildPollDecisionsRequest, buildProcessAgendaRequest, buildSummarizeRequest, type PublicMeetingPayload, type PublicRole, type PublicSegment, type PublicSubject } from './buildRequests.js';

const COUNCIL = { id: 'council', name: 'Δημοτικό Συμβούλιο', type: 'council' };
const COMMITTEE = { id: 'committee', name: 'Δημοτική Επιτροπή', type: 'committee' };
const COMMUNITY = { id: 'community', name: 'Κοινότητα Α', type: 'community' };

const role = (r: Partial<PublicRole>): PublicRole => ({
    cityId: null, partyId: null, administrativeBodyId: null, isHead: false, name: null, name_en: null, startDate: null, endDate: null, ...r,
});
const bodyRole = (body: typeof COUNCIL, r: Partial<PublicRole> = {}) => role({ administrativeBodyId: body.id, administrativeBody: body, ...r });
const blue = { partyId: 'blue', party: { name: 'Μπλε' } };

const subject = (s: Partial<PublicSubject> & { id: string }): PublicSubject => ({
    name: `Θέμα ${s.id}`, description: '', agendaItemIndex: null, nonAgendaReason: null, withdrawn: false, context: null, contextCitationUrls: [],
    topicImportance: null, proximityImportance: null, introducedBy: null, topic: null, location: null, contributions: [], decision: null, ...s,
});
const segment = (id: string, tag: string, personId: string | null, start: number, subjectId: string | null = null): PublicSegment => ({
    id, startTimestamp: start, endTimestamp: start + 5, speakerTagId: tag,
    speakerTag: { id: tag, label: `SPEAKER_${tag}`, personId },
    utterances: [{ id: `${id}-u`, text: `λόγια ${id}`, startTimestamp: start, endTimestamp: start + 5, discussionSubjectId: subjectId }],
});

function payload(body: typeof COUNCIL, conventions?: unknown): PublicMeetingPayload {
    return {
        meeting: {
            id: 'sep8_2026', cityId: 'testville',
            // Local midnight in Athens: the UTC date is the day before.
            dateTime: '2026-09-07T21:00:00.000Z',
            agendaUrl: 'https://example.org/agenda.pdf',
            administrativeBodyId: body.id,
            administrativeBody: { ...body, diavgeiaUnitIds: ['12345'], decisionConventions: conventions },
        },
        city: { name: 'Δοκιμούπολη', language: 'el', realm: 'greece', timezone: 'Europe/Athens', diavgeiaUid: '999' },
        people: [
            { id: 'mayor', name: 'Ζωή Δημάρχου', roles: [role({ cityId: 'testville', isHead: true, name: 'Δήμαρχος' }), bodyRole(COMMITTEE, { isHead: true, name: 'Πρόεδρος' })] },
            { id: 'chair', name: 'Άννα Προέδρου', roles: [bodyRole(COUNCIL, { isHead: true, name: 'Πρόεδρος' }), role(blue)] },
            { id: 'member', name: 'Βασίλης Μέλους', roles: [bodyRole(COUNCIL), bodyRole(COMMITTEE), role({ ...blue, endDate: '2026-01-01T00:00:00.000Z' })] },
            { id: 'villager', name: 'Γιώργος Χωριού', roles: [bodyRole(COMMUNITY)] },
        ],
        subjects: [
            subject({ id: 's1', agendaItemIndex: 1, agendaItemTitle: 'Έγκριση προϋπολογισμού', decision: { ada: 'ΑΔΑ1', title: 'Απόφαση 1', pdfUrl: 'https://example.org/1.pdf' } }),
            subject({ id: 's2', agendaItemIndex: 2, location: { type: 'point', text: 'Πλατεία', coordinates: { x: 23.7, y: 37.9 } } }),
            subject({ id: 's3', nonAgendaReason: 'outOfAgenda', contributions: [{ speakerId: 'chair', speakerName: null, text: 'είπε', speaker: { name: 'Άννα Προέδρου' } }] }),
            subject({ id: 's4', nonAgendaReason: 'beforeAgenda' }),
            subject({ id: 's5', agendaItemIndex: 3, withdrawn: true }),
            subject({ id: 's6' }),
        ],
        transcript: [
            segment('g1', 'A', 'chair', 0),
            segment('g2', 'B', 'chair', 10, 's3'),
            segment('g3', 'C', null, 20, 's2'),
            segment('g4', 'A', 'chair', 30, 's1'),
        ],
    };
}

const topics = [{ name: 'Οικονομικά', description: 'Προϋπολογισμός' }];
const glossary = {
    conventions: {
        rollCallLayout: { present_and_absent: { hint: 'Separate lists.' } },
        presentListMeaning: { opening: { hint: 'Opening roll call.' } },
        attendanceChangeAnchors: { agenda_item: { label: 'agenda item' } },
        anchors: { some: 'Pinned to:', none: 'No changes stated.' },
        usesSubstitutes: { hint: 'Substitutes appear.' },
    },
};
const conventions = {
    version: 1, rollCallLayout: 'present_and_absent', presentListMeaning: 'opening', attendanceChangeAnchors: ['agenda_item', 'clock_time'],
    statesPerDecisionAttendance: false, statesPerVoteAbsence: false, usesSubstitutes: true, namedVoters: 'none', mayorStatedSeparately: false,
    provenance: { source: 'profile' },
};

describe('buildFixTranscriptRequest', () => {
    const request = buildFixTranscriptRequest(payload(COUNCIL), topics);

    it('keeps two tags of one person apart, and names an unknown speaker by its tag label', () => {
        expect(request.transcript.map(s => s.speakerSegmentId)).toEqual(['g1', 'g2', 'g3', 'g4']);
        expect(request.transcript[1]).toMatchObject({ speakerName: 'Άννα Προέδρου', speakerId: 'chair', speakerTagId: 'B', speakerParty: 'Μπλε', speakerRole: 'Πρόεδρος' });
        expect(request.transcript[2]).toMatchObject({ speakerName: 'SPEAKER_C', speakerId: null, speakerParty: null });
        expect(request.transcript[0].utterances[0]).toEqual({ text: 'λόγια g1', utteranceId: 'g1-u', startTimestamp: 0, endTimestamp: 5 });
    });

    it('sends who may speak, by name, with the meeting header fields', () => {
        // The community member is not on the list; the mayor is, by a city-level role.
        expect(request.people?.map(p => p.id)).toEqual(['chair', 'member', 'mayor']);
        expect(request.people?.find(p => p.id === 'member')).toMatchObject({ party: null, memberOfMeetingBody: true });
        expect(request).toMatchObject({ cityName: 'Δοκιμούπολη', cityLanguage: 'el', country: 'GR', administrativeBodyName: 'Δημοτικό Συμβούλιο', date: '2026-09-07', topicLabels: topics });
        expect(request).not.toHaveProperty('agendaItems');
    });
});

describe('buildSummarizeRequest', () => {
    const request = buildSummarizeRequest(payload(COUNCIL), topics);

    it('joins adjacent segments of one person across tags', () => {
        expect(request.transcript.map(s => s.speakerSegmentId)).toEqual(['g1', 'g3', 'g4']);
        expect(request.transcript[0].utterances.map(u => u.utteranceId)).toEqual(['g1-u', 'g2-u']);
        expect(request.transcript[0].text).toBe('λόγια g1 λόγια g2');
    });

    it('sends the agenda and non-agenda subjects as the app stores them', () => {
        expect(request.requestedSubjects).toEqual([]);
        expect(request.existingSubjects.map(s => [s.id, s.agendaItemIndex])).toEqual([['s1', 1], ['s2', 2], ['s3', 'OUT_OF_AGENDA'], ['s4', 'BEFORE_AGENDA'], ['s5', 3]]);
        expect(request.existingSubjects[1].location).toEqual({ type: 'point', text: 'Πλατεία', coordinates: [[23.7, 37.9]] });
        expect(request.existingSubjects[2].speakerContributions).toEqual([{ speakerId: 'chair', speakerName: 'Άννα Προέδρου', text: 'είπε' }]);
        expect(request.existingSubjects[0]).toMatchObject({ topicImportance: 'normal', proximityImportance: 'none', context: null });
    });
});

describe('buildProcessAgendaRequest', () => {
    it('sends only the members of a committee, with role and party on the meeting date', () => {
        const request = buildProcessAgendaRequest(payload(COMMITTEE), topics);
        expect(request.people).toEqual([
            { id: 'member', name: 'Βασίλης Μέλους', role: 'Δημοτική Επιτροπή', party: '' },
            { id: 'mayor', name: 'Ζωή Δημάρχου', role: 'Πρόεδρος', party: '' },
        ]);
        expect(request).toMatchObject({ agendaUrl: 'https://example.org/agenda.pdf', date: '2026-09-07T21:00:00.000Z', country: 'GR', cityName: 'Δοκιμούπολη' });
    });
});

describe('buildPollDecisionsRequest', () => {
    it('sends the eligible subjects in discussion order with the body scope and its conventions', () => {
        const request = buildPollDecisionsRequest(payload(COMMITTEE, conventions), glossary);
        expect(request).toMatchObject({
            meetingDate: '2026-09-08', diavgeiaUid: '999', diavgeiaUnitIds: ['12345'], administrativeBodyName: 'Δημοτική Επιτροπή',
            extract: true, mayorId: 'mayor', window: { fromDate: '2026-09-08', toDate: '2026-10-08' },
        });
        expect(request.conventionsText).toBe('Separate lists.\nOpening roll call.\nPinned to: agenda item.\nSubstitutes appear.');
        expect(request.subjects.map(s => s.subjectId)).toEqual(['s3', 's2', 's1']);
        expect(request.subjects.find(s => s.subjectId === 's1')).toMatchObject({
            name: 'Έγκριση προϋπολογισμού',
            existingDecision: { ada: 'ΑΔΑ1', decisionTitle: 'Απόφαση 1', pdfUrl: 'https://example.org/1.pdf', needsExtraction: true },
        });
    });

    it('links only, without conventions', () => {
        const request = buildPollDecisionsRequest(payload(COMMITTEE, { version: 1 }), glossary);
        expect(request.extract).toBe(false);
        expect(request.conventionsText).toBeUndefined();
    });
});
