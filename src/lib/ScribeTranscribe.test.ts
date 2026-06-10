import { describe, it, expect, vi } from "vitest";
import { scribeWordsToUtterances, scribeResponseToTranscript, type ScribeWord, type ScribeResponse } from "./ScribeTranscribe.js";
import { applyDiarization } from "../tasks/applyDiarization.js";
import type { DiarizationSpeaker } from "../types.js";

// Builds a Scribe word stream from [text, start, end] tuples, with spacing entries between words
function scribeWords(words: [string, number, number][]): ScribeWord[] {
    return words.flatMap(([text, start, end], i): ScribeWord[] => {
        const word: ScribeWord = { text, type: "word", start, end, logprob: 0 };
        return i === 0 ? [word] : [{ text: " ", type: "spacing", start, end: start }, word];
    });
}

describe("scribeWordsToUtterances", () => {
    it("splits at sentence-final punctuation, including the Greek question mark", () => {
        const words = scribeWords([
            ["Καλημέρα", 0, 0.5],
            ["σας.", 0.6, 1.0],
            ["Υπάρχει", 1.1, 1.5],
            ["απαρτία;", 1.6, 2.0],
            ["Ναι", 2.1, 2.3],
        ]);

        const utterances = scribeWordsToUtterances(words, "el");

        expect(utterances.map(u => u.text)).toEqual(["Καλημέρα σας.", "Υπάρχει απαρτία;", "Ναι"]);
        expect(utterances[0]).toMatchObject({ start: 0, end: 1.0 });
        expect(utterances[1]).toMatchObject({ start: 1.1, end: 2.0 });
    });

    it("does not split at abbreviations or dotted acronyms", () => {
        const words = scribeWords([
            ["Ο", 0, 0.1],
            ["κ.", 0.2, 0.4],
            ["Δημάκης", 0.5, 1.0],
            ["της", 1.1, 1.3],
            ["Κ.Κ.Ε.", 1.4, 2.0],
            ["ψήφισε.", 2.1, 2.6],
        ]);

        const utterances = scribeWordsToUtterances(words, "el");

        expect(utterances.map(u => u.text)).toEqual(["Ο κ. Δημάκης της Κ.Κ.Ε. ψήφισε."]);
    });

    it("does not split at a trail-off ellipsis when the speaker continues", () => {
        const words = scribeWords([
            ["Θέλω", 0, 0.3],
            ["να", 0.4, 0.5],
            ["τονίσω…", 0.6, 1.2],
            ["ότι", 1.4, 1.6],
            ["διαφωνώ.", 1.7, 2.3],
        ]);

        const utterances = scribeWordsToUtterances(words, "el");

        expect(utterances.map(u => u.text)).toEqual(["Θέλω να τονίσω… ότι διαφωνώ."]);
    });

    it("splits at pauses longer than the threshold", () => {
        const words = scribeWords([
            ["πρώτο", 0, 0.5],
            ["κομμάτι", 0.6, 1.0],
            ["δεύτερο", 3.0, 3.5], // 2s pause before this word
            ["κομμάτι", 3.6, 4.0],
        ]);

        const utterances = scribeWordsToUtterances(words, "el");

        expect(utterances.map(u => u.text)).toEqual(["πρώτο κομμάτι", "δεύτερο κομμάτι"]);
    });

    it("splits long monologues at the max utterance duration", () => {
        // 50 words over 50 seconds with no punctuation or pauses
        const words = scribeWords(
            Array.from({ length: 50 }, (_, i): [string, number, number] => [`λέξη${i}`, i, i + 0.9])
        );

        const utterances = scribeWordsToUtterances(words, "el");

        expect(utterances.length).toBeGreaterThan(1);
        for (const utterance of utterances) {
            expect(utterance.end - utterance.start).toBeLessThanOrEqual(31);
        }
        // No words lost
        expect(utterances.flatMap(u => u.words)).toHaveLength(50);
    });

    it("skips audio events and preserves word timestamps and confidence", () => {
        const words: ScribeWord[] = [
            { text: "(γέλια)", type: "audio_event", start: 0, end: 0.4 },
            { text: "γεια", type: "word", start: 0.5, end: 0.9, logprob: -0.5 },
        ];

        const utterances = scribeWordsToUtterances(words, "el");

        expect(utterances).toHaveLength(1);
        expect(utterances[0].words).toEqual([
            { word: "γεια", start: 0.5, end: 0.9, confidence: Math.exp(-0.5) },
        ]);
        expect(utterances[0].confidence).toBeCloseTo(Math.exp(-0.5));
    });

    it("returns no utterances for an empty word stream", () => {
        expect(scribeWordsToUtterances([], "el")).toEqual([]);
    });
});

describe("scribeResponseToTranscript", () => {
    const response: ScribeResponse = {
        language_code: "ell",
        language_probability: 0.99,
        text: "Καλημέρα σας.",
        words: scribeWords([
            ["Καλημέρα", 0, 0.5],
            ["σας.", 0.6, 1.0],
        ]),
        audio_duration_secs: 1.2,
    };

    it("maps a Scribe response into the Transcript shape consumers expect", () => {
        const transcript = scribeResponseToTranscript(response, 35);

        expect(transcript.metadata).toEqual({
            audio_duration: 1.2,
            number_of_distinct_channels: 1,
            billing_time: 1.2,
            transcription_time: 35,
        });
        expect(transcript.transcription.languages).toEqual(["el"]);
        expect(transcript.transcription.full_transcript).toBe("Καλημέρα σας.");
        expect(transcript.transcription.utterances).toHaveLength(1);
    });

    it("falls back to the last utterance end when audio_duration_secs is missing", () => {
        const transcript = scribeResponseToTranscript({ ...response, audio_duration_secs: null }, 35);

        expect(transcript.metadata.audio_duration).toBe(1.0);
    });
});

describe("pyannote merge over Scribe word timestamps", () => {
    const speakers: DiarizationSpeaker[] = [
        { speaker: "SPEAKER_00", match: null, confidence: {} },
        { speaker: "SPEAKER_01", match: null, confidence: {} },
    ];

    it("assigns each utterance to the right pyannote speaker", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });

        // A roll-call style exchange: chair speaks 0–4s, member answers 4.5–7s
        const response: ScribeResponse = {
            language_code: "ell",
            language_probability: 0.99,
            text: "Ο κύριος Παπαδόπουλος; Παρών.",
            words: scribeWords([
                ["Ο", 0.2, 0.3],
                ["κύριος", 0.4, 0.9],
                ["Παπαδόπουλος;", 1.0, 1.9],
                ["Παρών.", 4.6, 5.2],
            ]),
            audio_duration_secs: 7,
        };
        const diarization = [
            { start: 0, end: 4, speaker: "SPEAKER_00" },
            { start: 4.5, end: 7, speaker: "SPEAKER_01" },
        ];

        const transcript = scribeResponseToTranscript(response, 35);
        const merged = await applyDiarization({ diarization, speakers, transcript }, () => { });

        expect(merged.transcription.utterances).toHaveLength(2);
        expect(merged.transcription.utterances[0]).toMatchObject({ text: "Ο κύριος Παπαδόπουλος;", speaker: 1 });
        expect(merged.transcription.utterances[1]).toMatchObject({ text: "Παρών.", speaker: 2 });

        vi.restoreAllMocks();
    });

    it("matches an utterance that slightly overhangs its diarization segment", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });

        // Last word ends 0.3s after the pyannote segment ends — small timestamp skew
        // between Scribe and pyannote should not prevent a match
        const response: ScribeResponse = {
            language_code: "ell",
            language_probability: 0.99,
            text: "Προχωράμε στο επόμενο θέμα. Ευχαριστώ.",
            words: scribeWords([
                ["Προχωράμε", 0.2, 0.8],
                ["στο", 0.9, 1.1],
                ["επόμενο", 1.2, 1.8],
                ["θέμα.", 1.9, 2.4],
                ["Ευχαριστώ.", 4.8, 5.3],
            ]),
            audio_duration_secs: 6,
        };
        const diarization = [
            { start: 0, end: 2.5, speaker: "SPEAKER_00" },
            { start: 4.7, end: 5.0, speaker: "SPEAKER_01" },
        ];

        const transcript = scribeResponseToTranscript(response, 35);
        const merged = await applyDiarization({ diarization, speakers, transcript }, () => { });

        expect(merged.transcription.utterances).toHaveLength(2);
        expect(merged.transcription.utterances[1]).toMatchObject({ text: "Ευχαριστώ.", speaker: 2 });

        vi.restoreAllMocks();
    });
});
