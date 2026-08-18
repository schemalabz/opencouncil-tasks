import { DiarizationManager } from './DiarizationManager.js';
import { Diarization, DiarizationSpeaker, Transcript, Utterance } from '../types.js';

/**
 * Diarization payload the evaluation consumes: the raw regular timeline plus the
 * exclusive variant. Production's DiarizeResult intentionally carries only the
 * picked timeline (see pickDiarizationTimeline), so eval data keeps its own shape.
 */
export interface EvalDiarizeResult {
    diarization: Diarization;
    exclusiveDiarization?: Diarization;
    speakers: DiarizationSpeaker[];
}

export interface TimelineMetrics {
    segments: number;
    speechSeconds: number;   // union of segment intervals
    overlapSeconds: number;  // time where >= 2 speakers are active
}

export interface VariantMetrics {
    timeline: TimelineMetrics;
    utterances: { total: number; assigned: number; skipped: number; skippedPercent: number };
    ambiguous: number; // utterances overlapping more than one diarization segment
    // Utterances attributed by the nearest-segment fallback (no covering segment)
    fallbackAssigned: number;
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

/**
 * One utterance where the two variants attributed a different speaker, expressed
 * in human terms: what each variant's pick maps to, versus what the reviewers say.
 */
export interface AdjudicatedDisagreement {
    start: number;
    end: number;
    text: string;
    regularSays: string | null;   // display name of regular's pick (null = utterance skipped)
    exclusiveSays: string | null;
    humanSays: string;
    verdict: 'fixed' | 'broken' | 'both-wrong'; // fixed = exclusive matches the reviewer, regular doesn't
}

/**
 * How cleanly each diarized voice maps to one real person. A voice that spans
 * several reviewed speakers is a clustering failure — an error class no choice
 * of timeline can fix, so it bounds what this comparison can achieve at all.
 */
export interface VoicePurity {
    speaker: number;
    utterances: number;
    /** % of this voice's utterances belonging to its majority person */
    purityPercent: number;
    /** distinct reviewed people this voice covers */
    peopleCovered: number;
    majorityPerson: string;
}

export interface ClusteringQuality {
    voices: number;
    /** utterances not matching their voice's majority person */
    impureUtterances: number;
    impurePercent: number;
    /** voices below 90% purity carrying at least 5 utterances */
    mixedVoices: VoicePurity[];
    /** people whose utterances are split across more than one voice */
    peopleSplitAcrossVoices: number;
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
    details: AdjudicatedDisagreement[];
    /** Clustering quality of the exclusive variant — the residual error source */
    clustering: ClusteringQuality;
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
            fallbackAssigned: manager.getNearestFallbackCount(),
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

    // Display names for human tags: prefer the turn's label (the CLI resolves
    // personIds to real names there), fall back to the raw tag
    const tagDisplay = new Map<string, string>();
    for (const turn of humanTurns) {
        if (!tagDisplay.has(turn.tag)) tagDisplay.set(turn.tag, turn.label || turn.tag);
    }
    const display = (tag: string | null) => (tag === null ? null : tagDisplay.get(tag) ?? tag);

    const disagreements = { onlyRegularRight: 0, onlyExclusiveRight: 0, bothRight: 0, neitherRight: 0, noHumanSegment: 0 };
    const details: AdjudicatedDisagreement[] = [];
    utterances.forEach((u, i) => {
        const rs = regular[i]?.speaker ?? null;
        const es = exclusive[i]?.speaker ?? null;
        if (rs === es) return;
        const tag = humanTags[i];
        if (tag === null) { disagreements.noHumanSegment++; return; }
        const rOK = rs !== null && mapR[rs] === tag;
        const eOK = es !== null && mapE[es] === tag;
        if (rOK && eOK) { disagreements.bothRight++; return; }
        if (rOK) disagreements.onlyRegularRight++;
        else if (eOK) disagreements.onlyExclusiveRight++;
        else disagreements.neitherRight++;
        details.push({
            start: u.start,
            end: u.end,
            text: u.text,
            regularSays: display(rs === null ? null : mapR[rs] ?? null),
            exclusiveSays: display(es === null ? null : mapE[es] ?? null),
            humanSays: display(tag)!,
            verdict: eOK ? 'fixed' : rOK ? 'broken' : 'both-wrong',
        });
    });

    return {
        scored: { regular: r.scored, exclusive: e.scored },
        agree: { regular: r.agree, exclusive: e.agree },
        agreementPercent: {
            regular: r.scored ? round2((r.agree / r.scored) * 100) : 0,
            exclusive: e.scored ? round2((e.agree / e.scored) * 100) : 0,
        },
        disagreements,
        details,
        clustering: measureClustering(exclusive, humanTags, display),
    };
}

/**
 * Voice-level diagnosis of the residual error: which diarized voices carry
 * utterances from more than one reviewed person, and how many people end up
 * split across several voices.
 */
function measureClustering(
    assignments: ({ speaker: number } | null)[],
    humanTags: (string | null)[],
    display: (tag: string | null) => string | null,
): ClusteringQuality {
    const votes: Record<number, Record<string, number>> = {};
    assignments.forEach((a, i) => {
        const tag = humanTags[i];
        if (a === null || tag === null) return;
        votes[a.speaker] ??= {};
        votes[a.speaker][tag] = (votes[a.speaker][tag] || 0) + 1;
    });

    let impureUtterances = 0;
    let scored = 0;
    const perVoice: VoicePurity[] = [];
    const majorityOwners: Record<string, number> = {};

    for (const [speaker, tagVotes] of Object.entries(votes)) {
        const ranked = Object.entries(tagVotes).sort((a, b) => b[1] - a[1]);
        const total = ranked.reduce((s, [, n]) => s + n, 0);
        impureUtterances += total - ranked[0][1];
        scored += total;
        majorityOwners[ranked[0][0]] = (majorityOwners[ranked[0][0]] || 0) + 1;
        perVoice.push({
            speaker: Number(speaker),
            utterances: total,
            purityPercent: round2((ranked[0][1] / total) * 100),
            peopleCovered: ranked.length,
            majorityPerson: display(ranked[0][0]) ?? ranked[0][0],
        });
    }

    return {
        voices: perVoice.length,
        impureUtterances,
        impurePercent: scored ? round2((impureUtterances / scored) * 100) : 0,
        mixedVoices: perVoice
            .filter((v) => v.purityPercent < 90 && v.utterances >= 5)
            .sort((a, b) => b.utterances - a.utterances),
        peopleSplitAcrossVoices: Object.values(majorityOwners).filter((c) => c > 1).length,
    };
}

export function compareDiarizationModes(
    transcript: Transcript,
    diarizeResult: EvalDiarizeResult,
    options?: { humanTurns?: HumanTurn[]; meeting?: string },
): DiarizationModeComparison {
    if (!diarizeResult.exclusiveDiarization) {
        throw new Error('Diarization data has no exclusiveDiarization — re-run diarization capturing both timelines (issue #15)');
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
