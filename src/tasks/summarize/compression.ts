import { SummarizeRequest, SummarizeResult, Subject } from "../../types.js";
import { IdCompressor, generateSubjectUUID } from "../../utils.js";

/**
 * Compress all IDs in the request using the provided IdCompressor.
 * This reduces token usage by shortening long UUIDs to compact representations.
 */
export const compressIds = (request: SummarizeRequest, idCompressor: IdCompressor) => {
    const shortenedIdTranscript = request.transcript.map(s => ({
        ...s,
        speakerSegmentId: idCompressor.addLongId(s.speakerSegmentId),
        speakerId: s.speakerId ? idCompressor.addLongId(s.speakerId) : null,
        utterances: s.utterances.map(u => ({
            ...u,
            utteranceId: idCompressor.addLongId(u.utteranceId),
        })),
    }));

    // Compress existing subject IDs
    const existingSubjects = request.existingSubjects.map(subj => {
        const uuid = generateSubjectUUID(subj);
        const compressedId = idCompressor.addLongId(uuid);
        return {
            id: compressedId,
            name: subj.name,
            description: subj.description,
            agendaItemIndex: subj.agendaItemIndex,
            introducedByPersonId: subj.introducedByPersonId ? idCompressor.addLongId(subj.introducedByPersonId) : null,
            locationText: subj.location?.text || null,
            topicLabel: subj.topicLabel,
            topicImportance: subj.topicImportance,
            proximityImportance: subj.proximityImportance,
            ...(subj.withdrawn ? { withdrawn: true } : {}),
            discussedIn: subj.discussedIn ? idCompressor.addLongId(subj.discussedIn) : null
        };
    });

    return {
        ...request,
        transcript: shortenedIdTranscript,
        existingSubjects
    };
};

/**
 * Decompress all IDs in the result back to their original long form.
 * Also decompresses references in markdown text (REF:TYPE:id).
 */
export const decompressIds = (
    result: { speakerSegmentSummaries: any[], subjects: Subject[], utteranceDiscussionStatuses: any[] },
    idCompressor: IdCompressor
): SummarizeResult => {
    // Unknown short IDs are LLM hallucinations (e.g. "j8oj87q4_2" for a real "j8oj87q4", or
    // literal words like "Zoom"). Swallow them — drop the entry or null the field — instead of
    // decompressing to undefined, which makes the whole result unusable on the opencouncil side.
    const isKnownId = (shortId: string, context: string): boolean => {
        if (idCompressor.hasShortId(shortId)) return true;
        console.warn(`⚠️  Dropping ${context} with unknown ID "${shortId}" — likely hallucinated by the LLM`);
        return false;
    };
    const decompressOrNull = (shortId: string | null | undefined, context: string): string | null => {
        if (!shortId) return null;
        if (!idCompressor.hasShortId(shortId)) {
            console.warn(`⚠️  Nulling ${context} with unknown ID "${shortId}" — likely hallucinated by the LLM`);
            return null;
        }
        return idCompressor.getLongId(shortId);
    };

    return {
        speakerSegmentSummaries: result.speakerSegmentSummaries
            .filter(s => isKnownId(s.id, 'speaker segment summary'))
            .map(s => ({
                speakerSegmentId: idCompressor.getLongId(s.id),
                summary: s.summary,
                topicLabels: s.labels,
                type: s.type
            })),
        subjects: result.subjects
            .filter(s => isKnownId(s.id, `subject "${s.name}"`))
            .map(s => ({
            ...s,
            id: idCompressor.getLongId(s.id),  // Decompress subject ID
            description: decompressReferencesInMarkdown(s.description, idCompressor),  // Decompress references in description
            introducedByPersonId: decompressOrNull(s.introducedByPersonId, `introducedByPersonId of subject "${s.name}"`),
            discussedIn: decompressOrNull(s.discussedIn, `discussedIn of subject "${s.name}"`),
            speakerContributions: s.speakerContributions
                .filter(c => {
                    if (!c.text) {
                        console.warn(`⚠️  Subject "${s.name}": Filtering out contribution with undefined text for speaker ${c.speakerId || c.speakerName}`);
                        return false;
                    }
                    return true;
                })
                .map(c => ({
                    speakerId: decompressOrNull(c.speakerId, `speakerId of contribution by "${c.speakerName}"`),
                    speakerName: c.speakerName,
                    text: decompressReferencesInMarkdown(c.text, idCompressor),
                    order: c.order
                }))
        })),
        utteranceDiscussionStatuses: result.utteranceDiscussionStatuses
            .filter(u => isKnownId(u.utteranceId, 'utterance status'))
            .map(u => {
            let decompressedSubjectId: string | null = null;

            if (u.subjectId) {
                try {
                    decompressedSubjectId = idCompressor.getLongIdOrThrow(u.subjectId);
                } catch (e) {
                    console.error(`⚠️  Failed to decompress subjectId for utterance ${u.utteranceId}`);
                    console.error(`   Compressed subject ID: ${u.subjectId}, Status: ${u.status}`);
                    console.error(`   Error: ${e instanceof Error ? e.message : String(e)}`);
                    console.error(`   This utterance will have null subjectId! This is a data corruption bug.`);
                    // Keep decompressedSubjectId as null
                }
            }

            return {
                utteranceId: idCompressor.getLongId(u.utteranceId),
                status: u.status,
                subjectId: decompressedSubjectId
            };
        })
    };
};

/**
 * Decompress references in markdown text from compressed IDs back to long IDs.
 * Pattern: [text](REF:TYPE:compressedId) -> [text](REF:TYPE:longId)
 */
export function decompressReferencesInMarkdown(markdown: string | null | undefined, idCompressor: IdCompressor): string {
    // Handle null/undefined markdown
    if (!markdown) {
        console.warn('decompressReferencesInMarkdown received null/undefined markdown');
        return '';
    }

    // Replace compressed IDs in REF: links with full IDs
    // Pattern: [text](REF:TYPE:compressedId)
    return markdown.replace(/\(REF:(UTTERANCE|PERSON|PARTY):([a-z0-9]+)\)/g, (match, type, compressedId) => {
        const longId = idCompressor.getLongId(compressedId);
        if (!longId) {
            console.warn(`Failed to decompress ID ${compressedId} of type ${type}`);
            return match; // Return original if decompression fails
        }
        return `(REF:${type}:${longId})`;
    });
}
