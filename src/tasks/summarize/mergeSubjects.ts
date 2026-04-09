/**
 * Post-batch subject merge step.
 * After batch processing creates subjects independently per batch, this step
 * reconciles near-duplicate or fragmented subjects with all subjects visible at once.
 */

import Anthropic from '@anthropic-ai/sdk';
import { aiChat, addUsage, NO_USAGE } from "../../lib/ai.js";
import { SubjectInProgress, UtteranceStatus } from "./types.js";

interface MergeOperation {
    keepId: string;
    removeIds: string[];
    newName: string;
    newDescription: string;
}

interface MergeAIResponse {
    merges: MergeOperation[];
}

/**
 * Merge duplicate/fragmented subjects that were created independently across batches.
 *
 * Rules:
 * - Only BEFORE_AGENDA subjects can be removed (merged away)
 * - IN_AGENDA and OUT_OF_AGENDA subjects can only absorb, never be removed
 * - The kept subject preserves its type, agendaItemIndex, introducedByPersonId
 * - Name and description are updated to reflect the combined topic
 */
export async function mergeSubjects(
    subjects: SubjectInProgress[],
    allUtteranceStatuses: UtteranceStatus[]
): Promise<{
    subjects: SubjectInProgress[];
    allUtteranceStatuses: UtteranceStatus[];
    usage: Anthropic.Messages.Usage;
    mergeCount: number;
}> {
    // Skip if fewer than 2 subjects — nothing to merge
    if (subjects.length < 2) {
        console.log('   ⏭️  Skipping merge: fewer than 2 subjects');
        return { subjects, allUtteranceStatuses, usage: NO_USAGE, mergeCount: 0 };
    }

    // Count BEFORE_AGENDA subjects — only these can be removed
    const beforeAgendaCount = subjects.filter(s => s.type === 'BEFORE_AGENDA').length;
    if (beforeAgendaCount === 0) {
        console.log('   ⏭️  Skipping merge: no BEFORE_AGENDA subjects to merge');
        return { subjects, allUtteranceStatuses, usage: NO_USAGE, mergeCount: 0 };
    }

    const systemPrompt = `You are an expert at analyzing meeting subject lists and identifying duplicates or fragments that should be merged.

You will receive a list of subjects extracted from a municipal council meeting transcript. These subjects were created independently across multiple transcript batches, so there may be:
- Near-duplicate subjects covering the same topic (e.g., 3 separate "parking" subjects)
- Overly broad subjects in early batches that later batches created specific breakouts for
- Subjects that are really one topic but got fragmented across batches

MERGE RULES (CRITICAL):
1. Only subjects with type "BEFORE_AGENDA" can be REMOVED (merged away into another subject).
2. "IN_AGENDA" and "OUT_OF_AGENDA" subjects are NEVER removed — they can only ABSORB BEFORE_AGENDA subjects.
3. When merging, the kept subject's type, agendaItemIndex, and introducedByPersonId are preserved automatically.
4. Update the kept subject's name and description to reflect the combined topic.
5. Only merge subjects that genuinely cover the same topic. Do NOT merge unrelated subjects.
6. If no merges are needed, return an empty merges array.

Return a JSON object with a "merges" array. Each merge has:
- keepId: the ID of the subject to keep
- removeIds: array of subject IDs to remove (MUST all be BEFORE_AGENDA type)
- newName: updated name for the kept subject
- newDescription: updated description reflecting the combined topic`;

    // Count utterances per subject for context
    const utteranceCounts = new Map<string, number>();
    for (const status of allUtteranceStatuses) {
        if (status.subjectId) {
            utteranceCounts.set(status.subjectId, (utteranceCounts.get(status.subjectId) || 0) + 1);
        }
    }

    const subjectList = subjects.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        type: s.type,
        agendaItemIndex: s.agendaItemIndex,
        discussedIn: s.discussedIn,
        utteranceCount: utteranceCounts.get(s.id) || 0
    }));

    const userPrompt = `Analyze these subjects and identify any that should be merged.
Each subject includes an utteranceCount showing how many utterances are tagged to it (helps identify fragments vs substantial topics).

${JSON.stringify(subjectList, null, 2)}

Remember: Only BEFORE_AGENDA subjects can appear in removeIds. If no merges are needed, return {"merges": []}.`;

    const { result, usage } = await aiChat<MergeAIResponse>({
        model: "claude-opus-4-6",
        systemPrompt,
        userPrompt,
        outputFormat: {
            type: "json_schema",
            schema: {
                type: "object",
                properties: {
                    merges: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                keepId: { type: "string" },
                                removeIds: { type: "array", items: { type: "string" } },
                                newName: { type: "string" },
                                newDescription: { type: "string" }
                            },
                            required: ["keepId", "removeIds", "newName", "newDescription"],
                            additionalProperties: false
                        }
                    }
                },
                required: ["merges"],
                additionalProperties: false
            }
        }
    });

    if (!result.merges || result.merges.length === 0) {
        console.log('   ✅ No merges needed');
        return { subjects, allUtteranceStatuses, usage, mergeCount: 0 };
    }

    // Apply merges with safety checks
    let mergedSubjects = [...subjects];
    let mergedStatuses = [...allUtteranceStatuses];
    let totalRemoved = 0;

    for (const merge of result.merges) {
        // Validate keepId exists
        const kept = mergedSubjects.find(s => s.id === merge.keepId);
        if (!kept) {
            console.warn(`   ⚠️  Skipping merge: keepId "${merge.keepId}" not found`);
            continue;
        }

        for (const removeId of merge.removeIds) {
            const removing = mergedSubjects.find(s => s.id === removeId);
            if (!removing) {
                console.warn(`   ⚠️  Skipping removal: subject "${removeId}" not found`);
                continue;
            }

            // SAFETY: Never remove IN_AGENDA or OUT_OF_AGENDA subjects
            if (removing.type !== 'BEFORE_AGENDA') {
                console.warn(`   ⚠️  Skipping merge: cannot remove ${removing.type} subject "${removing.name}" (${removeId})`);
                continue;
            }

            console.log(`   🔀 Merging "${removing.name}" (${removeId}) → "${kept.name}" (${merge.keepId})`);

            // Remap utterance statuses
            let remapped = 0;
            for (const status of mergedStatuses) {
                if (status.subjectId === removeId) {
                    status.subjectId = merge.keepId;
                    remapped++;
                }
            }
            if (remapped > 0) {
                console.log(`      → Remapped ${remapped} utterance statuses`);
            }

            // Remap discussedIn references
            for (const s of mergedSubjects) {
                if (s.discussedIn === removeId) {
                    s.discussedIn = merge.keepId;
                }
            }

            // Remove from subjects array
            mergedSubjects = mergedSubjects.filter(s => s.id !== removeId);
            totalRemoved++;
        }

        // Update kept subject's name and description
        const keptAfter = mergedSubjects.find(s => s.id === merge.keepId);
        if (keptAfter) {
            keptAfter.name = merge.newName;
            keptAfter.description = merge.newDescription;
        }
    }

    console.log(`   ✅ Merge complete: removed ${totalRemoved} subjects (${subjects.length} → ${mergedSubjects.length})`);

    return {
        subjects: mergedSubjects,
        allUtteranceStatuses: mergedStatuses,
        usage,
        mergeCount: totalRemoved
    };
}
