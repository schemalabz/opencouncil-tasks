import { alignStreams, type Alignment } from "./align.js";
import { tokenize, type Token } from "./text.js";
import type { Turn } from "./turns.js";

/**
 * The minutes' turns against our timed utterances: the two token streams,
 * their alignment, and what it says about each utterance and each turn.
 */

/**
 * The verbatim gate: the share of a turn's words found in our transcript, in
 * order, under which the turn is a paraphrase and corrects nothing. A starting
 * value: the backtest (docs/minutes-correction.md) sets it from reviewed meetings.
 */
export const VERBATIM_GATE = 0.6;

export type TimedUtterance = {
    utteranceId: string;
    text: string;
    start: number;
    end: number;
    speakerTagId: string | null;
    /** The speaker the request carries for the segment, from any method. */
    speakerId: string | null;
};

/** A token of a stream with where it came from. */
export type StreamToken = Token & { source: number };

export type UtteranceMatch = {
    tokens: number;
    /** Tokens with an equal token in the minutes. */
    matched: number;
    /** Matched tokens per turn. An utterance whose words fall in two turns counts in both, each for its words. */
    byTurn: Map<number, number>;
};

export type TurnMatch = {
    tokens: number;
    matched: number;
    /** matched / tokens; 0 for an empty turn. */
    matchRate: number;
};

export type Matching = {
    ours: StreamToken[];
    minutes: StreamToken[];
    alignment: Alignment;
    utterances: UtteranceMatch[];
    turns: TurnMatch[];
};

export function buildStream(parts: { text: string }[]): StreamToken[] {
    return parts.flatMap((part, source) => tokenize(part.text).map(token => ({ ...token, source })));
}

/** Aligns and reads the alignment back per utterance and per turn. */
export function matchMinutes(turns: Turn[], utterances: TimedUtterance[]): Matching {
    const ours = buildStream(utterances);
    const minutes = buildStream(turns);
    const alignment = alignStreams(ours.map(t => t.norm), minutes.map(t => t.norm));

    const utteranceMatches: UtteranceMatch[] = utterances.map(() => ({ tokens: 0, matched: 0, byTurn: new Map() }));
    ours.forEach((token, i) => {
        const match = utteranceMatches[token.source];
        match.tokens++;
        const j = alignment.aToB[i];
        if (j < 0) return;
        match.matched++;
        const turnIndex = minutes[j].source;
        match.byTurn.set(turnIndex, (match.byTurn.get(turnIndex) ?? 0) + 1);
    });

    const turnMatches: TurnMatch[] = turns.map(() => ({ tokens: 0, matched: 0, matchRate: 0 }));
    minutes.forEach((token, j) => {
        const match = turnMatches[token.source];
        match.tokens++;
        if (alignment.bToA[j] >= 0) match.matched++;
    });
    for (const match of turnMatches) match.matchRate = match.tokens === 0 ? 0 : match.matched / match.tokens;

    return { ours, minutes, alignment, utterances: utteranceMatches, turns: turnMatches };
}

/** The turn passes the verbatim gate: its words are our words, in order, often enough to trust its spelling. */
export const passesGate = (turn: TurnMatch, gate = VERBATIM_GATE): boolean => turn.matched > 0 && turn.matchRate >= gate;
