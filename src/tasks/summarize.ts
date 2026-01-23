import { aiChat, ResultWithUsage } from "../lib/ai.js";
import {
    SummarizeRequest,
    SummarizeResult,
    RequestOnTranscript,
    SubjectContext,
    Subject,
    SpeakerContribution,
    DiscussionStatus,
    DiscussionRange
} from "../types.js";
import { Task } from "./pipeline.js";
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { IdCompressor, formatTime } from "../utils.js";
import { getSubjectContextWithClaude } from "../lib/claudeSearch.js";
import { geocodeLocation } from "../lib/geocode.js";
import { createHash } from 'crypto';
dotenv.config();

type SpeakerSegment = Omit<SummarizeRequest['transcript'][number], 'utterances'>;
type CompressedTranscript = ReturnType<typeof compressIds>['transcript'];

const requestedSummaryWordCount = 50;

// Helper: Build chronological index map for utterances
function buildUtteranceIndexMap(transcript: CompressedTranscript): Map<string, number> {
    const utteranceIndex = new Map<string, number>();
    let chronologicalIndex = 0;
    for (const segment of transcript) {
        for (const utterance of segment.utterances) {
            utteranceIndex.set(utterance.utteranceId, chronologicalIndex++);
        }
    }
    return utteranceIndex;
}

// Helper: Get emoji for discussion status
function getStatusEmoji(status: DiscussionStatus): string {
    switch (status) {
        case DiscussionStatus.ATTENDANCE: return '📋';
        case DiscussionStatus.SUBJECT_DISCUSSION: return '💬';
        case DiscussionStatus.VOTE: return '🗳️';
        default: return '📝';
    }
}

// Reusable markdown reference format instructions for Greek prompts
const MARKDOWN_REFERENCE_FORMAT_INSTRUCTIONS = `
**ΜΟΡΦΗ ΚΕΙΜΕΝΟΥ - MARKDOWN ΜΕ REFERENCES**

Το κείμενο πρέπει να είναι σε Markdown που υποστηρίζει:

**Μορφοποίηση:**
- **Bold text** με **αστερίσκους**
- *Italic text* με *έναν αστερίσκο*
- <u>Underline text</u> με HTML tag
- Ordered lists: 1. 2. 3.
- Unordered lists: - item

**Reference Links (ΠΟΛΥ ΣΗΜΑΝΤΙΚΟ):**
Χρησιμοποίησε ειδικά markdown links με το πρωτόκολλο REF:

Τύποι references:
- [κείμενο που αναφέρεται](REF:UTTERANCE:utteranceId) - σύνδεσμος σε συγκεκριμένο utterance
- [όνομα συμβούλου](REF:PERSON:personId) - σύνδεσμος σε άτομο
- [όνομα παράταξης](REF:PARTY:partyId) - σύνδεσμος σε παράταξη

**Πότε να βάζεις REF:UTTERANCE:**
✓ Άμεσα αποσπάσματα ή παραφράσεις
✓ Συγκεκριμένα επιχειρήματα
✓ Αριθμητικά στοιχεία
✓ Αμφιλεγόμενες ή σημαντικές δηλώσεις
✓ Συγκεκριμένες προτάσεις δράσης

✗ ΜΗΝ βάζεις reference σε:
- Γενικές παρατηρήσεις χωρίς συγκεκριμένη πηγή
- Το γενικό πλαίσιο που παρέχεις εσύ

**Σύνταξη reference:**
Παράδειγμα: Υποστηρίζει ότι [η καθαριότητα έχει υποβαθμιστεί](REF:UTTERANCE:utt-001)
και προτείνει [πρόσληψη 15 εργαζομένων](REF:UTTERANCE:utt-002).

Το κείμενο μέσα στα [ ] πρέπει να είναι περιεκτικό και να δείχνει τι λέει το utterance/πηγή.

**Σημαντικό:**
- Το utteranceId στα REF:UTTERANCE: πρέπει να είναι ΑΚΡΙΒΩΣ το utteranceId από το input
- Μπορείς να χρησιμοποιήσεις REF:PERSON: και REF:PARTY: όταν αναφέρεσαι σε άτομα/παρατάξεις
`;


// Internal types for batch processing
interface SubjectInProgress {
    id: string;  // UUID
    type: 'IN_AGENDA' | 'BEFORE_AGENDA' | 'OUT_OF_AGENDA';
    agendaItemIndex: number | "BEFORE_AGENDA" | "OUT_OF_AGENDA";  // Matches Subject type
    name: string;  // LLM can update
    description: string;  // LLM can update
    topicImportance: 'doNotNotify' | 'normal' | 'high';
    proximityImportance: 'none' | 'near' | 'wide';
    introducedByPersonId: string | null;
    locationText: string | null;
    topicLabel: string | null;
    speakerContributions: SpeakerContribution[];  // Will be populated after batch processing
}

interface BatchProcessingResult {
    segmentSummaries: {
        id: string;  // compressed speakerSegmentId
        summary: string;
        labels: string[];
        type: "SUBSTANTIAL" | "PROCEDURAL";
    }[];
    ranges: {
        id: string;  // UUID for range
        start: string | null;  // compressed utteranceId
        end: string | null;    // null = range is "open" (continues beyond batch)
        status: DiscussionStatus;
        subjectId: string | null;  // compressed subject UUID
    }[];
    subjects: SubjectInProgress[];
    discussionSummary?: string;  // 3-4 sentence summary of where the discussion is now
}
// Generate stable deterministic ID for subject based on its properties
// Returns full SHA256 hash (not a UUID format, but deterministic and unique)
function generateSubjectUUID(subject: { name: string; description: string; agendaItemIndex: number | "BEFORE_AGENDA" | "OUT_OF_AGENDA" }): string {
    const hash = createHash('sha256');
    const agendaStr = subject.agendaItemIndex.toString();
    hash.update(subject.name + subject.description + agendaStr);
    return hash.digest('hex'); // Return full hash, not truncated
}

const compressIds = (request: SummarizeRequest, idCompressor: IdCompressor) => {
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
            proximityImportance: subj.proximityImportance
        };
    });

    return {
        ...request,
        transcript: shortenedIdTranscript,
        existingSubjects
    };
};

const decompressIds = (result: { speakerSegmentSummaries: any[], subjects: Subject[], utteranceDiscussionStatuses: any[] }, idCompressor: IdCompressor): SummarizeResult => {
    return {
        speakerSegmentSummaries: result.speakerSegmentSummaries.map(s => ({
            speakerSegmentId: idCompressor.getLongId(s.id),
            summary: s.summary,
            topicLabels: s.labels,
            type: s.type
        })),
        subjects: result.subjects.map(s => ({
            ...s,
            id: idCompressor.getLongId(s.id),  // Decompress subject ID
            description: decompressReferencesInMarkdown(s.description, idCompressor),  // Decompress references in description
            introducedByPersonId: s.introducedByPersonId ? idCompressor.getLongId(s.introducedByPersonId) : null,  // Decompress person ID
            speakerContributions: s.speakerContributions
                .filter(c => {
                    if (!c.text) {
                        console.warn(`⚠️  Subject "${s.name}": Filtering out contribution with undefined text for speaker ${c.speakerId}`);
                        return false;
                    }
                    return true;
                })
                .map(c => ({
                    speakerId: idCompressor.getLongId(c.speakerId),
                    text: decompressReferencesInMarkdown(c.text, idCompressor)
                }))
        })),
        utteranceDiscussionStatuses: result.utteranceDiscussionStatuses.map(u => ({
            utteranceId: idCompressor.getLongId(u.utteranceId),
            status: u.status,
            subjectId: u.subjectId ? idCompressor.getLongId(u.subjectId) : null
        }))
    };
};

function decompressReferencesInMarkdown(markdown: string | null | undefined, idCompressor: IdCompressor): string {
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

// Convert discussion ranges to per-utterance status mapping
// Note: If ranges overlap, first matching range (by chronological order) wins
function convertRangesToUtteranceStatuses(
    ranges: DiscussionRange[],
    transcript: CompressedTranscript
): Array<{ utteranceId: string; status: DiscussionStatus; subjectId: string | null }> {
    const utteranceStatuses: Array<{ utteranceId: string; status: DiscussionStatus; subjectId: string | null }> = [];

    // Build chronological index map for utterances
    const utteranceIndex = buildUtteranceIndexMap(transcript);

    const allUtterances: Array<{ utteranceId: string; segmentIndex: number; utteranceIndex: number }> = [];
    transcript.forEach((segment, segmentIndex) => {
        segment.utterances.forEach((utterance, utteranceIdx) => {
            allUtterances.push({
                utteranceId: utterance.utteranceId,
                segmentIndex,
                utteranceIndex: utteranceIdx
            });
        });
    });

    // Convert ranges to use indices and sort by start index
    const rangesWithIndices = ranges.map(range => ({
        range,
        startIndex: range.startUtteranceId
            ? utteranceIndex.get(range.startUtteranceId) ?? 0
            : 0,
        endIndex: range.endUtteranceId
            ? utteranceIndex.get(range.endUtteranceId) ?? Infinity
            : Infinity
    }));

    const sortedRanges = rangesWithIndices.sort((a, b) => a.startIndex - b.startIndex);

    // Assign status to each utterance
    for (const utterance of allUtterances) {
        // Find the range this utterance belongs to
        let assignedRange: DiscussionRange | null = null;
        const currentIndex = utteranceIndex.get(utterance.utteranceId);

        if (currentIndex !== undefined) {
            for (const { range, startIndex, endIndex } of sortedRanges) {
                // Use numerical comparison on indices instead of string comparison on IDs
                const inRange = currentIndex >= startIndex && currentIndex <= endIndex;

                if (inRange) {
                    assignedRange = range;
                    break; // First match wins (ranges should not overlap)
                }
            }
        }

        // Assign status (default to OTHER if no range found)
        utteranceStatuses.push({
            utteranceId: utterance.utteranceId,
            status: assignedRange?.status ?? DiscussionStatus.OTHER,
            subjectId: assignedRange?.subjectId ?? null
        });
    }

    return utteranceStatuses;
}

export const summarize: Task<SummarizeRequest, SummarizeResult> = async (request, onProgress) => {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🚀 SUMMARIZE TASK STARTED');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`📊 Request Details:`);
    console.log(`   • Transcript segments: ${request.transcript.length}`);
    console.log(`   • Total utterances: ${request.transcript.reduce((sum, seg) => sum + seg.utterances.length, 0)}`);
    console.log(`   • Requested subjects: ${request.requestedSubjects.length}`);
    console.log(`   • Existing subjects: ${request.existingSubjects.length}`);
    console.log(`   • City: ${request.cityName}`);
    console.log(`   • Date: ${request.date}`);
    console.log(`   • Topic labels: ${request.topicLabels.join(', ')}`);
    if (request.additionalInstructions) {
        console.log(`   • Additional instructions: ${request.additionalInstructions.substring(0, 100)}...`);
    }
    console.log('───────────────────────────────────────────────────────────');

    const idCompressor = new IdCompressor();
    const compressedRequest = compressIds(request, idCompressor);
    console.log(`🔧 ID compression: ${idCompressor.size()} IDs compressed`);

    // Phase 1: Unified batch processing (replaces two-pass system)
    console.log('');
    console.log('📝 PHASE 1: Batch Processing');
    onProgress("batch_processing", 0);
    const { speakerSegmentSummaries, subjects, allDiscussionRanges } =
        await processBatchesWithState(compressedRequest, idCompressor, onProgress);

    console.log(`✅ Batch processing complete:`);
    console.log(`   • Speaker segment summaries: ${speakerSegmentSummaries.length}`);
    console.log(`   • Subjects extracted: ${subjects.length}`);
    console.log(`   • Discussion ranges: ${allDiscussionRanges.length}`);

    // Phase 2: Generate speaker contributions from discussion ranges
    console.log('');
    console.log('💬 PHASE 2: Speaker Contributions');
    onProgress("speaker_contributions", 0);
    for (let i = 0; i < subjects.length; i++) {
        console.log(`   Processing subject ${i + 1}/${subjects.length}: "${subjects[i].name}"`);
        onProgress("speaker_contributions", i / subjects.length);
        subjects[i].speakerContributions = await generateSpeakerContributions(
            subjects[i],
            allDiscussionRanges,
            compressedRequest.transcript,
            idCompressor
        );
        console.log(`      → Generated ${subjects[i].speakerContributions.length} speaker contributions`);
    }

    console.log(`✅ Speaker contributions complete for ${subjects.length} subjects`);

    // Phase 3: Enrichment (geocode, context, final summary, importance)
    console.log('');
    console.log('🔍 PHASE 3: Enrichment (geocoding, context, summaries)');
    onProgress("enrichment", 0);
    const enrichedSubjects = await Promise.all(
        subjects.map((s, i) => {
            return enrichSubject(s, request.cityName, request.administrativeBodyName, request.date).then(result => {
                console.log(`   Enriched subject ${i + 1}/${subjects.length}: "${result.name}"`);
                onProgress("enrichment", (i + 1) / subjects.length);
                return result;
            });
        })
    );

    console.log(`✅ Enrichment complete for ${enrichedSubjects.length} subjects`);

    // Detailed subject logging
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📋 FINAL SUBJECTS DETAIL');
    console.log('═══════════════════════════════════════════════════════════');

    enrichedSubjects.forEach((subject, idx) => {
        console.log('');
        console.log(`${idx + 1}. "${subject.name}"`);
        console.log(`   ID: ${subject.id}`);
        console.log(`   Agenda: ${subject.agendaItemIndex}`);
        console.log(`   Importance: ${subject.topicImportance} / ${subject.proximityImportance}`);
        console.log(`   Topic: ${subject.topicLabel || 'none'}`);
        console.log(`   Location: ${subject.location?.text || 'none'}`);

        console.log(`\n   📝 Description (${subject.description.length} chars):`);
        console.log(`   ${subject.description}`);

        // Count utterances per party for this subject
        const subjectRanges = allDiscussionRanges.filter(
            r => r.subjectId === subject.id && r.status === DiscussionStatus.SUBJECT_DISCUSSION
        );
        const utterancesByParty: Record<string, number> = {};
        const utteranceIndex = buildUtteranceIndexMap(compressedRequest.transcript);

        for (const range of subjectRanges) {
            const startIndex = range.startUtteranceId ? utteranceIndex.get(range.startUtteranceId) ?? 0 : 0;
            const endIndex = range.endUtteranceId ? utteranceIndex.get(range.endUtteranceId) ?? Infinity : Infinity;

            for (const segment of compressedRequest.transcript) {
                for (const utterance of segment.utterances) {
                    const currentIndex = utteranceIndex.get(utterance.utteranceId);
                    const inRange = currentIndex !== undefined && currentIndex >= startIndex && currentIndex <= endIndex;

                    if (inRange) {
                        const party = segment.speakerParty || 'Χωρίς Παράταξη';
                        utterancesByParty[party] = (utterancesByParty[party] || 0) + 1;
                    }
                }
            }
        }

        if (Object.keys(utterancesByParty).length > 0) {
            console.log(`\n   🗳️  Utterances by Party:`);
            const sortedParties = Object.entries(utterancesByParty).sort((a, b) => b[1] - a[1]);
            sortedParties.forEach(([party, count]) => {
                console.log(`      • ${party}: ${count} utterances`);
            });
        }

        if (subject.speakerContributions.length > 0) {
            console.log(`\n   💬 Speaker Contributions (${subject.speakerContributions.length}):`);
            subject.speakerContributions.forEach((contrib, cIdx) => {
                console.log(`      ${cIdx + 1}. Speaker ${contrib.speakerId}:`);
                console.log(`         ${contrib.text}`);
            });
        } else {
            console.log(`\n   💬 No speaker contributions`);
        }

        console.log('   ───────────────────────────────────────────────────────────');
    });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');

    // Phase 4: Convert discussion ranges to per-utterance statuses
    console.log('');
    console.log('📋 PHASE 4: Converting ranges to utterance statuses');
    const utteranceDiscussionStatuses = convertRangesToUtteranceStatuses(
        allDiscussionRanges,
        compressedRequest.transcript
    );
    console.log(`✅ Generated statuses for ${utteranceDiscussionStatuses.length} utterances`);

    console.log('');
    console.log('🎯 FINAL RESULTS:');
    console.log(`   • Speaker segment summaries: ${speakerSegmentSummaries.length}`);
    console.log(`   • Subjects: ${enrichedSubjects.length}`);
    console.log(`   • Utterance discussion statuses: ${utteranceDiscussionStatuses.length}`);
    enrichedSubjects.forEach((s, i) => {
        console.log(`      ${i + 1}. "${s.name}" (${s.speakerContributions.length} contributions, importance: ${s.topicImportance}/${s.proximityImportance})`);
    });
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ SUMMARIZE TASK COMPLETED');
    console.log('═══════════════════════════════════════════════════════════');

    return decompressIds({
        speakerSegmentSummaries,
        subjects: enrichedSubjects,
        utteranceDiscussionStatuses
    }, idCompressor);
};

// Helper: Split transcript into batches
function splitTranscript(transcript: any[], maxLengthChars: number) {
    const parts: typeof transcript[] = [];
    let currentPart: typeof transcript = [];
    let currentPartLength = 0;

    for (const item of transcript) {
        const itemLength = JSON.stringify(item).length;
        if (currentPartLength + itemLength > maxLengthChars) {
            parts.push(currentPart);
            currentPart = [];
            currentPartLength = 0;
        }
        currentPart.push(item);
        currentPartLength += itemLength;
    }
    if (currentPart.length > 0) {
        parts.push(currentPart);
    }
    return parts;
}

// Initialize subjects from existing ones
function initializeSubjectsFromExisting(existingSubjects: any[]): SubjectInProgress[] {
    return existingSubjects.map(s => ({
        id: s.id, // Already compressed
        type: typeof s.agendaItemIndex === 'number' ? 'IN_AGENDA' as const :
            s.agendaItemIndex === 'BEFORE_AGENDA' ? 'BEFORE_AGENDA' as const : 'OUT_OF_AGENDA' as const,
        agendaItemIndex: s.agendaItemIndex, // Keep as-is (number | "BEFORE_AGENDA" | "OUT_OF_AGENDA")
        name: s.name,
        description: s.description,
        topicImportance: s.topicImportance || 'normal',
        proximityImportance: s.proximityImportance || 'none',
        introducedByPersonId: s.introducedByPersonId,
        locationText: s.locationText,
        topicLabel: s.topicLabel,
        speakerContributions: []
    }));
}

// Main unified batch processing function
async function processBatchesWithState(
    request: ReturnType<typeof compressIds>,
    idCompressor: IdCompressor,
    onProgress: (stage: string, progress: number) => void
): Promise<{
    speakerSegmentSummaries: BatchProcessingResult['segmentSummaries'];
    subjects: SubjectInProgress[];
    allDiscussionRanges: DiscussionRange[];
}> {
    const batches = splitTranscript(request.transcript, 130000);

    let conversationState = {
        subjects: initializeSubjectsFromExisting(request.existingSubjects),
        allDiscussionRanges: [] as DiscussionRange[],
        discussionSummary: undefined as string | undefined  // Narrative summary of where the discussion is
    };

    const allSummaries: BatchProcessingResult['segmentSummaries'] = [];

    console.log(`Processing ${batches.length} batches...`);

    for (let i = 0; i < batches.length; i++) {
        onProgress("batch_processing", i / batches.length);
        console.log('');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📦 BATCH ${i + 1}/${batches.length}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // Find the last range from previous batch - should be at most one open range
        const lastRange = conversationState.allDiscussionRanges[conversationState.allDiscussionRanges.length - 1];
        const openRange = lastRange?.endUtteranceId === null ? lastRange : null;

        if (openRange) {
            const statusEmoji = getStatusEmoji(openRange.status);
            const subject = openRange.subjectId ? conversationState.subjects.find(s => s.id === openRange.subjectId) : null;
            const subjectInfo = openRange.subjectId
                ? subject
                    ? ` - "${subject.name}" [subjectId: ${openRange.subjectId}]`
                    : ` - [⚠️ UNKNOWN: ${openRange.subjectId}]`
                : '';
            console.log(`🔄 Continuing open range: ${statusEmoji} ${openRange.status}${subjectInfo}`);
        } else {
            console.log(`🆕 Starting fresh (no open range from previous batch)`);
        }

        // Get the last few ranges for context (up to 5)
        const recentRanges = conversationState.allDiscussionRanges.slice(-5);
        if (recentRanges.length > 0) {
            console.log(`📜 Recent context (last ${recentRanges.length} ranges):`);
            recentRanges.forEach((r, idx) => {
                const statusEmoji = getStatusEmoji(r.status);
                const subject = r.subjectId ? conversationState.subjects.find(s => s.id === r.subjectId) : null;
                const subjectInfo = r.subjectId
                    ? subject
                        ? ` - "${subject.name}" [${r.subjectId}]`
                        : ` - [⚠️ UNKNOWN: ${r.subjectId}]`
                    : '';
                const isOpen = r.endUtteranceId === null ? ' [OPEN]' : '';
                console.log(`   ${idx + 1}. ${statusEmoji} ${r.status}${subjectInfo}${isOpen}`);
            });
        }

        const batchResult = await processSingleBatch(
            batches[i],
            i,
            batches.length,
            conversationState,
            openRange,
            recentRanges,
            {
                cityName: request.cityName,
                date: request.date,
                topicLabels: request.topicLabels,
                requestedSubjects: request.requestedSubjects,
                additionalInstructions: request.additionalInstructions
            },
            conversationState.discussionSummary  // Pass previous discussion summary
        );

        allSummaries.push(...batchResult.segmentSummaries);

        // Register any new subject IDs from the LLM in the IdCompressor
        // This is critical for subjects created dynamically during batch processing
        const idMapping = new Map<string, string>(); // old ID -> new ID
        for (const subject of batchResult.subjects) {
            // Check if this ID is already registered in the IdCompressor
            if (!idCompressor.hasShortId(subject.id)) {
                // ID doesn't exist - this is a NEW subject created by the LLM
                // Generate a UUID for it and register the mapping
                const uuid = generateSubjectUUID({
                    name: subject.name,
                    description: subject.description,
                    agendaItemIndex: subject.agendaItemIndex
                });

                // Register the mapping: uuid (long) -> compressed ID (short)
                const properShortId = idCompressor.addLongId(uuid);

                // Track the ID change so we can update ranges
                const oldId = subject.id;
                idMapping.set(oldId, properShortId);

                // Update the subject ID to use the proper compressed ID
                subject.id = properShortId;

                console.log(`   📝 Registered new subject ID: "${subject.name}" - ${oldId} -> ${properShortId}`);
            }
        }

        // Update ranges to use the corrected subject IDs
        for (const range of batchResult.ranges) {
            if (range.subjectId && idMapping.has(range.subjectId)) {
                const oldId = range.subjectId;
                const newId = idMapping.get(range.subjectId)!;
                range.subjectId = newId;
                console.log(`   🔄 Updated range subjectId: ${oldId} -> ${newId}`);
            }
        }

        // Add new ranges from this batch
        const newRanges = batchResult.ranges.map(r => ({
            id: r.id,
            startUtteranceId: r.start,
            endUtteranceId: r.end,
            status: r.status,
            subjectId: r.subjectId
        }));

        // VALIDATION: If continuing an open range, ensure consistency
        if (openRange && newRanges.length > 0 && newRanges[0].startUtteranceId === null) {
            const continuedRange = newRanges[0];

            if (continuedRange.id !== openRange.id) {
                console.warn(`   ⚠️  LLM returned wrong range ID for continuation!`);
                console.warn(`      Expected: ${openRange.id}`);
                console.warn(`      Got: ${continuedRange.id}`);
                console.warn(`      Auto-correcting to use expected range ID...`);
                continuedRange.id = openRange.id;
            }

            if (continuedRange.subjectId !== openRange.subjectId) {
                const oldSubject = batchResult.subjects.find(s => s.id === continuedRange.subjectId);
                const expectedSubject = conversationState.subjects.find(s => s.id === openRange.subjectId);
                console.warn(`   🚨 CRITICAL: LLM changed subject for continued range!`);
                console.warn(`      Expected: ${openRange.subjectId} - "${expectedSubject?.name}"`);
                console.warn(`      Got: ${continuedRange.subjectId} - "${oldSubject?.name}"`);
                console.warn(`      Auto-correcting to preserve original subject...`);
                continuedRange.subjectId = openRange.subjectId;
            }

            if (continuedRange.status !== openRange.status) {
                console.warn(`   ⚠️  LLM changed status for continued range!`);
                console.warn(`      Expected: ${openRange.status}`);
                console.warn(`      Got: ${continuedRange.status}`);
                console.warn(`      Auto-correcting to use expected status...`);
                continuedRange.status = openRange.status;
            }
        }

        console.log(`\n✅ Batch ${i + 1} processed:`);
        console.log(`   • Subjects in conversation state: ${batchResult.subjects.length}`);
        console.log(`   • Ranges created in this batch: ${newRanges.length}`);

        // Log all subjects returned by LLM
        console.log(`\n   📚 Subjects in this batch's response:`);
        batchResult.subjects.forEach((s, idx) => {
            console.log(`      ${idx + 1}. [${s.id}] "${s.name}"`);
        });

        // Log each new range with subject ID
        if (newRanges.length > 0) {
            console.log(`\n   📊 Ranges from this batch:`);
            newRanges.forEach((r, idx) => {
                const statusEmoji = getStatusEmoji(r.status);
                const subject = r.subjectId ? batchResult.subjects.find(s => s.id === r.subjectId) : null;
                const subjectInfo = r.subjectId
                    ? subject
                        ? ` - "${subject.name}" [subjectId: ${r.subjectId}]`
                        : ` - [⚠️ UNKNOWN SUBJECT ID: ${r.subjectId}]`
                    : '';
                const startInfo = r.startUtteranceId === null ? 'continues from prev' : `starts at ${r.startUtteranceId}`;
                const endInfo = r.endUtteranceId === null ? 'OPEN (continues to next)' : `ends at ${r.endUtteranceId}`;
                console.log(`      ${idx + 1}. ${statusEmoji} ${r.status}${subjectInfo}`);
                console.log(`         ${startInfo} → ${endInfo}`);
            });
        }

        // Validate that all subject IDs in ranges exist in subjects list
        const invalidRanges = newRanges.filter(r =>
            r.subjectId && !batchResult.subjects.find(s => s.id === r.subjectId)
        );
        if (invalidRanges.length > 0) {
            console.log(`\n   🚨 CRITICAL ERROR: ${invalidRanges.length} ranges reference unknown subject IDs!`);
            console.log(`   This means the LLM created ranges with subject IDs that don't exist in the subjects list.`);
            console.log(`   Invalid ranges:`);
            invalidRanges.forEach((r, idx) => {
                console.log(`      ${idx + 1}. Range ${r.id} references subjectId: ${r.subjectId}`);
            });
            console.log(`   Available subject IDs in this batch:`);
            batchResult.subjects.forEach((s, idx) => {
                console.log(`      ${idx + 1}. ${s.id} - "${s.name}"`);
            });
        }

        // Merge ranges: if a new range continues from previous (start=null), replace the old one
        const mergedRanges = [...conversationState.allDiscussionRanges];
        const continuedRanges: string[] = [];
        for (const newRange of newRanges) {
            if (newRange.startUtteranceId === null) {
                // This range continues from previous batch - find and replace the old range with same ID
                const oldRangeIndex = mergedRanges.findIndex(r => r.id === newRange.id);
                if (oldRangeIndex !== -1) {
                    // Replace the old open range with the updated one
                    mergedRanges[oldRangeIndex] = newRange;
                    continuedRanges.push(newRange.id);
                } else {
                    // Shouldn't happen, but add it anyway
                    console.log(`   ⚠️  WARNING: Range ${newRange.id} has start=null but no matching open range found!`);
                    mergedRanges.push(newRange);
                }
            } else {
                // New range, just append
                mergedRanges.push(newRange);
            }
        }

        if (continuedRanges.length > 0) {
            console.log(`\n   🔄 Replaced ${continuedRanges.length} continued range(s) from previous batch`);
        }

        conversationState = {
            subjects: batchResult.subjects,
            allDiscussionRanges: mergedRanges,
            discussionSummary: batchResult.discussionSummary  // Pass forward for next batch
        };

        // Validation: check that we have at most one open range
        const openRanges = conversationState.allDiscussionRanges.filter(r => r.endUtteranceId === null);
        const openRangesCount = openRanges.length;

        if (openRangesCount > 1) {
            console.log(`\n   ⚠️  WARNING: ${openRangesCount} open ranges detected! Should be at most 1.`);
            console.log(`   Open ranges:`);
            openRanges.forEach((r, idx) => {
                const statusEmoji = getStatusEmoji(r.status);
                const subjectName = r.subjectId
                    ? conversationState.subjects.find(s => s.id === r.subjectId)?.name || `[Unknown]`
                    : null;
                console.log(`      ${idx + 1}. ${statusEmoji} ${r.status}${subjectName ? ` - "${subjectName}"` : ''} [id: ${r.id}]`);
            });
        } else if (openRangesCount === 1) {
            const r = openRanges[0];
            const statusEmoji = getStatusEmoji(r.status);
            const subject = r.subjectId ? conversationState.subjects.find(s => s.id === r.subjectId) : null;
            const subjectInfo = r.subjectId
                ? subject
                    ? ` - "${subject.name}" [subjectId: ${r.subjectId}]`
                    : ` - [⚠️ UNKNOWN: ${r.subjectId}]`
                : '';
            console.log(`\n   🔓 1 open range (will continue to next batch): ${statusEmoji} ${r.status}${subjectInfo}`);
        } else {
            console.log(`\n   🔒 All ranges closed (no continuation to next batch)`);
        }
    }

    return {
        speakerSegmentSummaries: allSummaries,
        subjects: conversationState.subjects,
        allDiscussionRanges: conversationState.allDiscussionRanges
    };
}

// Process a single batch with AI
async function processSingleBatch(
    batch: any[],
    batchIndex: number,
    totalBatches: number,
    conversationState: { subjects: SubjectInProgress[] },
    openRange: DiscussionRange | null,
    recentRanges: DiscussionRange[],
    metadata: {
        cityName: string;
        date: string;
        topicLabels: string[];
        requestedSubjects?: string[];
        additionalInstructions?: string;
    },
    previousDiscussionSummary?: string
): Promise<BatchProcessingResult> {
    const systemPrompt = getBatchProcessingSystemPrompt(metadata);

    // Create context summary
    const progressSummary = batchIndex === 0
        ? "Αυτό είναι το ΠΡΩΤΟ batch της συνεδρίασης (αρχή συνεδρίασης)."
        : batchIndex === totalBatches - 1
        ? `Αυτό είναι το ΤΕΛΕΥΤΑΙΟ batch της συνεδρίασης (batch ${batchIndex + 1}/${totalBatches}).`
        : `Αυτό είναι το batch ${batchIndex + 1}/${totalBatches} της συνεδρίασης (μέση πορεία).`;

    const recentRangesSummary = recentRanges.length > 0
        ? `\n\nΠΡΟΣΦΑΤΑ RANGES (τελευταία ${recentRanges.length}):
${recentRanges.map((r, idx) => {
    const statusLabel = r.status === DiscussionStatus.ATTENDANCE ? "Παρουσίες" :
                       r.status === DiscussionStatus.SUBJECT_DISCUSSION ? "Συζήτηση θέματος" :
                       r.status === DiscussionStatus.VOTE ? "Ψηφοφορία" : "Άλλο";
    const subjectInfo = r.subjectId ? ` (θέμα: ${conversationState.subjects.find(s => s.id === r.subjectId)?.name || r.subjectId})` : '';
    return `${idx + 1}. ${statusLabel}${subjectInfo}`;
}).join('\n')}`
        : '';

    const discussionContextSummary = previousDiscussionSummary ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ΠΛΑΙΣΙΟ ΣΥΖΗΤΗΣΗΣ (από προηγούμενο batch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${previousDiscussionSummary}

` : '';

    const openRangeInstructions = openRange ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  ΚΡΙΣΙΜΟ: ΑΝΟΙΧΤΟ RANGE ΠΟΥ ΣΥΝΕΧΙΖΕΤΑΙ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Το προηγούμενο batch τελείωσε με ανοιχτό range που ΠΡΕΠΕΙ να συνεχίσεις:

Range ID: "${openRange.id}"
Status: ${openRange.status}
Subject ID: ${openRange.subjectId}
Subject: "${conversationState.subjects.find(s => s.id === openRange.subjectId)?.name || 'Unknown'}"

**ΥΠΟΧΡΕΩΤΙΚΕΣ ΟΔΗΓΙΕΣ:**
1. Το ΠΡΩΤΟ range στην απάντησή σου ΠΡΕΠΕΙ να είναι η συνέχεια αυτού του range
2. Χρησιμοποίησε το ΑΚΡΙΒΩΣ ΙΔΙΟ range id: "${openRange.id}"
3. Χρησιμοποίησε το ΑΚΡΙΒΩΣ ΙΔΙΟ subjectId: "${openRange.subjectId}"
4. Χρησιμοποίησε το ΑΚΡΙΒΩΣ ΙΔΙΟ status: "${openRange.status}"
5. Βάλε start = null (σημαίνει ότι ξεκινάει από προηγούμενο batch)
6. Βάλε end = το utteranceId όπου τελειώνει, ή null αν συνεχίζεται στο επόμενο batch

ΜΗΝ αλλάξεις το range ID, subject ID, ή status!

Παράδειγμα πρώτου range:
{
  "id": "${openRange.id}",
  "start": null,
  "end": "utt-xxx" ή null,
  "status": "${openRange.status}",
  "subjectId": "${openRange.subjectId}"
}

` : '';

    const userPrompt = `
${progressSummary}${recentRangesSummary}

${discussionContextSummary}${openRangeInstructions}
Το απόσπασμα της συνεδρίασης είναι το εξής:
${JSON.stringify(batch, null, 2)}

${metadata.requestedSubjects && metadata.requestedSubjects.length > 0 ?
            `Αν στο παραπάνω transcript αναφέρεται κάποιο από τα ακόλουθα θέματα, είναι σημαντικό να το συμπεριλάβεις: ${metadata.requestedSubjects.join(', ')}` : ''}

Η τρέχουσα λίστα subjects (χρησιμοποίησε το ίδιο ID και ΔΙΑΤΗΡΗΣΕ τα type/agendaItemIndex/introducedByPersonId):
${JSON.stringify(conversationState.subjects.map(s => ({
                id: s.id,
                name: s.name,
                description: s.description,
                type: s.type,
                agendaItemIndex: s.agendaItemIndex,
                introducedByPersonId: s.introducedByPersonId
            })), null, 2)}
`;

    const response = await aiChat<BatchProcessingResult>({
        systemPrompt,
        userPrompt,
        prefillSystemResponse: "Αναλύω το batch και παράγω τα αποτελέσματα σε JSON:\n{",
        prependToResponse: "{"
    });

    return response.result;
}

// System prompt for unified batch processing
function getBatchProcessingSystemPrompt(metadata: {
    cityName: string;
    date: string;
    topicLabels: string[];
    additionalInstructions?: string;
}): string {
    return `
Είσαι σύστημα που αναλύει απομαγνητοφωνημένες συνεδριάσεις δημοτικού συμβουλίου
της πόλης "${metadata.cityName}", ημερομηνία "${metadata.date}".

Η δουλειά σου είναι να:
1. Δημιουργήσεις σύντομες περιλήψεις για κάθε speaker segment (1-3 προτάσεις)
2. Ταξινομήσεις discussion ranges: ATTENDANCE, SUBJECT_DISCUSSION, VOTE, OTHER
3. Ανανεώσεις τη λίστα subjects που συζητούνται

═══════════════════════════════════════════════════════════════════════════
ΜΕΡΟΣ 1: SEGMENT SUMMARIES
═══════════════════════════════════════════════════════════════════════════

Για ΚΑΘΕ speaker segment, δημιούργησε μια σύντομη περίληψη (1-3 προτάσεις).

**Πότε type = "SUBSTANTIAL":**
- Ο ομιλητής εκφράζει γνώμη, επιχειρήματα, ή θέση επί θέματος
- Παρέχει πληροφορίες, αναφορές, ή ανάλυση
- Θέτει ερωτήματα ουσίας προς άλλους συμβούλους
- Παραδείγματα: "Η καθαριότητα στο δήμο έχει υποβαθμιστεί", "Προτείνω αύξηση κονδυλίων"

**Πότε type = "PROCEDURAL":**
- Διαδικαστικές παρεμβάσεις (δίνει/παίρνει λόγο, διακόπτει)
- Λήψη παρουσιών από γραμματέα
- Ανακοινώσεις πορείας συνεδρίασης
- Παραδείγματα: "Το λόγο έχει ο κ. Παπαδόπουλος", "Παρόντες 24 σύμβουλοι"

**Οδηγίες περίληψης:**
- ΜΗΝ ξεκινάς με το όνομα ("Ο Παπαδόπουλος λέει...")
- Γράψε σε γ' ενικό αν χρειάζεται ρήμα ("υποστηρίζει", "ανησυχεί")
- Γράψε με φυσική, ευανάγνωστη γλώσσα
- Εστίασε στα κύρια σημεία, όχι λεπτομέρειες

**Labels (topicLabels):**
Διάλεξε 0-3 labels από: ${metadata.topicLabels.join(", ")}
Βάλε label μόνο αν το segment πραγματικά αναφέρεται στο θέμα.

═══════════════════════════════════════════════════════════════════════════
ΜΕΡΟΣ 2: DISCUSSION RANGES
═══════════════════════════════════════════════════════════════════════════

Ταξινόμησε τα utterances σε συνεχόμενα ranges με κοινό status.

**ATTENDANCE:**
Λήψη παρουσιών, απαντήσεις συμβούλων "Παρών/Παρούσα"
Παράδειγμα: Γραμματέας καλεί ονόματα, σύμβουλοι απαντούν

**SUBJECT_DISCUSSION:**
Ολόκληρη η συζήτηση ενός θέματος από την ανακοίνωση μέχρι το τέλος. ΠΡΕΠΕΙ να έχει subjectId.

ΠΕΡΙΛΑΜΒΑΝΕΙ (ΟΛΑ):
✓ Ανακοίνωση θέματος ("Πρώτο θέμα, έγκριση προϋπολογισμού")
✓ Εισήγηση με επιχειρήματα και λεπτομέρειες
✓ Ερωτήσεις και απαντήσεις επί του θέματος
✓ Τοποθετήσεις συμβούλων
✓ Όλη η ουσιαστική συζήτηση

**ΚΡΙΣΙΜΟ - Τι ΔΕΝ είναι SUBJECT_DISCUSSION:**
✗ Άνοιγμα συνεδρίασης ("Είναι η 30η τακτική συνεδρίαση")
✗ Λήψη παρουσιών (ATTENDANCE)
✗ Χαιρετισμοί/ευχές εκτός θέματος
✗ Διαλείμματα, τεχνικά προβλήματα
✗ Διαδικαστικές παρεμβολές που δεν αφορούν κανένα θέμα

**VOTE:**
Ψηφοφορία ή καταμέτρηση ψήφων. ΠΡΕΠΕΙ να έχει subjectId.
Παράδειγμα: "Υπέρ 18, κατά 5, λευκά 1"

**OTHER:**
Διαδικαστικά που δεν αφορούν συγκεκριμένο θέμα
Παράδειγμα: "Κύριε Πρόεδρε, παρακαλώ τάξη", "Προχωράμε στο επόμενο θέμα"

**Κανόνες ranges:**
- Κάθε range πρέπει να έχει μοναδικό UUID (δημιούργησέ το εσύ για νέα ranges)
- start/end είναι utteranceId από το input
- Αν το range ξεκινάει ΠΡΙΝ το batch: start = null (ΜΟΝΟ αν υπάρχει "ΑΝΟΙΧΤΟ RANGE")
- Αν το range συνεχίζεται ΜΕΤΑ το batch: end = null
- **ΚΡΙΣΙΜΟ: Το πολύ ΕΝΑ range μπορεί να έχει end = null** (γιατί κάθε utterance έχει ένα μόνο status)
- **ΚΡΙΣΙΜΟ: Κάθε subjectId που χρησιμοποιείς στα ranges ΠΡΕΠΕΙ να υπάρχει στη λίστα subjects**
  * Αν βάλεις subjectId = "abc-123" σε κάποιο range, το subject με id "abc-123" ΠΡΕΠΕΙ να είναι στη λίστα subjects
  * Αλλιώς θα προκύψει σφάλμα - ΜΗΝ αναφέρεσαι σε subjects που δεν υπάρχουν
- **ΣΗΜΑΝΤΙΚΟ - Συνέχεια από προηγούμενο batch:**
  * Αν σου δίνεται "ΑΝΟΙΧΤΟ RANGE" από προηγούμενο batch και συνεχίζεται σε αυτό το batch:
  * Χρησιμοποίησε το ΙΔΙΟ range id (μην δημιουργήσεις νέο UUID)
  * Βάλε start = null (γιατί ξεκινάει πριν από αυτό το batch)
  * Βάλε end = το utteranceId όπου τελειώνει, ή null αν συνεχίζεται μετά το batch
  * Αν ΔΕΝ συνεχίζεται (π.χ. άλλαξε το status), κλείσε το στο προηγούμενο batch και ξεκίνα νέο range

═══════════════════════════════════════════════════════════════════════════
ΜΕΡΟΣ 3: SUBJECTS (ΘΕΜΑΤΑ)
═══════════════════════════════════════════════════════════════════════════

**ΠΡΟΤΕΡΑΙΟΤΗΤΑ #1: ΑΠΟΦΥΓΗ ΔΙΠΛΟΤΥΠΩΝ - ΠΟΛΥ ΣΗΜΑΝΤΙΚΟ!**

Πριν δημιουργήσεις νέο subject, ΕΛΕΓξε ΠΑΝΤΑ τη λίστα υπαρχόντων subjects.
Αν υπάρχει ήδη παρόμοιο θέμα, ΧΡΗΣΙΜΟΠΟΙΗΣΕ το ίδιο subject ID - ΜΗΝ δημιουργήσεις νέο!

**Πότε να ΣΥΓΧΩΝΕΥΣΕΙΣ (merge) σε ΥΠΑΡΧΟΝ subject:**
- Το θέμα είναι το ίδιο ή πολύ σχετικό με υπάρχον subject
- Παραδείγματα που πρέπει να συγχωνευθούν:
  * "Ρυθμιστικό πλαίσιο για πατίνια" + "Κανόνες χρήσης πατινιών" = ΕΝΑ subject
  * "Καθαριότητα στην πόλη" + "Πρόσληψη εργαζομένων καθαριότητας" = ΕΝΑ subject
  * "Λόφος Αρδηττού" + "Κτίριο στο λόφο Αρδηττού" = ΕΝΑ subject
- Όταν συγχωνεύεις:
  * Χρησιμοποίησε το ίδιο subject id
  * ΕΝΗΜΕΡΩΣΕ το name να είναι πιο περιεκτικό (π.χ. "Ρυθμιστικό πλαίσιο και χρήση πατινιών")
  * ΕΝΗΜΕΡΩΣΕ το description να περιλαμβάνει και τις δύο πτυχές
  * Προσθέσε references από τις νέες συζητήσεις

**Πότε να δημιουργήσεις ΝΕΟ subject:**
- Συζητείται ΤΕΛΕΙΩΣ ΔΙΑΦΟΡΕΤΙΚΟ θέμα που δεν σχετίζεται με κανένα υπάρχον
- Δημιούργησε νέο UUID για το id
- **ΠΡΟΣΟΧΗ:** Αν έχεις αμφιβολία, συγχώνευσε - μη δημιουργείς νέο subject!

**Πότε να χρησιμοποιήσεις ΥΠΑΡΧΟΝ subject (χωρίς αλλαγές):**
- Το θέμα υπάρχει ήδη στη λίστα με το ίδιο ακριβώς περιεχόμενο
- Χρησιμοποίησε το ίδιο id
- Κράτα το name και description όπως είναι

**ΣΗΜΑΝΤΙΚΟ - Διατήρηση υπαρχόντων subjects:**
Όταν ενημερώνεις υπάρχον subject (ίδιο id):
- ΔΙΑΤΗΡΗΣΕ το type, agendaItemIndex, και introducedByPersonId ΑΚΡΙΒΩΣ όπως είναι
- Ενημέρωσε μόνο το name και description αν χρειάζεται

**Πεδία subject:**

type:
- IN_AGENDA: Θέμα από ημερήσια διάταξη (έχει agendaItemIndex αριθμό)
- BEFORE_AGENDA: Πριν την επίσημη διάταξη - ανακοινώσεις, ενημερώσεις, προσφωνήσεις χωρίς ψηφοφορία
- OUT_OF_AGENDA: Εκτός διάταξης - θέματα που θα ψηφιστούν από το συμβούλιο αλλά δεν ήταν στην αρχική ημερήσια διάταξη

**ΚΛΕΙΔΙ: BEFORE_AGENDA vs OUT_OF_AGENDA**
- BEFORE_AGENDA: Ενημερωτικά, δεν υπάρχει ψηφοφορία
  * Ανακοινώσεις δημάρχου
  * Ενημερώσεις για εκδηλώσεις
  * Προσφωνήσεις/χαιρετισμοί
  * Διαδικαστικά θέματα
- OUT_OF_AGENDA: Θέματα προς ψήφιση που δεν ήταν στην αρχική διάταξη
  * Έχουν VOTE range
  * Απαιτούν απόφαση συμβουλίου
  * Εγκρίνονται/απορρίπτονται

name: Σύντομος τίτλος 2-8 λέξεων που καταλαβαίνει ο μέσος πολίτης
**ΚΡΙΣΙΜΟ:**
- ΜΗΝ χρησιμοποιείς άγνωστα/τεχνικά ακρωνύμια (π.χ. ΠΔΕ, ΚΥΑ, ΣΒΑΚ)
- Γνωστά ακρωνύμια είναι OK (ΚΑΠΗ, ΚΔΑΠ, ΟΤΑ, κλπ)
- ΜΗΝ χρησιμοποιείς τεχνικούς/νομικούς όρους χωρίς εξήγηση
- Χρησιμοποίησε απλή, καθημερινή γλώσσα
Παραδείγματα: "Αντιπλημμυρικά έργα", "Προϋπολογισμός 2024", "Άδεια οικοδομής Λ. Μεσογείων 45", "Σύμβαση πετρελαίου για ΚΑΠΗ"

description: 2-3 προτάσεις με φυσική ροή σε μορφή **Markdown με λίγα references**

**ΣΤΥΛ ΓΡΑΦΗΣ - "He said, they said":**
- Γράψε με φυσική, αφηγηματική ροή (narrative flow)
- **ΚΡΙΣΙΜΟ**: Απόδωσε τα στοιχεία σε συγκεκριμένους ομιλητές
  * "Ο αντιδήμαρχος ανέφερε συγκεκριμένους αριθμούς..."
  * "Οι σύμβουλοι εξέφρασαν ανησυχίες για..."
  * "Ο εισηγητής εξήγησε ότι..."
- ΜΗΝ γράφεις σαν λίστα ή bullet points
- ΜΗΝ χρησιμοποιείς ασαφείς φράσεις: "Καταγραφή:", "Στοιχεία:", "Αναφέρθηκαν:"
- ΜΗΝ βάζεις reference σε κάθε πρόταση - μόνο για ΚΥΡΙΑ στοιχεία
- Η αφήγηση πρέπει να διαβάζεται ομαλά, όχι σαν λίστα με links

**ΔΟΜΗ:**
1. **Πρώτη πρόταση**: Τι είναι το θέμα και το context (χωρίς reference)
2. **Δεύτερη πρόταση**: Τι συζητήθηκε/τέθηκε, με reference μόνο για κύριο claim
3. **Τρίτη πρόταση**: Αποτέλεσμα (εγκρίθηκε/απορρίφθηκε) (χωρίς reference)

**ΓΙΑ ΠΟΛΥΠΛΟΚΑ ΘΕΜΑΤΑ μόνο:**
Αν η συζήτηση ήταν εκτενής με πολλά διαφορετικά ζητήματα, πρόσθεσε:

**Κύρια ζητήματα:**
- Ζήτημα 1: σύντομη περιγραφή με [reference](REF:UTTERANCE:id) μόνο αν είναι αμφιλεγόμενο claim
- Ζήτημα 2: σύντομη περιγραφή
- (μέχρι 4 ζητήματα)

**REFERENCES - Πότε να βάζεις:**
✓ Συγκεκριμένα νούμερα: [το κόστος είναι 300 χιλιάδες ευρώ](REF:UTTERANCE:xxx)
✓ Αμφιλεγόμενες δηλώσεις: [τα πορίσματα είναι εμπιστευτικά](REF:UTTERANCE:xxx)
✓ Κρίσιμες αποφάσεις: [εγκρίθηκε ομόφωνα με 18 υπέρ](REF:UTTERANCE:xxx)

✗ ΜΗΝ βάζεις reference για:
- Γενικές περιγραφές ("το θέμα αφορά...", "συζητήθηκε...")
- Προφανή πράγματα ("ο πρόεδρος εισηγήθηκε", "υπήρξε συζήτηση")
- Φυσιολογική ροή αφήγησης

**Παραδείγματα:**

ΚΑΛΟ (απλό θέμα):
"Έγκριση παράτασης σύμβασης πετρελαίου για τα ΚΑΠΗ. Ο αρμόδιος εξήγησε ότι το ποσό αφορά τις ανάγκες θέρμανσης του χειμώνα και [η σύμβαση τροποποιείται για δεύτερη φορά λόγω απρόβλεπτων συνθηκών](REF:UTTERANCE:xxx). Το θέμα εγκρίθηκε ομόφωνα."

ΚΑΛΟ (θέμα με αριθμούς - ΜΕ απόδοση):
"Παραβίαση ωραρίου από καταστήματα που παραμένουν ανοιχτά σε αργίες. Ο αντιδήμαρχος ανέφερε συγκεκριμένους αριθμούς από καταγραφές (π.χ. [60 καταστήματα στις 28 Οκτωβρίου, 94 στις 26 Δεκεμβρίου](REF:UTTERANCE:xxx)), ενώ η Δημοτική Αστυνομία διενήργησε πάνω από 1.000 ελέγχους. Οι σύμβουλοι τόνισαν τον αθέμιτο ανταγωνισμό και την ανάγκη συνεργασίας με ΕΛΑΣ."

ΚΑΛΟ (πολύπλοκο θέμα με key issues):
"Τροποποίηση του Μηχανισμού Πιστοποίησης για το Κέντρο Κοινότητας Ρομά. Η συζήτηση επικεντρώθηκε σε διαφάνεια και λογοδοσία. Το θέμα εγκρίθηκε με λευκό ψήφο από τη Λαϊκή Συσπείρωση.

**Κύρια ζητήματα:**
- Ζητήθηκε ενημέρωση για την πορεία του έργου και τα αποτελέσματά του
- Ο Δήμαρχος απάντησε ότι [τα πορίσματα από τον έλεγχο ΟΠΕΚΑ είναι εμπιστευτικά](REF:UTTERANCE:xxx)
- Τέθηκε ζήτημα διαφάνειας στην πληροφόρηση της αντιπολίτευσης"

ΚΑΚΟ (λίστα χωρίς απόδοση - ασαφές ποιος λέει τι):
"Συστηματική παραβίαση ωραρίου από καταστήματα. Καταγραφή: 28η Οκτωβρίου 60 καταστήματα, Χριστούγεννα 46, 26 Δεκεμβρίου 94. Η Δημοτική Αστυνομία διενήργησε 1.135 ελέγχους από 1/8/2023 έως 21/8/2023, 270 σε Κυριακές/αργίες, με 57 μηνύσεις και 45 εκθέσεις. Τονίζεται ο αθέμιτος ανταγωνισμός."

ΚΑΚΟ (υπερβολικά πολλά references):
"[Έγκριση παράτασης](REF:UTTERANCE:aaa) [σύμβασης πετρελαίου](REF:UTTERANCE:bbb) για [τα ΚΑΠΗ](REF:UTTERANCE:ccc). [Το ποσό αφορά θέρμανση](REF:UTTERANCE:ddd) και [η τροποποίηση είναι δεύτερη](REF:UTTERANCE:eee). [Εγκρίθηκε ομόφωνα](REF:UTTERANCE:fff)."

**ΤΙ ΝΑ ΑΠΟΦΥΓΕΙΣ:**
- ΜΗΝ γράφεις σαν λίστα με αριθμούς χωρίς απόδοση ("Καταγραφή: 60 καταστήματα, 94 παραβάσεις...")
- ΜΗΝ χρησιμοποιείς ασαφείς εισαγωγές: "Καταγραφή:", "Στοιχεία:", "Αναφέρθηκαν:"
- ΜΗΝ αναφέρεις μετα-πληροφορίες για τη συνεδρίαση ("το Συμβούλιο είναι διαδικαστικού χαρακτήρα", "ελάχιστα θέματα")
- ΜΗΝ αναφέρεις διαδικαστικά άλλων θεμάτων ("η 8η αναμόρφωση εγκρίθηκε πριν")
- ΜΗΝ βάζεις reference σε κάθε πρόταση - κράτα τη φυσική ροή
- Εστίασε ΜΟΝΟ στο συγκεκριμένο θέμα και τη συζήτηση του
- **ΠΑΝΤΑ απόδωσε τα στοιχεία/αριθμούς σε ομιλητή** (π.χ. "Ο αντιδήμαρχος ανέφερε...", "Η αρμόδια παρουσίασε...")

${MARKDOWN_REFERENCE_FORMAT_INSTRUCTIONS}

locationText: Συμπλήρωσε ΜΟΝΟν αν υπάρχει ΣΥΓΚΕΚΡΙΜΕΝΗ τοποθεσία
- Διεύθυνση: "Λεωφόρος Μεσογείων 45"
- Γειτονιά: "Εξάρχεια"
- Δρόμος: "Οδός Πανεπιστημίου"
- Χώρος: "Πλατεία Συντάγματος"
- null αν αφορά όλο το δήμο (π.χ. προϋπολογισμός)

introducedByPersonId: Ο εισηγητής που παρουσιάζει το θέμα

**ΠΩΣ ΝΑ ΒΡΕΙΣ ΤΟΝ ΕΙΣΗΓΗΤΗ:**
- Κοίταξε ποιος ΠΡΩΤΟΣ παρουσιάζει/εισάγει το θέμα στα SUBJECT_DISCUSSION ranges
- Συνήθως είναι ο πρόεδρος ή ο αρμόδιος αντιδήμαρχος
- Χρησιμοποίησε το **speakerId** (compressed ID) από τα transcript segments
- **ΣΗΜΑΝΤΙΚΟ**: Αν ενημερώνεις υπάρχον subject (ίδιο id), ΔΙΑΤΗΡΗΣΕ το introducedByPersonId όπως είναι
- Αν δεν είναι σαφές ποιος εισηγείται: null

topicLabel: Ένα από: ${metadata.topicLabels.join(", ")}, ή null

**topicImportance - ΠΡΟΣΟΧΗ: Μη χρησιμοποιείς "high" εύκολα!**

"doNotNotify" - ΔΕΝ στέλνεται ειδοποίηση:
✓ Έγκριση πρακτικών προηγούμενης συνεδρίασης
✓ Διορισμοί επιτροπών
✓ Τυπικές διαδικαστικές εγκρίσεις
✓ Ανακοινώσεις χωρίς απόφαση

"normal" - Κανονική ειδοποίηση (ΠΡΟΕΠΙΛΟΓΗ):
✓ Άδειες οικοδομής
✓ Συντήρηση πάρκων
✓ Τοπικές υποδομές
✓ Προμήθειες εξοπλισμού
✓ Χρηματοδότηση τμημάτων
✓ Τα περισσότερα συνηθισμένα θέματα

"high" - Υψηλή σημασία (ΣΠΑΝΙΟ - μόνο 1-2 ανά συνεδρίαση):
✓ Δημοτικός προϋπολογισμός
✓ Φορολογία (αύξηση/μείωση)
✓ Μεγάλες υποδομές (μετρό, αυτοκινητόδρομοι)
✓ Κρίσιμες υπηρεσίες (σχολεία, νοσοκομεία, ασφάλεια)
✓ City-wide ordinances που επηρεάζουν όλους

Κριτήρια για "high":
1. Επηρεάζει ΟΛΟΥΣ τους δημότες ΚΑΙ
2. Η συζήτηση ήταν πολύ ουσιαστική (όχι απλή έγκριση) ΚΑΙ
3. Έχει σημαντικό αντίκτυπο (οικονομικό, κοινωνικό, ασφάλεια)

**proximityImportance - Γεωγραφική ακτίνα:**

"none" - Δεν έχει τοποθεσία:
✓ Προϋπολογισμός
✓ City-wide πολιτικές
✓ Διοικητικά θέματα
✓ Οτιδήποτε χωρίς locationText

"near" - 250m ακτίνα (ΠΡΟΕΠΙΛΟΓΗ αν υπάρχει τοποθεσία):
✓ Μεμονωμένη άδεια οικοδομής
✓ Μία επιχείρηση
✓ Επισκευή συγκεκριμένου δρόμου
✓ Τοπικό πάρκο

"wide" - 1000m ακτίνα:
✓ Πολυώροφο κτίριο (>6 ορόφους)
✓ Αυτοκινητόδρομος/μεγάλος δρόμος
✓ Χώρος εκδηλώσεων με όχληση (γήπεδο, συναυλιακός χώρος)
✓ Εργοστάσιο/βιομηχανική εγκατάσταση
✓ Δίκτυο (π.χ. "ποδηλατόδρομοι σε 5 συνοικίες")

═══════════════════════════════════════════════════════════════════════════
ΠΑΡΑΔΕΙΓΜΑ ΑΠΟΚΡΙΣΗΣ
═══════════════════════════════════════════════════════════════════════════

{
  "segmentSummaries": [
    {
      "id": "seg-001",
      "summary": "Η καθαριότητα στο δήμο έχει υποβαθμιστεί. Προτείνει αύξηση προσωπικού και νέα οχήματα.",
      "labels": ["Καθαριότητα"],
      "type": "SUBSTANTIAL"
    },
    {
      "id": "seg-002",
      "summary": "Ο Πρόεδρος δίνει το λόγο στον επόμενο ομιλητή.",
      "labels": [],
      "type": "PROCEDURAL"
    }
  ],
  "ranges": [
    {
      "id": "rng-uuid-001",
      "start": null,
      "end": "utt-012",
      "status": "SUBJECT_DISCUSSION",
      "subjectId": "subj-uuid-001"
    },
    {
      "id": "rng-uuid-002",
      "start": "utt-013",
      "end": "utt-015",
      "status": "OTHER",
      "subjectId": null
    },
    {
      "id": "rng-uuid-003",
      "start": "utt-016",
      "end": null,
      "status": "SUBJECT_DISCUSSION",
      "subjectId": "subj-uuid-002"
    }
  ],
  // ΣΗΜΕΙΩΣΕΙΣ:
  // - Μόνο το τελευταίο range έχει end = null (συνεχίζεται στο επόμενο batch)
  // - Αν το ίδιο θέμα συζητείται σε πολλαπλά ranges (π.χ. με διακοπές), χρησιμοποίησε το ίδιο subjectId
  // - ΟΛΕΣ οι subjectId στα ranges πρέπει να υπάρχουν στη λίστα subjects

  // ΠΑΡΑΔΕΙΓΜΑ ΣΩΣΤΗΣ ΤΑΞΙΝΟΜΗΣΗΣ:
  // Utterances:
  // utt-001: "Ανοίγω τη συνεδρίαση" → OTHER (άνοιγμα)
  // utt-002: "Παρουσίες: Παπαδόπουλος;" → ATTENDANCE
  // utt-003: "Παρών" → ATTENDANCE
  // utt-004: "Πρώτο θέμα, έγκριση προϋπολογισμού" → SUBJECT_DISCUSSION (ξεκινάει ΕΔΩ με το θέμα)
  // utt-005: "Το λόγο έχει ο κύριος Δήμαρχος" → SUBJECT_DISCUSSION (συνεχίζεται)
  // utt-006: "Ο προϋπολογισμός είναι 5 εκατ. ευρώ..." → SUBJECT_DISCUSSION
  // utt-007: "Έχω ερώτηση για τα έσοδα..." → SUBJECT_DISCUSSION
  // utt-008: "Προχωράμε στην ψηφοφορία" → VOTE

  // Σωστά ranges:
  // {"id": "r1", "start": "utt-001", "end": "utt-001", "status": "OTHER", "subjectId": null}
  // {"id": "r2", "start": "utt-002", "end": "utt-003", "status": "ATTENDANCE", "subjectId": null}
  // {"id": "r3", "start": "utt-004", "end": "utt-007", "status": "SUBJECT_DISCUSSION", "subjectId": "subj-1"}
  // {"id": "r4", "start": "utt-008", "end": "utt-008", "status": "VOTE", "subjectId": "subj-1"}
  "subjects": [
    {
      "id": "subj-uuid-001",
      "type": "IN_AGENDA",
      "agendaItemIndex": 5,
      "name": "Αύξηση προσωπικού καθαριότητας",
      "description": "Πρόταση για πρόσληψη 15 εργαζομένων καθαριότητας και αγορά 3 νέων οχημάτων. Ο εισηγητής εξήγησε ότι [το κόστος θα είναι 300 χιλιάδες ευρώ ετησίως](REF:UTTERANCE:utt-007). Η αντιπολίτευση υποστήριξε την πρόταση αλλά ζήτησε διαφάνεια στις προσλήψεις. Το θέμα **εγκρίθηκε** με 18 υπέρ, 5 κατά.",
      "locationText": null,
      "introducedByPersonId": "person-123",
      "topicLabel": "Καθαριότητα",
      "topicImportance": "normal",
      "proximityImportance": "none"
    },
    {
      "id": "subj-uuid-002",
      "type": "IN_AGENDA",
      "agendaItemIndex": 8,
      "name": "Άδεια οικοδομής πολυώροφου Λ. Μεσογείων 145",
      "description": "Αίτηση για άδεια κατασκευής [12ώροφου κτιρίου](REF:UTTERANCE:utt-020) με καταστήματα και γραφεία. Οι σύμβουλοι εξέφρασαν ανησυχίες για τον κυκλοφοριακό φόρτο και την έλλειψη χώρων στάθμευσης. Το θέμα *αναβλήθηκε* για πρόσθετη μελέτη.",
      "locationText": "Λεωφόρος Μεσογείων 145",
      "introducedByPersonId": null,
      "topicLabel": "Πολεοδομία",
      "topicImportance": "normal",
      "proximityImportance": "wide"
    }
  ],
  "discussionSummary": "Η συνεδρίαση ξεκίνησε με την επιβεβαίωση της απαρτίας. Προχωράει η συζήτηση για την αύξηση προσωπικού καθαριότητας, με θετικές αντιδράσεις αλλά και ανησυχίες για τη διαφάνεια στις προσλήψεις. Το συμβούλιο πρόκειται να ψηφίσει για το θέμα."
}

// ΣΗΜΕΙΩΣΗ: Το πεδίο "discussionSummary" είναι 3-4 προτάσεις που περιγράφουν ΠΟΥ βρίσκεται η συζήτηση ΤΩΡΑ:
// - Ποιο θέμα συζητείται αυτή τη στιγμή
// - Ποιες είναι οι κύριες απόψεις/ανησυχίες που εκφράστηκαν
// - Τι πρόκειται να συμβεί στη συνέχεια
// ΜΗΝ αναφέρεις συγκεκριμένα utterances ή ονόματα - μόνο το γενικό πλαίσιο της συζήτησης.

═══════════════════════════════════════════════════════════════════════════
ΤΕΛΙΚΟΣ ΕΛΕΓΧΟΣ ΠΡΙΝ ΤΗΝ ΑΠΟΚΡΙΣΗ
═══════════════════════════════════════════════════════════════════════════

Πριν απαντήσεις, έλεγξε:

- Κάθε subjectId στα ranges υπάρχει στη λίστα subjects
- Το πολύ 1 range έχει end = null
- Δεν υπάρχουν διπλότυπα subjects (παρόμοια θέματα με διαφορετικά IDs)
- Αν υπάρχει "ΑΝΟΙΧΤΟ RANGE", το πρώτο range συνεχίζει με το ίδιο range id και start = null
- Αν ΔΕΝ υπάρχει "ΑΝΟΙΧΤΟ RANGE", το πρώτο range ΔΕΝ έχει start = null
- **ΚΡΙΣΙΜΟ:** Ranges δεν επικαλύπτονται - κάθε utterance ανήκει σε ΕΝΑ μόνο range
- **ΚΡΙΣΙΜΟ:** SUBJECT_DISCUSSION ξεκινάει από την ανακοίνωση του θέματος, ΟΧΙ από παρουσίες/άνοιγμα συνεδρίασης

${metadata.additionalInstructions || ""}

ΣΗΜΑΝΤΙΚΟ: Απάντησε ΜΟΝΟ με JSON, χωρίς επεξηγήσεις ή σχόλια.
`;
}

// Generate speaker contributions from discussion ranges
async function generateSpeakerContributions(
    subject: SubjectInProgress,
    allRanges: DiscussionRange[],
    transcript: CompressedTranscript,
    idCompressor: IdCompressor
): Promise<SpeakerContribution[]> {
    // Find ranges for this subject
    const relevantRanges = allRanges.filter(r =>
        r.subjectId === subject.id &&
        r.status === DiscussionStatus.SUBJECT_DISCUSSION
    );

    if (relevantRanges.length === 0) {
        console.log(`   ⚠️  Subject "${subject.name}": No SUBJECT_DISCUSSION ranges found`);
        return [];
    }

    console.log(`   🔍 Subject "${subject.name}" has ${relevantRanges.length} relevant ranges`);

    // Extract utterances with full context
    const { bySpeaker: utterancesBySpeaker, allUtterances } = extractAndGroupUtterances(relevantRanges, transcript);

    const speakerCount = Object.keys(utterancesBySpeaker).length;
    console.log(`   🔍 Extracted ${allUtterances.length} total utterances from ${speakerCount} speakers`);

    if (allUtterances.length === 0) {
        console.log(`   ⚠️  Subject "${subject.name}": No utterances found in ranges!`);
        return [];
    }

    if (speakerCount === 0) {
        console.log(`   ⚠️  Subject "${subject.name}": No speakers with utterances!`);
        return [];
    }

    // NEW: Single API call for all speakers
    return await generateAllSpeakerContributionsInOneCall(
        utterancesBySpeaker,
        allUtterances,
        subject,
        idCompressor
    );
}

interface ExtractedUtterances {
    bySpeaker: Record<string, Array<{ utteranceId: string; text: string }>>;
    allUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }>;
}

function extractAndGroupUtterances(
    ranges: DiscussionRange[],
    transcript: CompressedTranscript
): ExtractedUtterances {
    const utterancesBySpeaker: Record<string, Array<{ utteranceId: string; text: string }>> = {};
    const allUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }> = [];

    // Build chronological index map for utterances
    const utteranceIndex = buildUtteranceIndexMap(transcript);

    for (const range of ranges) {
        // Get range boundary indices
        const startIndex = range.startUtteranceId
            ? utteranceIndex.get(range.startUtteranceId) ?? 0
            : 0;
        const endIndex = range.endUtteranceId
            ? utteranceIndex.get(range.endUtteranceId) ?? Infinity
            : Infinity;

        for (const segment of transcript) {
            for (const utterance of segment.utterances) {
                // Check if utterance is in range using INDICES
                const currentIndex = utteranceIndex.get(utterance.utteranceId);
                const inRange = currentIndex !== undefined &&
                                currentIndex >= startIndex &&
                                currentIndex <= endIndex;

                if (inRange) {
                    // Add to all utterances (for full context)
                    allUtterances.push({
                        utteranceId: utterance.utteranceId,
                        text: utterance.text,
                        speakerId: segment.speakerId,
                        speakerName: segment.speakerName,
                        timestamp: utterance.startTimestamp
                    });

                    // Add to speaker-specific group (if speaker exists)
                    if (segment.speakerId) {
                        if (!utterancesBySpeaker[segment.speakerId]) {
                            utterancesBySpeaker[segment.speakerId] = [];
                        }
                        utterancesBySpeaker[segment.speakerId].push({
                            utteranceId: utterance.utteranceId,
                            text: utterance.text
                        });
                    }
                }
            }
        }
    }

    // Sort all utterances by timestamp to maintain chronological order
    allUtterances.sort((a, b) => a.timestamp - b.timestamp);

    return {
        bySpeaker: utterancesBySpeaker,
        allUtterances
    };
}

async function generateAllSpeakerContributionsInOneCall(
    utterancesBySpeaker: Record<string, Array<{ utteranceId: string; text: string }>>,
    allSubjectUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }>,
    subject: SubjectInProgress,
    idCompressor: IdCompressor
): Promise<SpeakerContribution[]> {
    const systemPrompt = `
Δημιουργείς περιεκτικές περιλήψεις τοποθετήσεων συμβούλων σε δημοτικά συμβούλια.

═══════════════════════════════════════════════════════════════════════════
ΣΤΟΧΟΣ
═══════════════════════════════════════════════════════════════════════════

Για ΟΛΟΥΣ τους ομιλητές σε αυτό το θέμα, δημιούργησε contributions σε JSON format.
Κάθε contribution είναι μια σύντομη περίληψη (3-5 προτάσεις) της θέσης του συμβούλου επί του θέματος,
σε μορφή **Markdown με ειδικά reference links**.

**ΣΗΜΑΝΤΙΚΟ - ΠΛΗΡΗΣ ΠΛΑΙΣΙΟ:**
Σου δίνεται:
1. Τα utterances ΚΑΘΕ συμβούλου (οργανωμένα ανά speakerId)
2. ΟΛΑ τα utterances της συζήτησης για το θέμα (από ΟΛΟΥΣ τους ομιλητές) - για πλαίσιο

Χρησιμοποίησε το πλήρες πλαίσιο για να καταλάβεις:
- Σε ποιον/ποια απαντά ο κάθε σύμβουλος
- Ποιές προτάσεις άλλων υποστηρίζει ή αμφισβητεί
- Πώς εντάσσεται η θέση του στη συνολική συζήτηση

ΠΡΟΣΟΧΗ: Κάθε ομιλητής πρέπει να έχει references ΜΟΝΟ στα δικά του utterances.
ΜΗΝ βάλεις references σε utterances άλλων ομιλητών.
Μπορείς όμως να αναφέρεις περιγραφικά τι είπαν άλλοι (π.χ. "Απαντώντας στις ανησυχίες για το κόστος...")

${MARKDOWN_REFERENCE_FORMAT_INSTRUCTIONS}

**Πόσα references:**
- Τουλάχιστον 2-3 utterance references ανά ομιλητή
- Μέχρι 6-8 για μεγαλύτερες τοποθετήσεις
- ΕΝΑ reference ανά κύριο επιχείρημα
- ΜΟΝΟ references στα utterances του συγκεκριμένου ομιλητή

═══════════════════════════════════════════════════════════════════════════
ΟΔΗΓΙΕΣ ΠΕΡΙΛΗΨΗΣ
═══════════════════════════════════════════════════════════════════════════

**ΤΙ ΝΑ ΠΑΡΑΛΕΙΨΕΙΣ - ΠΟΛΥ ΣΗΜΑΝΤΙΚΟ:**

**ΜΗΝ περιλαμβάνεις contribution για ομιλητές που:**
- Διευθύνουν τη συζήτηση ως Πρόεδρος (δίνουν το λόγο, ζητούν ησυχία, κλείνουν συνεδρίαση)
- Κάνουν ΜΟΝΟ διαδικαστικά (ανακοινώνουν διάλειμμα, αλλάζουν θέματα)
- Εισάγουν το θέμα χωρίς να πάρουν θέση
- Απλά διαβάζουν την εισήγηση χωρίς σχολιασμό

**Παραδείγματα ΠΡΟΣ ΠΑΡΑΛΕΙΨΗ:**
- "Διευθύνει τη συζήτηση ως Πρόεδρος, δίνοντας τον λόγο στους ομιλητές"
- "Ανακοινώνει πεντάλεπτο διάλειμμα"
- "Εισάγει το θέμα χωρίς τοποθέτηση"
- "Καλεί τους συμβούλους να ψηφίσουν"

**ΤΙ ΝΑ ΠΕΡΙΛΑΜΒΑΝΕΙΣ - Μόνο ουσιαστικές τοποθετήσεις:**
- Θέση του ομιλητή (υπέρ, κατά, επιφυλακτικός)
- Σε τι απαντά ή τι υποστηρίζει
- Κύρια επιχειρήματα
- Συγκεκριμένες προτάσεις ή ανησυχίες
- Τελική θέση

**Ύφος - ΚΡΙΣΙΜΟ:**
- ΜΗΝ χρησιμοποιείς μετα-περιγραφές: "Εισάγει το θέμα", "Παρουσιάζει", "Δηλώνει ότι", "Εξηγεί"
- Γράψε ΑΠΕΥΘΕΙΑΣ τη θέση και τα επιχειρήματα
- ΜΗΝ σχολιάζεις τη φύση της τοποθέτησης: "είναι τυπική", "περιορίζεται στην ανακοίνωση", "χωρίς περαιτέρω σχολιασμό"

**Σύγκριση:**
ΚΑΚΟ: "Εισάγει το θέμα της συγκρότησης επιτροπής, ανακοινώνοντας το ως τρίτο θέμα της ημερήσιας διάταξης. Η εισαγωγή είναι τυπική χωρίς τοποθέτηση."
ΚΑΛΟ: [Παράλειψε τον ομιλητή - δεν έχει ουσιαστική τοποθέτηση]

ΚΑΚΟ: "Δηλώνει ότι δεν έχει αντίρρηση να ψηφίσει θετικά..."
ΚΑΛΟ: "Δεν έχει αντίρρηση να ψηφίσει θετικά..."

ΚΑΚΟ: "Παρουσιάζει αναλυτικά τα στοιχεία, επισημαίνοντας ότι..."
ΚΑΛΟ: "Το πρακτικό αφορά την απόφαση 129/2023..."

ΚΑΚΟ: "Υποστηρίζει ότι η καθαριότητα έχει υποβαθμιστεί..."
ΚΑΛΟ: "Η καθαριότητα έχει υποβαθμιστεί..."

ΚΑΚΟ: "Εξηγεί ότι το κόστος θα είναι 300 χιλιάδες..."
ΚΑΛΟ: "Το κόστος θα είναι 300 χιλιάδες..."

- ΜΟΝΟ όταν χρειάζεται σύνδεση προτάσεων χρησιμοποίησε: "προτείνει", "ανησυχεί", "απαντά", "τονίζει", "διευκρινίζει"
- ΟΧΙ: "Υποστηρίζει ότι", "Εξηγεί ότι", "Επισημαίνει ότι", "Δηλώνει ότι"
- Χρησιμοποίησε τις ίδιες λέξεις του ομιλητή όπου είναι δυνατόν

**Μήκος:**
- 3-5 προτάσεις (περίπου 60-120 λέξεις)
- Περιεκτική αλλά όχι λεπτομερής
- Εστίαση στο "τι λέει" όχι "πως το λέει"

═══════════════════════════════════════════════════════════════════════════
ΜΟΡΦΗ ΑΠΟΚΡΙΣΗΣ - JSON
═══════════════════════════════════════════════════════════════════════════

Απάντησε με JSON array:

{
  "speakerContributions": [
    {
      "speakerId": "abc123",
      "text": "[Markdown με references στα utterances του συγκεκριμένου ομιλητή]"
    },
    {
      "speakerId": "def456",
      "text": "[Markdown με references στα utterances του συγκεκριμένου ομιλητή]"
    }
  ]
}

Το πεδίο text είναι το markdown κείμενο της περίληψης με references.

**ΣΗΜΑΝΤΙΚΟ - Ποιους ομιλητές να περιλάβεις:**
- Περίλαβε contribution για ΚΑΘΕ ομιλητή με **ΟΥΣΙΑΣΤΙΚΗ** τοποθέτηση
- Ακόμα και αν η συμμετοχή είναι σύντομη, περίγραψε τι είπε
- **ΠΑΡΑΛΕΙΨΕ:**
  * Ομιλητές χωρίς κανένα utterance στη λίστα
  * Πρόεδρος που διευθύνει μόνο τη συζήτηση (δίνει λόγο, ζητά ησυχία)
  * Ομιλητές με ΜΟΝΟ διαδικαστικά (ανακοινώσεις διαλειμμάτων, εισαγωγή χωρίς θέση)
- **ΑΝ ο Πρόεδρος έχει και διαδικαστικά ΚΑΙ ουσιαστική τοποθέτηση:**
  * Περίλαβε ΜΟΝΟ την ουσιαστική τοποθέτηση
  * Αγνόησε τα διαδικαστικά μέρη
`;

    // Build speakers list with their utterances
    const speakersList = Object.entries(utterancesBySpeaker)
        .map(([speakerId, utterances]) => `
**Speaker: ${speakerId}**
${utterances.map(u => `- [${u.utteranceId}] "${u.text}"`).join('\n')}
`).join('\n\n');

    // Format the full subject discussion for context
    const fullDiscussion = allSubjectUtterances
        .map((u, idx) => {
            const speakerLabel = u.speakerName || (u.speakerId ? u.speakerId : 'Unknown');
            return `${idx + 1}. [${speakerLabel}] (${formatTime(u.timestamp)}): "${u.text}" [${u.utteranceId}]`;
        })
        .join('\n');

    const userPrompt = `
Θέμα: ${subject.name}
Περιγραφή: ${subject.description}

═══════════════════════════════════════════════════════════════════════════
ΟΛΟΙ ΟΙ ΟΜΙΛΗΤΕΣ ΚΑΙ ΤΑ UTTERANCES ΤΟΥΣ
═══════════════════════════════════════════════════════════════════════════

${speakersList}

═══════════════════════════════════════════════════════════════════════════
ΠΛΗΡΗΣ ΣΥΖΗΤΗΣΗ (ΓΙΑ ΠΛΑΙΣΙΟ)
═══════════════════════════════════════════════════════════════════════════

${fullDiscussion}

Δημιούργησε contributions σε JSON format όπως περιγράφεται παραπάνω.
`;

    try {
        const result = await aiChat<{ speakerContributions: SpeakerContribution[] }>({
            systemPrompt,
            userPrompt,
            prefillSystemResponse: '{"speakerContributions": [',
            prependToResponse: '{"speakerContributions": ['
        });

        return result.result.speakerContributions;
    } catch (error) {
        console.error("Error generating speaker contributions:", error);
        // Return fallback contributions for all speakers
        return Object.keys(utterancesBySpeaker).map(speakerId => ({
            speakerId,
            text: "Σφάλμα κατά τη δημιουργία περίληψης."
        }));
    }
}

// Enrichment phase
async function enrichSubject(
    subject: SubjectInProgress,
    cityName: string,
    administrativeBodyName: string,
    date: string
): Promise<Subject> {
    // Geocode location
    let location: Subject['location'] = null;
    if (subject.locationText) {
        try {
            const locationLatLng = await geocodeLocation(subject.locationText + ", " + cityName);
            if (locationLatLng) {
                location = {
                    text: subject.locationText,
                    type: "point" as const,
                    coordinates: [[locationLatLng.lat, locationLatLng.lng]]
                };
            }
        } catch (error) {
            console.error("Error geocoding location:", error);
        }
    }

    // Get context with Claude API web search
    const context = await getSubjectContextWithClaude({
        subjectName: subject.name,
        subjectDescription: subject.description,
        cityName,
        administrativeBodyName,
        date
    });

    return {
        id: subject.id,  // Compressed ID, will be decompressed in decompressIds
        name: subject.name,
        description: subject.description,
        agendaItemIndex: subject.agendaItemIndex ?? "OUT_OF_AGENDA",
        introducedByPersonId: subject.introducedByPersonId,
        speakerContributions: subject.speakerContributions,
        topicImportance: subject.topicImportance,
        proximityImportance: subject.proximityImportance,
        location,
        topicLabel: subject.topicLabel,
        context
    };
}