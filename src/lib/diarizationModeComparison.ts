import { DiarizationManager } from './DiarizationManager.js';
import { Diarization, DiarizationSpeaker, DiarizeResult, Transcript, Utterance } from '../types.js';

export interface TimelineMetrics {
    segments: number;
    speechSeconds: number;   // union of segment intervals
    overlapSeconds: number;  // time where >= 2 speakers are active
}

export interface VariantMetrics {
    timeline: TimelineMetrics;
    utterances: { total: number; assigned: number; skipped: number; skippedPercent: number };
    ambiguous: number; // utterances overlapping more than one diarization segment
    drift: { total: number; mean: number; nonZero: number };
    speakers: { count: number; utterancesPerSpeaker: Record<number, number> };
}

export interface UtteranceDiff {
    start: number;
    end: number;
    text: string;
    regular: number | null;   // assigned speaker number, null = skipped
    exclusive: number | null;
}

/** A human-reviewed speaker turn (from opencouncil's corrected transcript). */
export interface HumanTurn {
    start: number;
    end: number;
    tag: string;             // speakerTagId — stable identity within the meeting
    label?: string | null;
    personId?: string | null;
}

export interface AdjudicatedExample {
    start: number;
    end: number;
    text: string;
    regular: number | null;
    exclusive: number | null;
}

/**
 * Scoring of both variants against human-reviewed speaker turns. Variant speaker
 * numbers are majority-mapped to human tags, then every assigned utterance is
 * scored by the human turn at its midpoint.
 */
export interface Adjudication {
    scored: { regular: number; exclusive: number };
    agree: { regular: number; exclusive: number };
    agreementPercent: { regular: number; exclusive: number };
    // Restricted to utterances where the variants disagree (incl. null-vs-assigned)
    disagreements: {
        onlyRegularRight: number;
        onlyExclusiveRight: number;
        bothRight: number;
        neitherRight: number;
        noHumanSegment: number;
    };
    examples: {
        onlyRegularRight: AdjudicatedExample[];
        onlyExclusiveRight: AdjudicatedExample[];
    };
}

export interface DiarizationModeComparison {
    meta?: {
        meeting?: string;              // cityId/meetingId
        audioDurationSeconds?: number;
    };
    regular: VariantMetrics;
    exclusive: VariantMetrics;
    diff: {
        speakerChanged: UtteranceDiff[];
        rescuedByExclusive: number; // skipped in regular, assigned in exclusive
        lostByExclusive: number;    // assigned in regular, skipped in exclusive
    };
    adjudication?: Adjudication;
    // Embedded so a report file is self-sufficient for rendering visualizations
    timelines?: { regular: Diarization; exclusive: Diarization };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sweep over segment boundaries measuring time covered by >= minActive segments. */
function coveredSeconds(timeline: Diarization, minActive: number): number {
    const events: [number, number][] = [];
    for (const s of timeline) {
        events.push([s.start, 1], [s.end, -1]);
    }
    // Ends sort before starts at equal timestamps so touching segments don't count as overlap
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0;
    let prev = 0;
    let total = 0;
    for (const [t, delta] of events) {
        if (active >= minActive) total += t - prev;
        active += delta;
        prev = t;
    }
    return total;
}

// Same overlap predicate DiarizationManager's fast path uses, so "ambiguous"
// counts exactly the utterances that skip it
function countOverlappingSegments(timeline: Diarization, utterance: Utterance): number {
    return timeline.filter((d) =>
        (d.start <= utterance.end && d.start >= utterance.start) ||
        (d.end <= utterance.end && d.end >= utterance.start) ||
        (d.start <= utterance.start && d.end >= utterance.end)
    ).length;
}

function analyzeVariant(
    timeline: Diarization,
    speakers: DiarizationSpeaker[],
    utterances: Utterance[],
): { metrics: VariantMetrics; assignments: ({ speaker: number; drift: number } | null)[] } {
    const manager = new DiarizationManager(timeline, speakers);
    const assignments = utterances.map((u) => manager.findBestSpeakerForUtterance(u));

    const assigned = assignments.filter((a): a is { speaker: number; drift: number } => a !== null);
    const utterancesPerSpeaker: Record<number, number> = {};
    for (const a of assigned) {
        utterancesPerSpeaker[a.speaker] = (utterancesPerSpeaker[a.speaker] || 0) + 1;
    }
    const totalDrift = assigned.reduce((sum, a) => sum + a.drift, 0);

    return {
        assignments,
        metrics: {
            timeline: {
                segments: timeline.length,
                speechSeconds: round2(coveredSeconds(timeline, 1)),
                overlapSeconds: round2(coveredSeconds(timeline, 2)),
            },
            utterances: {
                total: utterances.length,
                assigned: assigned.length,
                skipped: utterances.length - assigned.length,
                skippedPercent: round2(((utterances.length - assigned.length) / utterances.length) * 100),
            },
            ambiguous: utterances.filter((u) => countOverlappingSegments(timeline, u) > 1).length,
            drift: {
                total: round2(totalDrift),
                mean: assigned.length ? round2(totalDrift / assigned.length) : 0,
                nonZero: assigned.filter((a) => a.drift > 0).length,
            },
            speakers: {
                count: Object.keys(utterancesPerSpeaker).length,
                utterancesPerSpeaker,
            },
        },
    };
}

function humanTagAt(turns: HumanTurn[], time: number): string | null {
    const containing = turns.find((s) => s.start <= time && s.end >= time);
    if (containing) return containing.tag;
    // fall back to the nearest turn within 2s, tolerating boundary rounding
    let best: string | null = null;
    let bestDist = 2;
    for (const s of turns) {
        const dist = time < s.start ? s.start - time : time > s.end ? time - s.end : 0;
        if (dist < bestDist) { best = s.tag; bestDist = dist; }
    }
    return best;
}

function adjudicate(
    utterances: Utterance[],
    regular: ({ speaker: number } | null)[],
    exclusive: ({ speaker: number } | null)[],
    humanTurns: HumanTurn[],
): Adjudication {
    const humanTags = utterances.map((u) => humanTagAt(humanTurns, (u.start + u.end) / 2));

    // Majority-map a variant's speaker numbers to human tags
    const buildMap = (assignments: ({ speaker: number } | null)[]): Record<number, string> => {
        const votes: Record<number, Record<string, number>> = {};
        utterances.forEach((_, i) => {
            const spk = assignments[i]?.speaker;
            const tag = humanTags[i];
            if (spk === undefined || tag === null) return;
            votes[spk] ??= {};
            votes[spk][tag] = (votes[spk][tag] || 0) + 1;
        });
        const map: Record<number, string> = {};
        for (const [spk, tagVotes] of Object.entries(votes)) {
            map[Number(spk)] = Object.entries(tagVotes).sort((a, b) => b[1] - a[1])[0][0];
        }
        return map;
    };

    const mapR = buildMap(regular);
    const mapE = buildMap(exclusive);

    const score = (assignments: ({ speaker: number } | null)[], map: Record<number, string>) => {
        let scored = 0, agree = 0;
        utterances.forEach((_, i) => {
            const spk = assignments[i]?.speaker;
            const tag = humanTags[i];
            if (spk === undefined || tag === null) return;
            scored++;
            if (map[spk] === tag) agree++;
        });
        return { scored, agree };
    };

    const r = score(regular, mapR);
    const e = score(exclusive, mapE);

    const disagreements = { onlyRegularRight: 0, onlyExclusiveRight: 0, bothRight: 0, neitherRight: 0, noHumanSegment: 0 };
    const examples: Adjudication['examples'] = { onlyRegularRight: [], onlyExclusiveRight: [] };
    utterances.forEach((u, i) => {
        const rs = regular[i]?.speaker ?? null;
        const es = exclusive[i]?.speaker ?? null;
        if (rs === es) return;
        const tag = humanTags[i];
        if (tag === null) { disagreements.noHumanSegment++; return; }
        const rOK = rs !== null && mapR[rs] === tag;
        const eOK = es !== null && mapE[es] === tag;
        const example: AdjudicatedExample = { start: u.start, end: u.end, text: u.text, regular: rs, exclusive: es };
        if (rOK && eOK) disagreements.bothRight++;
        else if (rOK) { disagreements.onlyRegularRight++; if (examples.onlyRegularRight.length < 10) examples.onlyRegularRight.push(example); }
        else if (eOK) { disagreements.onlyExclusiveRight++; if (examples.onlyExclusiveRight.length < 10) examples.onlyExclusiveRight.push(example); }
        else disagreements.neitherRight++;
    });

    return {
        scored: { regular: r.scored, exclusive: e.scored },
        agree: { regular: r.agree, exclusive: e.agree },
        agreementPercent: {
            regular: r.scored ? round2((r.agree / r.scored) * 100) : 0,
            exclusive: e.scored ? round2((e.agree / e.scored) * 100) : 0,
        },
        disagreements,
        examples,
    };
}

export function compareDiarizationModes(
    transcript: Transcript,
    diarizeResult: DiarizeResult,
    options?: { humanTurns?: HumanTurn[]; meeting?: string },
): DiarizationModeComparison {
    if (!diarizeResult.exclusiveDiarization) {
        throw new Error('DiarizeResult has no exclusiveDiarization — re-run diarization with exclusive support (issue #15)');
    }

    const utterances = transcript.transcription.utterances;
    // Both variants share the speakers array, so DiarizationManager assigns
    // identical speaker numbers and assignments are directly comparable.
    const regular = analyzeVariant(diarizeResult.diarization, diarizeResult.speakers, utterances);
    const exclusive = analyzeVariant(diarizeResult.exclusiveDiarization, diarizeResult.speakers, utterances);

    const speakerChanged: UtteranceDiff[] = [];
    let rescuedByExclusive = 0;
    let lostByExclusive = 0;
    utterances.forEach((u, i) => {
        const r = regular.assignments[i];
        const e = exclusive.assignments[i];
        if (r === null && e !== null) rescuedByExclusive++;
        if (r !== null && e === null) lostByExclusive++;
        if ((r?.speaker ?? null) !== (e?.speaker ?? null)) {
            speakerChanged.push({ start: u.start, end: u.end, text: u.text, regular: r?.speaker ?? null, exclusive: e?.speaker ?? null });
        }
    });

    return {
        meta: {
            meeting: options?.meeting,
            audioDurationSeconds: transcript.metadata.audio_duration,
        },
        regular: regular.metrics,
        exclusive: exclusive.metrics,
        diff: { speakerChanged, rescuedByExclusive, lostByExclusive },
        adjudication: options?.humanTurns?.length
            ? adjudicate(utterances, regular.assignments, exclusive.assignments, options.humanTurns)
            : undefined,
        timelines: { regular: diarizeResult.diarization, exclusive: diarizeResult.exclusiveDiarization },
    };
}
