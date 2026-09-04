import { describe, it, expect } from 'vitest';
import { buildCaptionTimeline } from './timeline.js';
import type { UtteranceForCaptions, WordTiming, CaptionPreset } from './types.js';

const layout: CaptionPreset['layout'] = { maxWordsPerPage: 4, combineWithinMs: 1200, minPageDurationMs: 1000 };

const mkWords = (startMs: number, texts: string[], durMs = 300, gapMs = 100): WordTiming[] => {
    let t = startMs;
    return texts.map(text => {
        const w = { text, startMs: t, endMs: t + durMs };
        t += durMs + gapMs;
        return w;
    });
};

describe('buildCaptionTimeline', () => {
    it('caps tokens per page at maxWordsPerPage', () => {
        const u: UtteranceForCaptions = { utteranceId: 'u1', startMs: 0, endMs: 4000, text: 'α β γ δ ε ζ' };
        const words = mkWords(0, ['α', 'β', 'γ', 'δ', 'ε', 'ζ']);
        const { pages } = buildCaptionTimeline([u], [words], layout);
        expect(pages.length).toBeGreaterThanOrEqual(2);
        for (const p of pages) expect(p.tokens.length).toBeLessThanOrEqual(4);
    });

    it('breaks pages at sentence-final punctuation', () => {
        const u: UtteranceForCaptions = { utteranceId: 'u1', startMs: 0, endMs: 3000, text: 'ναι. όχι τώρα' };
        const words = mkWords(0, ['ναι.', 'όχι', 'τώρα']);
        const { pages } = buildCaptionTimeline([u], [words], layout);
        expect(pages[0].tokens.map(t => t.text)).toEqual(['ναι.']);
        expect(pages[1].tokens.map(t => t.text)).toEqual(['όχι', 'τώρα']);
    });

    it('breaks pages at the real Greek question mark U+037E', () => {
        const u: UtteranceForCaptions = { utteranceId: 'u1', startMs: 0, endMs: 3000, text: 'πότε; όχι τώρα' };
        const words = mkWords(0, ['πότε;', 'όχι', 'τώρα']);
        const { pages } = buildCaptionTimeline([u], [words], layout);
        expect(pages[0].tokens.map(t => t.text)).toEqual(['πότε;']);
        expect(pages[1].tokens.map(t => t.text)).toEqual(['όχι', 'τώρα']);
    });

    it('never spans utterances and trims token whitespace', () => {
        const u1: UtteranceForCaptions = { utteranceId: 'u1', startMs: 0, endMs: 900, text: 'ένα δύο' };
        const u2: UtteranceForCaptions = { utteranceId: 'u2', startMs: 900, endMs: 1800, text: 'τρία' };
        const { pages } = buildCaptionTimeline(
            [u1, u2],
            [mkWords(0, ['ένα', 'δύο']), mkWords(900, ['τρία'])],
            layout,
        );
        expect(pages).toHaveLength(2);
        expect(pages[0].tokens.map(t => t.text)).toEqual(['ένα', 'δύο']);
        expect(pages[1].tokens.map(t => t.text)).toEqual(['τρία']);
    });

    it('breaks pages at a pause boundary even under maxWordsPerPage', () => {
        const u: UtteranceForCaptions = { utteranceId: 'u1', startMs: 0, endMs: 5000, text: 'ένα δύο' };
        const words: WordTiming[] = [
            { text: 'ένα', startMs: 0, endMs: 300 },
            { text: 'δύο', startMs: 2300, endMs: 2600 }, // 2000ms gap > combineWithinMs (1200)
        ];
        const { pages } = buildCaptionTimeline([u], [words], layout);
        expect(pages).toHaveLength(2);
        expect(pages[0].tokens.map(t => t.text)).toEqual(['ένα']);
        expect(pages[1].tokens.map(t => t.text)).toEqual(['δύο']);
    });

    it('extends short pages to minPageDurationMs within available room', () => {
        const u: UtteranceForCaptions = { utteranceId: 'u1', startMs: 0, endMs: 5000, text: 'γεια' };
        const words: WordTiming[] = [{ text: 'γεια', startMs: 0, endMs: 300 }];
        const { pages } = buildCaptionTimeline([u], [words], layout);
        expect(pages[0].endMs).toBeGreaterThanOrEqual(1000);
        expect(pages[0].endMs).toBeLessThanOrEqual(5000);
    });

    it('merges consecutive same-speaker utterances into one speaker span', () => {
        const maria = { name: 'Μαρία', roleLabel: 'Δήμαρχος', partyColorHex: '#2e86de' };
        const nikos = { name: 'Νίκος' };
        const us: UtteranceForCaptions[] = [
            { utteranceId: 'u1', startMs: 0, endMs: 1000, text: 'α', speaker: maria },
            { utteranceId: 'u2', startMs: 1000, endMs: 2000, text: 'β', speaker: maria },
            { utteranceId: 'u3', startMs: 2000, endMs: 3000, text: 'γ', speaker: nikos },
        ];
        const ws = [mkWords(0, ['α']), mkWords(1000, ['β']), mkWords(2000, ['γ'])];
        const { speakerSpans } = buildCaptionTimeline(us, ws, layout);
        expect(speakerSpans).toEqual([
            { startMs: 0, endMs: 2000, speaker: maria },
            { startMs: 2000, endMs: 3000, speaker: nikos },
        ]);
    });
});
