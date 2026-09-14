import type { Utterance, Word } from "../../types.js";
import { endsSentence, UTTERANCE_PAUSE_SECONDS, UTTERANCE_MAX_DURATION_SECONDS } from "../ScribeTranscribe.js";
import type { TimedWord } from "./types.js";

/**
 * Provider-neutral timed-words → utterances.
 *
 * `scribeWordsToUtterances` cannot be reused here: it reads Scribe's `spacing`
 * tokens to rebuild the text, and a fused stream has none — fusion tokens come
 * from three different tokenizers. Bending that function to cope with both
 * would put a provider conditional in the middle of the code that decides where
 * speakers change. So the *rule* is shared (same sentence test, same pause and
 * duration thresholds, imported not copied) and only the assembly differs.
 *
 * The split rules exist for a downstream reason: utterances must stay short
 * enough that "one speaker per utterance" holds when applyDiarization merges
 * pyannote's timeline over them.
 */

export interface FusedWord extends Word {
    fusionAgreement?: number;
    timingSource?: string;
    timingEstimated?: boolean;
}

export function timedWordsToUtterances(words: TimedWord[], language: string): Utterance[] {
    const utterances: Utterance[] = [];
    let current: FusedWord[] = [];
    let lastEnd = 0;

    const flush = () => {
        if (current.length === 0) return;
        utterances.push({
            text: current.map((word) => word.word).join(" ").trim(),
            language,
            start: current[0].start,
            end: current[current.length - 1].end,
            confidence: current.reduce((acc, w) => acc + w.confidence, 0) / current.length,
            minWordConfidence: current.reduce((acc, w) => Math.min(acc, w.confidence), 1),
            totalConfidence: current.reduce((acc, w) => acc * w.confidence, 1),
            channel: 0,
            speaker: 0, // placeholder — applyDiarization assigns real speakers
            drift: 0,
            words: current,
        });
        current = [];
    };

    for (const word of words) {
        if (current.length > 0 && word.start - lastEnd > UTTERANCE_PAUSE_SECONDS) {
            flush();
        }
        lastEnd = word.end;
        current.push({
            word: word.word,
            start: word.start,
            end: word.end,
            confidence: word.confidence,
            fusionAgreement: word.fusionAgreement,
            timingSource: word.timingSource,
            timingEstimated: word.timingEstimated,
        });

        if (endsSentence(word.word)) {
            flush();
        } else if (word.end - current[0].start >= UTTERANCE_MAX_DURATION_SECONDS) {
            flush();
        }
    }
    flush();

    return utterances;
}
