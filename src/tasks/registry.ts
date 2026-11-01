import type { TaskMetadata } from '../lib/TaskManager.js';
import type { Task } from './pipeline.js';
import { pipeline } from './pipeline.js';
import { summarize } from './summarize.js';
import { splitMediaFile } from './splitMediaFile.js';
import { fixTranscript } from './fixTranscript.js';
import { processAgenda } from './processAgenda.js';
import { generateVoiceprint } from './generateVoiceprint.js';
import { generateHighlight } from './generateHighlight.js';
import { pollDecisions } from './pollDecisions.js';
import { devSlowTask } from './devSlowTask.js';

export type RegisteredTask = { task: Task<any, any>; metadata: Omit<TaskMetadata, 'path'> };

/**
 * Every task the server exposes, keyed by its endpoint name. The server and the
 * eval task runner both read it, so a task's version is stated once.
 */
export const TASKS = {
    transcribe: {
        task: pipeline,
        metadata: {
            summary: 'Transcribe audio/video content',
            description: 'Convert audio or video content to text using speech recognition',
            // v3: speaker attribution uses pyannote's exclusive (non-overlapping) timeline,
            // and utterances without a covering diarization segment are assigned to the
            // nearest segment instead of being dropped
            // v4: utterances carry minWordConfidence and totalConfidence alongside the
            // existing mean confidence, all derived from Scribe's per-word logprobs
            // v5: provider language codes are normalized for every recognized language.
            // v6: accepts yt-dlp sources; results carry source metadata and source errors carry mediaFailure.
            version: 6,
        },
    },
    summarize: {
        task: summarize,
        metadata: {
            summary: 'Summarize transcript content',
            description: 'Generate a summary of transcript content with subject extraction',
            // v6: subject location coordinates are emitted as GeoJSON [lng, lat] (were [lat, lng])
            // v7: summaries no longer state vote results
            version: 7,
        },
    },
    splitMediaFile: {
        task: splitMediaFile,
        metadata: {
            summary: 'Split media file into segments',
            description: 'Split audio or video files into smaller segments based on specified time ranges'
        },
    },
    fixTranscript: {
        task: fixTranscript,
        metadata: {
            summary: 'Fix transcript formatting',
            description: 'Cleans and corrects transcription output for improved accuracy',
            // v3: with the meeting's people in the request, the result carries speakerHints — who each
            // diarization speaker is, judged from the transcript text alone, each marked
            // with the kind of evidence and whether the task would act on it
            version: 3,
        },
    },
    processAgenda: {
        task: processAgenda,
        metadata: {
            summary: 'Process meeting agenda',
            description: 'Extracts and structures agenda information from documents',
            // v4: subject location coordinates are emitted as GeoJSON [lng, lat] (were [lat, lng])
            // v5: agendaItemTitle, the item as written on the agenda (schemalabz/opencouncil#616)
            // v6: agendaSection per item, and agendaItemIndex is now the printed number, which repeats across sections (schemalabz/opencouncil#366)
            // v7: meetingRecord, the kind, session number and format that the invitation states (schemalabz/opencouncil#150)
            version: 7,
        },
    },
    generateVoiceprint: {
        task: generateVoiceprint,
        metadata: {
            summary: 'Generate voiceprint',
            description: 'Creates unique speaker voice fingerprints for identification'
        },
    },
    generateHighlight: {
        task: generateHighlight,
        metadata: {
            summary: 'Generate video highlight',
            description: 'Create video highlights from source media with visual enhancements',
            // v2: word-timed animated ASS captions (forced alignment), restyled speaker chip
            version: 2,
        },
    },
    pollDecisions: {
        task: pollDecisions,
        metadata: {
            summary: 'Poll and extract decisions from Diavgeia',
            description: 'Fetch decisions from the Greek Government Transparency portal, match them to meeting subjects, and extract structured data (excerpt, attendance, votes) from matched PDFs',
            // 4: per-document facts only (roll call as printed, named votes, changes with anchors), no replayed snapshots; per-vote absence as an event pair (2026-09-17)
            //    + actingSecretary and subjectHeading, both additive (2026-09-22); v4 has not shipped, so no bump
            //    C1 (2026-09-25): the three meeting-level fields left the result and each page gained `nameMatches`. Both precede the first deploy of version 4, so the version stays 4.
            //    C5 (2026-09-26): `absent_for_vote` is on the wire again, one entry with the anchor the page states (no departure/arrival pair), and the anchor gained `decisionNumberTo` for a range. Also before the first deploy of version 4.
            version: 4,
        },
    },
    devSlowTask: {
        task: devSlowTask,
        metadata: {
            summary: 'Dev-only slow task for testing cancellation and batch promotion',
            description: 'Sleeps cooperatively for iterations×sleepMs, optionally makes one tiny batch-first LLM call.',
            tags: ['Development'],
        },
    },
} satisfies Record<string, RegisteredTask>;

export type TaskName = keyof typeof TASKS;
