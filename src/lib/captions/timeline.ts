import { createTikTokStyleCaptions, Caption } from '@remotion/captions';
import type { CaptionPage, CaptionPreset, CaptionTimeline, SpeakerSpan, UtteranceForCaptions, WordTiming } from './types.js';

// '.', '!', '?', ';' (U+003B, ASCII semicolon, Greek question-mark lookalike), U+037E (real Greek question mark), ellipsis
const SENTENCE_END = /[.!?;\u037E…]$/;

function pagesForUtterance(
    u: UtteranceForCaptions,
    words: WordTiming[],
    layout: CaptionPreset['layout'],
): CaptionPage[] {
    if (words.length === 0) return [];

    const captions: Caption[] = words.map(w => ({
        text: ` ${w.text}`,
        startMs: w.startMs,
        endMs: w.endMs,
        timestampMs: null,
        confidence: null,
    }));
    // combineTokensWithinMilliseconds alone is a page-duration cap, not a gap
    // detector (it only looks at elapsed span, lagged by one token) — real
    // pause-based breaks need breakOnSilenceAfterMilliseconds, which compares
    // the next word's startMs against the current page's last endMs directly.
    const { pages: rawPages } = createTikTokStyleCaptions({
        captions,
        combineTokensWithinMilliseconds: layout.combineWithinMs,
        breakOnSilenceAfterMilliseconds: layout.combineWithinMs,
    });

    // Flatten back to tokens, but record the index where each raw page ended —
    // @remotion/captions already split there because the gap to the next word
    // exceeded combineWithinMs, and the re-chunk loop below must preserve that
    // pause boundary instead of only enforcing word-count/punctuation limits.
    const tokens: { text: string; fromMs: number; toMs: number }[] = [];
    const pauseBoundaries = new Set<number>();
    for (const rawPage of rawPages) {
        for (const t of rawPage.tokens) {
            tokens.push({ text: t.text.trim(), fromMs: t.fromMs, toMs: t.toMs });
        }
        if (rawPage.tokens.length > 0) pauseBoundaries.add(tokens.length - 1);
    }

    const chunks: typeof tokens[] = [];
    let current: typeof tokens = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        current.push(token);
        if (current.length >= layout.maxWordsPerPage || SENTENCE_END.test(token.text) || pauseBoundaries.has(i)) {
            chunks.push(current);
            current = [];
        }
    }
    if (current.length > 0) chunks.push(current);

    return chunks.map((chunk, i) => {
        const nextStart = i + 1 < chunks.length ? chunks[i + 1][0].fromMs : u.endMs;
        const naturalEnd = chunk[chunk.length - 1].toMs;
        const endMs = Math.min(nextStart, Math.max(naturalEnd, chunk[0].fromMs + layout.minPageDurationMs));
        return { startMs: chunk[0].fromMs, endMs, tokens: chunk };
    });
}

function buildSpeakerSpans(utterances: UtteranceForCaptions[]): SpeakerSpan[] {
    const spans: SpeakerSpan[] = [];
    for (const u of utterances) {
        if (!u.speaker) continue;
        const last = spans[spans.length - 1];
        if (last && last.endMs === u.startMs && last.speaker.name === u.speaker.name) {
            last.endMs = u.endMs;
        } else {
            spans.push({ startMs: u.startMs, endMs: u.endMs, speaker: u.speaker });
        }
    }
    return spans;
}

export function buildCaptionTimeline(
    utterances: UtteranceForCaptions[],
    wordsPerUtterance: WordTiming[][],
    layout: CaptionPreset['layout'],
): CaptionTimeline {
    const pages = utterances.flatMap((u, i) => pagesForUtterance(u, wordsPerUtterance[i] ?? [], layout));
    return { pages, speakerSpans: buildSpeakerSpans(utterances) };
}
