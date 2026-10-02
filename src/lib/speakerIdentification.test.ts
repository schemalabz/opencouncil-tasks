import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chunkSegments, isActionable, mergeChunkIdentifications, sanitizeChunkVerdicts, sameName, buildSystemPrompt, buildUserPrompt, ChunkIdentification, SpeakerEvidenceKind, SpeakerSegmentInput, ModelVerdict, SPEAKER_EVIDENCE_KINDS } from './speakerIdentification.js';

const seg = (speakerLabel: string, start: number, text: string): SpeakerSegmentInput => ({ speakerLabel, start, end: start + 1, text });

describe('chunkSegments', () => {
    it('keeps segments contiguous and never splits one', () => {
        const segments = [seg('S1', 0, 'a'.repeat(30)), seg('S2', 1, 'b'.repeat(30)), seg('S1', 2, 'c'.repeat(30))];
        const chunks = chunkSegments(segments, 100);
        expect(chunks.map(c => c.map(s => s.text[0]))).toEqual([['a', 'b'], ['c']]);
    });

    it('gives an oversized segment its own chunk', () => {
        const chunks = chunkSegments([seg('S1', 0, 'x'), seg('S2', 1, 'y'.repeat(500)), seg('S3', 2, 'z')], 100);
        expect(chunks.map(c => c.length)).toEqual([1, 1, 1]);
    });
});

describe('mergeChunkIdentifications', () => {
    const c = (speakerLabel: string, personId: string | null, confidence: number, evidence: string, evidenceKind: SpeakerEvidenceKind | null = personId ? 'named' : null): ChunkIdentification =>
        ({ speakerLabel, personId, evidenceKind, confidence, evidence });

    it('sums confidence per candidate across chunks and keeps the strongest evidence', () => {
        const merged = mergeChunkIdentifications([
            [c('S1', 'a', 60, 'first', 'addressed')],
            [c('S1', 'a', 90, 'second', 'named'), c('S2', null, 0, '')],
        ], ['S1', 'S2']);
        expect(merged).toEqual([
            { speakerLabel: 'S1', personId: 'a', evidenceKind: 'named', contested: false, actionable: true, confidence: 90, evidence: 'second', alternatives: [], known: false },
            { speakerLabel: 'S2', personId: null, evidenceKind: null, contested: false, actionable: false, confidence: 0, evidence: '', alternatives: [], known: false },
        ]);
    });

    it('reports the verdict with the strongest kind whole, so the quote is the cue the pass went by', () => {
        const [merged] = mergeChunkIdentifications([
            [c('S1', 'a', 95, 'chairs the session', 'roleBehaviour')],
            [c('S1', 'a', 70, 'answers the roll call', 'rollCall')],
        ], ['S1']);
        expect(merged).toMatchObject({ evidenceKind: 'rollCall', confidence: 70, evidence: 'answers the roll call', actionable: true });
    });

    it('takes the more confident verdict when two rest on the same kind', () => {
        const [merged] = mergeChunkIdentifications([
            [c('S1', 'a', 80, 'first floor grant', 'named')],
            [c('S1', 'a', 95, 'second floor grant', 'named')],
        ], ['S1']);
        expect(merged).toMatchObject({ evidenceKind: 'named', confidence: 95, evidence: 'second floor grant' });
    });

    it('does not act on a label when a rival candidate is close, and leaves the number alone', () => {
        const [merged] = mergeChunkIdentifications([
            [c('S1', 'a', 90, 'a1')],
            [c('S1', 'b', 70, 'b1')],
        ], ['S1']);
        expect(merged).toMatchObject({ personId: 'a', contested: true, actionable: false, confidence: 90 });
        expect(merged.alternatives).toEqual([{ personId: 'b', confidence: 70 }]);
    });

    it('acts on a label whose rival is weak', () => {
        const [merged] = mergeChunkIdentifications([
            [c('S1', 'a', 95, 'a1')],
            [c('S1', 'a', 90, 'a2')],
            [c('S1', 'b', 40, 'b1')],
        ], ['S1']);
        expect(merged).toMatchObject({ contested: false, actionable: true, confidence: 95 });
    });

    it('does not act on role behaviour alone, however confident the model is', () => {
        const [merged] = mergeChunkIdentifications([[c('S1', 'a', 100, 'opens the session', 'roleBehaviour')]], ['S1']);
        expect(merged).toMatchObject({ personId: 'a', evidenceKind: 'roleBehaviour', actionable: false });
    });

    it('passes known speakers through untouched', () => {
        const [merged] = mergeChunkIdentifications([
            [c('S1', 'wrong', 99, 'ignored')],
        ], ['S1'], [{ speakerLabel: 'S1', personId: 'known' }]);
        expect(merged).toMatchObject({ personId: 'known', confidence: 100, known: true, actionable: true });
    });
});

describe('isActionable', () => {
    it('acts on every kind of evidence that names the speaker, and on nothing else', () => {
        const acted = SPEAKER_EVIDENCE_KINDS.filter(evidenceKind => isActionable({ personId: 'a', evidenceKind, contested: false }));
        expect(acted).toEqual(['named', 'rollCall', 'selfIntroduced', 'addressed']);
        expect(isActionable({ personId: 'a', evidenceKind: null, contested: false })).toBe(false);
        expect(isActionable({ personId: 'a', evidenceKind: 'named', contested: true })).toBe(false);
        expect(isActionable({ personId: null, evidenceKind: 'named', contested: false })).toBe(false);
    });

    it('is asked of the model in the same words the code uses', () => {
        const prompt = buildSystemPrompt('el');
        for (const kind of SPEAKER_EVIDENCE_KINDS) expect(prompt).toContain(`"${kind}"`);
    });
});

describe('sameName', () => {
    it('ignores accents, case and final sigma, and allows a surname alone', () => {
        expect(sameName('Βασίλειος Κωνστανταράκης', 'ΚΩΝΣΤΑΝΤΑΡΑΚΗΣ')).toBe(true);
        expect(sameName('Σοφία Ελευθεριάδου-Παπαδάκη', 'Σοφία Ελευθεριάδου Παπαδάκη')).toBe(true);
    });

    it('tells apart similar surnames', () => {
        expect(sameName('Βασίλειος Κωνστανταράκης', 'Αλέξανδρος Κοντορινάκης')).toBe(false);
        expect(sameName('Βασίλειος Κωνστανταράκης', 'Κοντορινάκης')).toBe(false);
    });
});

describe('sanitizeChunkVerdicts', () => {
    const roster = [
        { id: 'id-a', name: 'Βασίλειος Κωνστανταράκης', role: null, party: null },
        { id: 'id-b', name: 'Αλέξανδρος Κοντορινάκης', role: null, party: null },
    ];
    const v = (speakerLabel: string, person: string | null, personName: string | null, confidence = 80, evidence = '', evidenceKind: string | null = 'named'): ModelVerdict =>
        ({ speakerLabel, person, personName, evidenceKind, confidence, evidence });

    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('drops labels outside the chunk and duplicate labels', () => {
        const kept = sanitizeChunkVerdicts([
            v('S9', 'P1', 'Βασίλειος Κωνστανταράκης', 90),
            v('S1', 'P1', 'Βασίλειος Κωνστανταράκης', 80, 'first'),
            v('S1', null, null, 0, 'dup'),
        ], new Set(['S1']), roster);
        expect(kept).toEqual([{ speakerLabel: 'S1', personId: 'id-a', evidenceKind: 'named', confidence: 80, evidence: 'first' }]);
    });

    it('keeps a kind the code knows, and gives no kind to an unknown speaker or a made-up kind', () => {
        const kept = sanitizeChunkVerdicts([
            v('S1', 'P1', 'Βασίλειος Κωνστανταράκης', 90, '', 'rollCall'),
            v('S2', 'P2', 'Αλέξανδρος Κοντορινάκης', 90, '', 'overheard'),
            v('S3', null, null, 0, '', 'named'),
        ], new Set(['S1', 'S2', 'S3']), roster);
        expect(kept.map(k => k.evidenceKind)).toEqual(['rollCall', null, null]);
    });

    it('accepts a key whose roster name agrees with the name given', () => {
        const kept = sanitizeChunkVerdicts([v('S1', 'P2', 'Κοντορινάκης'), v('S2', 'p1', 'ΚΩΝΣΤΑΝΤΑΡΑΚΗΣ'), v('S3', 'P2', null)], new Set(['S1', 'S2', 'S3']), roster);
        expect(kept.map(k => k.personId)).toEqual(['id-b', 'id-a', 'id-b']);
    });

    it('trusts the name over a mis-copied key', () => {
        const [kept] = sanitizeChunkVerdicts([v('S1', 'P2', 'Βασίλειος Κωνστανταράκης', 95)], new Set(['S1']), roster);
        expect(kept).toMatchObject({ personId: 'id-a', confidence: 95 });
    });

    it('treats a verdict without a key as unknown, even when it carries a name the roster has', () => {
        const kept = sanitizeChunkVerdicts([v('S1', null, 'Κοντορινάκης', 85), v('S2', '  ', 'Βασίλειος Κωνστανταράκης', 90)], new Set(['S1', 'S2']), roster);
        expect(kept.map(k => [k.personId, k.confidence])).toEqual([[null, 0], [null, 0]]);
    });

    it('drops a verdict that key and name do not pin to one roster person', () => {
        const kept = sanitizeChunkVerdicts([v('S1', 'P7', 'Κάποιος Άλλος', 90), v('S2', 'P9', null, 90), v('S3', 'P1', 'Κοντορινάκης Κάποιος', 90)], new Set(['S1', 'S2', 'S3']), roster);
        expect(kept.map(k => [k.personId, k.confidence])).toEqual([[null, 0], [null, 0], [null, 0]]);
    });
});

describe('buildUserPrompt', () => {
    const base = { cityName: 'Αθήνα', meetingDate: '2026-09-14', chunkIndex: 0, chunkCount: 2, segments: [seg('S1', 61, 'Καλησπέρα.')] };

    it('lists the roster under short keys, known speakers, and timestamped transcript lines', () => {
        const prompt = buildUserPrompt({
            ...base,
            administrativeBodyName: null,
            roster: [{ id: 'id-1', name: 'Άννα Παπά', role: 'Δήμαρχος', party: 'Κόμμα' }, { id: 'id-2', name: 'Β. Γ.', role: null, party: null }],
            knownSpeakers: [{ speakerLabel: 'S2', personId: 'id-1' }],
        });
        expect(prompt).toContain('Body meeting: (unknown)');
        expect(prompt).toContain('Roster (key — name (roles, party)):\nP1 — Άννα Παπά (Δήμαρχος, Κόμμα)\nP2 — Β. Γ.\n');
        expect(prompt).toContain('S2 = P1 Άννα Παπά');
        expect(prompt).toContain('Transcript chunk 1 of 2:\n[00:01:01] S1: Καλησπέρα.');
        expect(prompt).not.toContain('id-1');
    });

    it('splits the roster into members of the meeting body and everyone else, keeping each key', () => {
        const prompt = buildUserPrompt({
            ...base,
            administrativeBodyName: 'Δημοτική Επιτροπή',
            knownSpeakers: [],
            roster: [
                { id: 'id-1', name: 'Άννα Παπά', role: null, party: null },
                { id: 'id-2', name: 'Β. Γ.', role: 'Πρόεδρος, Δημοτική Επιτροπή', party: null, memberOfMeetingBody: true },
            ],
        });
        expect(prompt).toContain('Body meeting: Δημοτική Επιτροπή');
        expect(prompt).toContain('Members of Δημοτική Επιτροπή (key — name (roles, party)):\nP2 — Β. Γ. (Πρόεδρος, Δημοτική Επιτροπή)\n\nOther people of the municipality:\nP1 — Άννα Παπά\n');
    });
});
