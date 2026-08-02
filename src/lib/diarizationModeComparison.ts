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

export interface DiarizationModeComparison {
    regular: VariantMetrics;
    exclusive: VariantMetrics;
    diff: {
        speakerChanged: UtteranceDiff[];
        rescuedByExclusive: number; // skipped in regular, assigned in exclusive
        lostByExclusive: number;    // assigned in regular, skipped in exclusive
    };
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

export function compareDiarizationModes(transcript: Transcript, diarizeResult: DiarizeResult): DiarizationModeComparison {
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
        regular: regular.metrics,
        exclusive: exclusive.metrics,
        diff: { speakerChanged, rescuedByExclusive, lostByExclusive },
    };
}
