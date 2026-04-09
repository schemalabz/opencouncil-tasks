import { ResultWithUsage, addUsage, NO_USAGE } from "../lib/ai.js";
import {
    SummarizeRequest,
    SummarizeResult,
    Subject,
    DiscussionStatus
} from "../types.js";
import { Task } from "./pipeline.js";
import dotenv from 'dotenv';
import { IdCompressor } from "../utils.js";
import { enrichSubjectData, type EnrichmentInput } from "../lib/subjectEnrichment.js";
import { compressIds, decompressIds } from "./summarize/compression.js";
import { logUsage, logMultiPhaseUsage } from "../lib/usageLogging.js";
import { processBatchesWithState } from "./summarize/batchProcessing.js";
import { generateSpeakerContributions } from "./summarize/speakerContributions.js";
import { mergeSubjects } from "./summarize/mergeSubjects.js";
import { SubjectInProgress } from "./summarize/types.js";
dotenv.config();

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
    let { speakerSegmentSummaries, subjects, allUtteranceStatuses, usage: phase1Usage } =
        await processBatchesWithState(compressedRequest, idCompressor, onProgress);

    console.log(`✅ Batch processing complete:`);
    console.log(`   • Speaker segment summaries: ${speakerSegmentSummaries.length}`);
    console.log(`   • Subjects extracted: ${subjects.length}`);
    console.log(`   • Utterance statuses: ${allUtteranceStatuses.length}`);
    logUsage('Phase 1 tokens', phase1Usage);

    // Phase 1.5: Merge duplicate/fragmented subjects across batches
    console.log('');
    console.log('🔀 PHASE 1.5: Subject Merge');
    onProgress("subject_merge", 0);
    const mergeResult = await mergeSubjects(subjects, allUtteranceStatuses);
    subjects = mergeResult.subjects;
    allUtteranceStatuses = mergeResult.allUtteranceStatuses;
    const phase1_5Usage = mergeResult.usage;
    if (mergeResult.mergeCount > 0) {
        console.log(`   Subjects after merge: ${subjects.length}`);
    }
    logUsage('Phase 1.5 tokens', phase1_5Usage);
    onProgress("subject_merge", 1);

    // Phase 2: Generate speaker contributions from discussion ranges
    console.log('');
    console.log('💬 PHASE 2: Speaker Contributions');
    onProgress("speaker_contributions", 0);
    let phase2Usage = NO_USAGE;

    // Count and skip secondary subjects
    const secondarySubjects = subjects.filter(s => s.discussedIn !== null);
    const primarySubjects = subjects.filter(s => s.discussedIn === null);

    if (secondarySubjects.length > 0) {
        console.log(`   ℹ️  Skipping ${secondarySubjects.length} secondary subjects (discussed jointly):`);
        secondarySubjects.forEach(s => {
            const primary = subjects.find(p => p.id === s.discussedIn);
            console.log(`      • "${s.name}" → discussed in "${primary?.name}"`);
        });
        console.log();
    }

    console.log(`   Processing ${primarySubjects.length} primary subjects...`);

    for (let i = 0; i < subjects.length; i++) {
        const subject = subjects[i];

        // Skip secondary subjects - they were discussed jointly
        if (subject.discussedIn !== null) {
            console.log(`   [${i + 1}/${subjects.length}] Skipping "${subject.name}" (discussed in primary subject ${subject.discussedIn})`);
            subject.speakerContributions = [];  // Ensure empty
            continue;
        }

        console.log(`   [${i + 1}/${subjects.length}] Processing subject: "${subject.name}"`);
        onProgress("speaker_contributions", i / subjects.length);
        const { contributions, usage } = await generateSpeakerContributions(
            subject,
            allUtteranceStatuses,
            compressedRequest.transcript,
            idCompressor,
            request.administrativeBodyName
        );
        subject.speakerContributions = contributions;
        phase2Usage = addUsage(phase2Usage, usage);
        console.log(`      → Generated ${contributions.length} speaker contributions`);
    }

    console.log(`✅ Speaker contributions complete for ${subjects.length} subjects`);
    logUsage('Phase 2 tokens', phase2Usage);

    // Phase 3: Enrichment (geocode, context, final summary, importance)
    console.log('');
    console.log('🔍 PHASE 3: Enrichment (geocoding, context, summaries)');
    onProgress("enrichment", 0);
    let phase3Usage = NO_USAGE;
    const enrichmentResults = await Promise.all(
        subjects.map((s, i) => {
            return enrichSubject(s, request.cityName, request.administrativeBodyName, request.date).then(result => {
                console.log(`   Enriched subject ${i + 1}/${subjects.length}: "${result.result.name}"`);
                onProgress("enrichment", (i + 1) / subjects.length);
                return result;
            });
        })
    );

    // Extract enriched subjects and accumulate usage
    const enrichedSubjects = enrichmentResults.map(r => {
        phase3Usage = addUsage(phase3Usage, r.usage);
        return r.result;
    });

    console.log(`✅ Enrichment complete for ${enrichedSubjects.length} subjects`);
    logUsage('Phase 3 tokens', phase3Usage);

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
        const subjectUtteranceIds = new Set(
            allUtteranceStatuses
                .filter(s => s.subjectId === subject.id && s.status === DiscussionStatus.SUBJECT_DISCUSSION)
                .map(s => s.utteranceId)
        );
        const utterancesByParty: Record<string, number> = {};

        for (const segment of compressedRequest.transcript) {
            for (const utterance of segment.utterances) {
                if (subjectUtteranceIds.has(utterance.utteranceId)) {
                    const party = segment.speakerParty || 'Χωρίς Παράταξη';
                    utterancesByParty[party] = (utterancesByParty[party] || 0) + 1;
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

    // Phase 4: Validate utterance statuses (already generated by LLM)
    console.log('');
    console.log('📋 PHASE 4: Utterance Status Validation');

    console.log(`✅ Utterance statuses already generated by LLM: ${allUtteranceStatuses.length}`);

    // Verify distribution of utterances across subjects
    const utterancesBySubjectId = new Map<string, number>();
    allUtteranceStatuses.forEach(u => {
        if (u.status === DiscussionStatus.SUBJECT_DISCUSSION && u.subjectId) {
            utterancesBySubjectId.set(u.subjectId, (utterancesBySubjectId.get(u.subjectId) || 0) + 1);
        }
    });

    console.log('');
    console.log('🔍 Utterance distribution verification:');
    console.log(`   • Total SUBJECT_DISCUSSION utterances: ${allUtteranceStatuses.filter(u => u.status === DiscussionStatus.SUBJECT_DISCUSSION).length}`);
    console.log(`   • Unique subjects with utterances: ${utterancesBySubjectId.size}`);

    if (utterancesBySubjectId.size > 0) {
        console.log('   • Distribution per subject:');
        utterancesBySubjectId.forEach((count, subjectId) => {
            const subject = enrichedSubjects.find(s => s.id === subjectId);
            console.log(`      - ${count} utterances: ${subject?.name || subjectId}`);
        });
    }

    console.log('');
    console.log('🎯 FINAL RESULTS:');
    console.log(`   • Speaker segment summaries: ${speakerSegmentSummaries.length}`);
    console.log(`   • Subjects: ${enrichedSubjects.length}`);
    console.log(`   • Utterance discussion statuses: ${allUtteranceStatuses.length}`);
    enrichedSubjects.forEach((s, i) => {
        console.log(`      ${i + 1}. "${s.name}" (${s.speakerContributions.length} contributions, importance: ${s.topicImportance}/${s.proximityImportance})`);
    });

    // Calculate and display total token usage
    logMultiPhaseUsage('📊 TOTAL TOKEN USAGE', [
        { label: 'Phase 1 (Batch Processing)', usage: phase1Usage },
        { label: 'Phase 1.5 (Subject Merge)', usage: phase1_5Usage },
        { label: 'Phase 2 (Speaker Contributions)', usage: phase2Usage },
        { label: 'Phase 3 (Enrichment)', usage: phase3Usage }
    ]);
    console.log('✅ SUMMARIZE TASK COMPLETED');
    console.log('═══════════════════════════════════════════════════════════');

    return decompressIds({
        speakerSegmentSummaries,
        subjects: enrichedSubjects,
        utteranceDiscussionStatuses: allUtteranceStatuses
    }, idCompressor);
};

// Enrichment phase
async function enrichSubject(
    subject: SubjectInProgress,
    cityName: string,
    administrativeBodyName: string,
    date: string
): Promise<ResultWithUsage<Subject>> {
    const input: EnrichmentInput = {
        name: subject.name,
        description: subject.description,
        locationText: subject.locationText,
        topicImportance: subject.topicImportance,
        proximityImportance: subject.proximityImportance,
        topicLabel: subject.topicLabel,
        agendaItemIndex: subject.agendaItemIndex ?? "OUT_OF_AGENDA",
        introducedByPersonId: subject.introducedByPersonId,
        speakerContributions: subject.speakerContributions,
        discussedIn: subject.discussedIn
    };

    return enrichSubjectData(input, subject.id, {
        cityName,
        administrativeBodyName,
        date
    });
}