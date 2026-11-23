import { DiscussionStatus, type SummarizeRequest, type SummarizeResult } from '../../types.js';

/** Speech below this is a remark or a hand-over, which a description need not carry. */
export const SUBSTANTIAL_CHARS = 500;

export type SpeechTurn<K extends string = string> = { speaker: string; party: string | null; role: string | null; text: string; group: K };

/** The utterances a result tags to one subject as its discussion. */
export function discussedUtterances(result: Pick<SummarizeResult, 'utteranceDiscussionStatuses'>, subjectId: string): Set<string> {
    return new Set(result.utteranceDiscussionStatuses
        .filter(s => s.subjectId === subjectId && s.status === DiscussionStatus.SUBJECT_DISCUSSION)
        .map(s => s.utteranceId));
}

/**
 * The transcript's utterances that `groupOf` puts in a group, as turns in meeting order: a
 * speaker's consecutive utterances of one group are one turn. One group gives a subject's
 * speech; a group per source tells which of two taggings holds each turn.
 */
export function speechTurns<K extends string>(request: Pick<SummarizeRequest, 'transcript'>, groupOf: (utteranceId: string) => K | null): SpeechTurn<K>[] {
    const turns: SpeechTurn<K>[] = [];
    for (const segment of request.transcript as Array<Record<string, any>>) {
        const speaker = segment.speakerName ?? '?';
        for (const u of segment.utterances ?? []) {
            const group = groupOf(u.utteranceId);
            if (group === null) continue;
            const last = turns[turns.length - 1];
            if (last && last.speaker === speaker && last.group === group) last.text += ` ${u.text ?? ''}`;
            else turns.push({ speaker, party: segment.speakerParty ?? null, role: segment.speakerRole ?? null, text: u.text ?? '', group });
        }
    }
    return turns;
}
