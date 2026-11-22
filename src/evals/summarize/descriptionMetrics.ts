import { DiscussionStatus, type SummarizeRequest, type SummarizeResult } from '../../types.js';

/** Speech below this is a remark or a hand-over, which a description need not carry. */
export const SUBSTANTIAL_CHARS = 500;

export type SpeechTurn = { speaker: string; party: string | null; role: string | null; text: string };

/** The speech tagged to one subject, in meeting order; a speaker's consecutive utterances are one turn. */
export function subjectSpeech(request: Pick<SummarizeRequest, 'transcript'>, result: Pick<SummarizeResult, 'utteranceDiscussionStatuses'>, subjectId: string): SpeechTurn[] {
    const spoken = new Map<string, SpeechTurn>();
    for (const segment of request.transcript as Array<Record<string, any>>) {
        for (const u of segment.utterances ?? []) {
            spoken.set(u.utteranceId, { speaker: segment.speakerName ?? '?', party: segment.speakerParty ?? null, role: segment.speakerRole ?? null, text: u.text ?? '' });
        }
    }
    const turns: SpeechTurn[] = [];
    for (const s of result.utteranceDiscussionStatuses) {
        if (s.subjectId !== subjectId || s.status !== DiscussionStatus.SUBJECT_DISCUSSION) continue;
        const u = spoken.get(s.utteranceId);
        if (!u) continue;
        const last = turns[turns.length - 1];
        if (last && last.speaker === u.speaker) last.text += ` ${u.text}`;
        else turns.push({ ...u });
    }
    return turns;
}
