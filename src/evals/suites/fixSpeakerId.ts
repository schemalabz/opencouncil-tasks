import { ACTIONABLE_EVIDENCE_KINDS, identifySpeakers, type SpeakerIdentification } from '../../lib/speakerIdentification.js';
import { assignSplit } from '../cases/caseStore.js';
import type { Case, Expected, FieldOutcome, ResultRow, Variant } from '../types.js';
import {
    acceptActionable, aggregateSummaries, buildBacktestInput, evidenceBreakdown, formatBacktestReport, formatEvidenceTable,
    formatMeetingTable, formatThresholdSweep, formatUnlistedEvidenceTable, isRosterSource, scoreBacktest, thresholdSweep, unlistedEvidenceBreakdown,
    type AnchorMode, type BacktestSpeaker, type MeetingApiData, type Outcome, type RosterMode, type TruthSource,
} from './speakerBacktest.js';
import type { Suite } from './suite.js';

/**
 * A speaker-identification case is one meeting as opencouncil's public meeting payload
 * holds it. The model reads the transcript alone (stored identities hidden) and names
 * each speaker; every speaker tag the record identifies is an expectation.
 *
 * `speaker[<speakerTagId>]`: the roster person the record holds, or null for a speaker a
 * reviewer labelled as off the roster. A reviewer's tag (personSetBy 'user') is imported
 * truth; an untouched voiceprint match is drafted.
 */
export type SpeakerIdInput = { meeting: string; data: MeetingApiData };
export type SpeakerIdOutput = { identifications: SpeakerIdentification[] };
export type SpeakerExpectation = { personId: string | null; source: TruthSource };

const FIELD = /^speaker\[(.+)\]$/;

/** Variant params: `anchor` (none | voiceprint), `roster` (meeting | city), `chunkChars`. */
function options(variant?: Variant): { anchor: AnchorMode; roster: RosterMode; chunkChars?: number } {
    const p = variant?.params ?? {};
    return {
        anchor: p.anchor === 'voiceprint' ? 'voiceprint' : 'none',
        roster: p.roster === 'city' ? 'city' : 'meeting',
        ...(typeof p.chunkChars === 'number' && { chunkChars: p.chunkChars }),
    };
}

/** The record's speakers, with the expected person and source in place of the payload's. */
function expectedSpeakers(c: Case<SpeakerIdInput>): { speaker: BacktestSpeaker; field: string }[] {
    const byTag = new Map(buildBacktestInput(c.input.data, { anchor: 'none' }).speakers.map(s => [s.speakerTagId, s]));
    return Object.entries(c.expect).flatMap(([field, e]) => {
        const m = FIELD.exec(field);
        const speaker = m && byTag.get(m[1]);
        if (!speaker) return [];
        const want = e.value as SpeakerExpectation;
        return [{ field, speaker: { ...speaker, personId: want.personId, source: want.source } }];
    });
}

const OUTCOME: Record<Outcome, FieldOutcome> = {
    match: 'agree', offRoster: 'agree', unlistedMatch: 'agree',
    mismatch: 'disagree', wrongOffRoster: 'disagree', unlistedMismatch: 'disagree', unlistedOnRoster: 'disagree',
    missed: 'missing',
    unverified: 'unscorable', unlistedUnverified: 'unscorable', unknown: 'unscorable',
};

function scored(output: SpeakerIdOutput, c: Case<SpeakerIdInput>) {
    const expected = expectedSpeakers(c);
    const { scored } = scoreBacktest(expected.map(e => e.speaker), output.identifications, acceptActionable);
    return expected.map((e, i) => ({ field: e.field, s: scored[i] }));
}

export function scoreSpeakerId(output: SpeakerIdOutput, c: Case<SpeakerIdInput>): Record<string, FieldOutcome> {
    return Object.fromEntries(scored(output, c).map(({ field, s }) => [field, OUTCOME[s.outcome]]));
}

function detailSpeakerId(output: SpeakerIdOutput, c: Case<SpeakerIdInput>): Record<string, string> {
    return Object.fromEntries(scored(output, c).map(({ field, s }) => [field, s.heldBack ? `${s.outcome} (held back)` : s.outcome]));
}

/** What the speaker-tag signals say about a tag: who made it, and when. */
export type TagSignal = { by: string; at: string; signal: string };

/**
 * One expectation per speaker tag the record identifies. A tag is a person's word when a
 * signal says so, or the payload records personSetBy 'user'; a payload from before
 * sources were recorded (no personSetBy at all) counts a reviewer's edit as truthSource
 * reads it. An untouched voiceprint match is drafted. Tags nobody identified, and
 * voiceprint matches a reviewer removed (their speaker is unknown), are left out.
 */
export function speakerIdCase(meeting: string, data: MeetingApiData, signals: Map<string, TagSignal> = new Map(), now = new Date()): Case<SpeakerIdInput> {
    const [cityId, meetingId] = meeting.split('/');
    const id = `fix.speaker-id/${cityId}-${meetingId}`;
    const at = now.toISOString().slice(0, 10);
    const tags = new Map(data.transcript.map(s => [s.speakerTag.id, s.speakerTag]));
    const expect: Record<string, Expected> = {};
    for (const s of buildBacktestInput(data, { anchor: 'none' }).speakers) {
        if (!isRosterSource(s.source) && s.source !== 'offRoster') continue;
        const value: SpeakerExpectation = { personId: isRosterSource(s.source) ? s.personId : null, source: s.source };
        const tag = tags.get(s.speakerTagId);
        const signal = signals.get(s.speakerTagId);
        const reviewer = signal || tag?.personSetBy === 'user' || (tag?.personSetBy === undefined && s.source !== 'voiceprint');
        expect[`speaker[${s.speakerTagId}]`] = reviewer
            ? { value, tier: 'imported', by: signal?.by ?? 'user', at: signal?.at ?? at, source: 'opencouncil:speaker-tag', signal: signal?.signal ?? `speaker-tag:${s.speakerTagId}` }
            : { value, tier: 'drafted', by: 'voiceprint', at, source: 'opencouncil:voiceprint-match' };
    }
    return {
        id, suite: 'fix.speaker-id', split: assignSplit(id), input: { meeting, data }, replay: null, expect,
        cluster: `${cityId}/${data.meeting.administrativeBody?.name ?? 'unknown body'}`, tags: ['opencouncil-signals'],
    };
}

/** The backtest's tables over a run: per meeting, the evidence kinds, and a confidence sweep. */
function reportSpeakerId(rows: ResultRow[], cases: Case<SpeakerIdInput>[]): string {
    const byId = new Map(cases.map(c => [c.id, c]));
    const meetings = rows.flatMap(row => {
        const c = byId.get(row.caseId);
        if (!c) return [];
        const input = buildBacktestInput(c.input.data, { anchor: 'none' });
        const { identifications } = row.output as SpeakerIdOutput;
        const { scored, summary } = scoreBacktest(input.speakers, identifications, acceptActionable);
        return [{ meeting: `${c.input.meeting}${row.rep ? ` #${row.rep}` : ''}`, body: input.administrativeBodyName, roster: input.roster, speakers: input.speakers, identifications, scored, summary, costUsd: row.costUsd }];
    });
    if (meetings.length === 0) return '(no rows)';
    const out: string[] = [];
    if (meetings.length === 1) out.push(formatBacktestReport(meetings[0].scored, meetings[0].summary, meetings[0].roster, 'acted on'), '');
    out.push(formatMeetingTable(meetings, aggregateSummaries(meetings.map(m => m.summary))), '');
    out.push('EVIDENCE', formatEvidenceTable(evidenceBreakdown(meetings), ACTIONABLE_EVIDENCE_KINDS), '');
    out.push('UNLISTED EVIDENCE', formatUnlistedEvidenceTable(unlistedEvidenceBreakdown(meetings)), '');
    out.push('CONFIDENCE THRESHOLDS', formatThresholdSweep(thresholdSweep(meetings)));
    return out.join('\n');
}

export const fixSpeakerId: Suite<SpeakerIdInput, SpeakerIdOutput> = {
    id: 'fix.speaker-id',
    task: 'fixTranscript',
    labels: ['speaker-identification:*'],
    run: async (c, ctx) => {
        const { anchor, roster, chunkChars } = options(ctx.variant);
        const input = buildBacktestInput(c.input.data, { anchor, roster });
        if (input.segments.length === 0) throw new Error(`${c.id}: the meeting has no transcript`);
        const run = await identifySpeakers({
            cityName: input.cityName, language: input.language, meetingDate: input.meetingDate,
            administrativeBodyName: input.administrativeBodyName, roster: input.roster, segments: input.segments,
            knownSpeakers: input.knownSpeakers, ...(chunkChars && { chunkChars }),
        });
        // A missing chunk would count its speakers as missed.
        if (run.failedChunks.length > 0) {
            throw new Error(`${run.failedChunks.length} chunk(s) got no answer (chunk ${run.failedChunks[0].chunk}: ${run.failedChunks[0].reason})`);
        }
        return { identifications: run.result };
    },
    score: scoreSpeakerId,
    detail: detailSpeakerId,
    caseFromMeeting: (meeting, payload) => speakerIdCase(meeting, payload as MeetingApiData),
    report: reportSpeakerId,
};
