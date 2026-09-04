/** One word with clip-local timing. All times in milliseconds. */
export interface WordTiming {
    text: string;
    startMs: number;
    endMs: number;
}

/** Speaker metadata as it arrives on GenerateHighlightRequest utterances. */
export interface CaptionSpeaker {
    name?: string;
    roleLabel?: string;
    partyLabel?: string;
    partyColorHex?: string;
}

/** An utterance projected into the clip-local (concatenated) timeline. */
export interface UtteranceForCaptions {
    utteranceId: string;
    startMs: number;
    endMs: number;
    text: string;
    speaker?: CaptionSpeaker;
}

export interface CaptionToken {
    text: string; // no leading/trailing whitespace
    fromMs: number;
    toMs: number;
}

export interface CaptionPage {
    startMs: number;
    endMs: number; // display end (>= last token toMs, <= next page start)
    tokens: CaptionToken[];
}

/** Continuous span of one speaker, for the overlay chip. */
export interface SpeakerSpan {
    startMs: number;
    endMs: number;
    speaker: CaptionSpeaker;
}

export interface CaptionTimeline {
    pages: CaptionPage[];
    speakerSpans: SpeakerSpan[];
}

export type EmphasisStyle = 'none' | 'highlight' | 'karaoke' | 'pop';

export interface CaptionPreset {
    id: string;
    name: string;
    font: {
        family: string;   // must match a bundled font's INTERNAL family name
        sizePct: number;  // font size as % of frame height
        uppercase: boolean;
    };
    colors: {
        text: string;   // hex e.g. "#FFFFFF" — base/inactive words
        active: string; // hex — spoken word
    };
    stroke?: { width: number; color: string }; // width in px at 1920-high frame
    shadow?: { depth: number; color: string }; // depth in px at 1920-high frame
    container?: {
        color: string;
        opacity: number;    // 0-1
        paddingPx: number;  // px at 1920-high frame (BorderStyle=4 Shadow field)
    };
    emphasis: {
        style: EmphasisStyle;
        scalePct?: number; // for 'pop', e.g. 106 (\fscx/\fscy target)
    };
    layout: {
        maxWordsPerPage: number;
        combineWithinMs: number;   // @remotion/captions grouping threshold
        minPageDurationMs: number; // readability floor
    };
    position: {
        yPct: number;        // vertical center of caption block, % of frame height
        maxWidthPct: number; // caption block max width, % of frame width
    };
    /**
     * Landscape (16:9) overrides. Portrait/9:16 values above are the base;
     * anything set here replaces it when the output frame is landscape.
     * Resolved by resolveForOrientation() — renderers never branch on aspect.
     */
    landscape?: {
        font?: Partial<CaptionPreset['font']>;
        colors?: Partial<CaptionPreset['colors']>;
        stroke?: CaptionPreset['stroke'];
        shadow?: CaptionPreset['shadow'];
        container?: CaptionPreset['container'];
        emphasis?: Partial<CaptionPreset['emphasis']>;
        layout?: Partial<CaptionPreset['layout']>;
        position?: Partial<CaptionPreset['position']>;
    };
}
