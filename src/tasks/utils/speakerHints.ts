import { FixTranscriptRequest, SpeakerHint } from "../../types.js";
import { identifySpeakers, SpeakerIdentification, SpeakerSegmentInput } from "../../lib/speakerIdentification.js";
import { NO_USAGE, ResultWithUsage } from "../../lib/ai.js";
import { isCancellation } from "../../lib/taskControl.js";

/**
 * Speaker hints for fixTranscript: who each diarization speaker is, judged
 * from the transcript text alone.
 *
 * The pass is deliberately blind to voiceprint matches. The model sees
 * speakers as S1, S2, ... and never the names the request carries, so the
 * caller can treat a hint and a voiceprint match as two independent opinions.
 */

type IdentificationInput = {
    segments: SpeakerSegmentInput[];
    /** The speaker tag behind each S<n> label. */
    tagIdByLabel: Map<string, string>;
};

/**
 * Relabels speaker tags S1, S2, ... in order of first speech. Segments without
 * a tag id or without text are left out.
 */
export function buildIdentificationInput(transcript: FixTranscriptRequest["transcript"]): IdentificationInput {
    const labelByTagId = new Map<string, string>();
    const segments: SpeakerSegmentInput[] = [];

    const timed = transcript
        .filter(segment => segment.speakerTagId && segment.utterances.length > 0)
        .map(segment => ({
            speakerTagId: segment.speakerTagId!,
            start: segment.utterances[0].startTimestamp,
            end: segment.utterances[segment.utterances.length - 1].endTimestamp,
            text: segment.utterances.map(u => u.text.trim()).filter(Boolean).join(" "),
        }))
        .sort((a, b) => a.start - b.start);

    for (const segment of timed) {
        if (!labelByTagId.has(segment.speakerTagId)) {
            labelByTagId.set(segment.speakerTagId, `S${labelByTagId.size + 1}`);
        }
        if (!segment.text) continue;
        segments.push({ speakerLabel: labelByTagId.get(segment.speakerTagId)!, start: segment.start, end: segment.end, text: segment.text });
    }

    return { segments, tagIdByLabel: new Map([...labelByTagId].map(([tagId, label]) => [label, tagId])) };
}

/**
 * Keeps the speakers the model named, addressed by speaker tag again. Names the
 * pass would not act on are kept too, marked as such: a reviewer can still use
 * them as suggestions.
 */
export function toSpeakerHints(identifications: SpeakerIdentification[], tagIdByLabel: Map<string, string>): SpeakerHint[] {
    return identifications.flatMap(({ speakerLabel, personId, actionable, evidenceKind, confidence, evidence }) => {
        const speakerTagId = tagIdByLabel.get(speakerLabel);
        return speakerTagId && personId ? [{ speakerTagId, personId, actionable, evidenceKind, confidence, evidence }] : [];
    });
}

/**
 * Runs the identification pass for a fixTranscript request.
 *
 * Returns undefined hints when the pass did not run — the request carries no
 * roster or no speaker tag ids, or the pass failed. That is different from an
 * empty list, which says the pass ran and named nobody. A failure never fails
 * the task: the transcript corrections are the task's main result.
 */
export async function identifyTranscriptSpeakers(request: FixTranscriptRequest): Promise<ResultWithUsage<SpeakerHint[] | undefined>> {
    if (!request.roster || request.roster.length === 0) return { result: undefined, usage: NO_USAGE };

    const { segments, tagIdByLabel } = buildIdentificationInput(request.transcript);
    if (segments.length === 0) return { result: undefined, usage: NO_USAGE };

    try {
        const identified = await identifySpeakers({
            cityName: request.cityName,
            language: request.cityLanguage,
            meetingDate: request.date,
            administrativeBodyName: request.administrativeBodyName,
            roster: request.roster,
            segments,
        });
        return { result: toSpeakerHints(identified.result, tagIdByLabel), usage: identified.usage };
    } catch (error) {
        if (isCancellation(error)) throw error;
        console.error("Speaker identification failed; returning no speaker hints:", error);
        return { result: undefined, usage: NO_USAGE };
    }
}
