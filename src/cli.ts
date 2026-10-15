#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { registerEvalCommands } from './evals/cli.js';
import { splitAudioDiarization } from './tasks/splitAudioDiarization.js';
import { pipeline, Task } from './tasks/pipeline.js';
import { downloadYTV } from './tasks/downloadYTV.js';
import { uploadToSpaces, deleteFromSpacesByPrefix, checkSpacesConnection } from './tasks/uploadToSpaces.js';
import { transcribe } from './tasks/transcribe.js';
import { parseEnvOption, parseIntOption } from './cliOptions.js';
import fs from 'fs';
import { diarize } from './tasks/diarize.js';
import { pollDecisions } from './tasks/pollDecisions.js';
import { extractAgenda, processAgenda } from './tasks/processAgenda.js';
import { extractAgendaMeetings } from './lib/agendaMeetingRecord.js';
import { fetchAgendaDocument } from './lib/documentConversion.js';
import { extractDecisionFromPdf, adaToPdfUrl, allowLocalPdfFiles, AgendaItemRef } from './tasks/utils/decisionPdfExtraction.js';
import { readDecisionDocument } from './tasks/utils/readDecisionDocument.js';
import { bodyTypeOfLabel } from './tasks/utils/decisionPartition.js';
import { validateRawExtraction, validateProcessedDecision } from './tasks/utils/decisionValidation.js';
import { aiChat, formatUsage, HAIKU_MODEL } from './lib/ai.js';
import { taskManager } from './lib/TaskManager.js';
import { isObservabilityEnabled, withPhaseSpan } from './lib/observability.js';
import { listRuns, fetchRun } from './lib/runs/fetch.js';
import { openArchive } from './lib/archive/store.js';
import { flushTelemetry } from './lib/telemetry/telemetry.js';
import type { RunEnv } from './lib/telemetry/context.js';
import { showRun } from './lib/runs/show.js';
import { expandRequest, findCall } from './lib/runs/call.js';
import { requireArchivedRun } from './lib/runs/fetch.js';
import { compareRuns } from './lib/runs/compare.js';
import { renderComparisonHtml } from './lib/runs/html.js';
import path from 'path';
import { applyDiarization } from './tasks/applyDiarization.js';
import { getExpressAppWithCallbacks, isUsingMinIO, hasRealSpacesCredentials, extractMeetingId } from './utils.js';
import { CallbackServer } from './lib/CallbackServer.js';
import PyannoteDiarizer from './lib/PyannoteDiarize.js';
import { AdministrativeBodyType, AgendaMeeting, AgendaMeetingRecord, CityLanguage, DiarizeResult, TaskWarning } from './types.js';
import devRouter from './routes/dev.js';
import { createMuxAsset, deleteMuxAsset, hasMuxCredentials } from './lib/mux.js';
import { MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS } from './lib/ScribeTranscribe.js';
import { listFailedCallbacks } from './lib/failedCallbackStore.js';
import { replayStoredCallback } from './lib/callbackReplay.js';
import { getVideoIdAndUrl } from './tasks/downloadYTV.js';

// Only the CLI may read a decision PDF from a local path; the server fetches URLs only.
allowLocalPdfFiles();

const program = new Command();
const app = getExpressAppWithCallbacks();

// Commander coercion for the --language option: reject anything but el/fr/sr
// so a typo errors out instead of silently falling back to Greek.
function parseLanguageOption(value: string): CityLanguage {
    if (value !== 'el' && value !== 'fr' && value !== 'sr') throw new InvalidArgumentError("expected 'el', 'fr' or 'sr'");
    return value;
}

// Mount MinIO file-serving routes when using local storage (needed for smoke tests)
if (isUsingMinIO()) {
    app.use('/dev', devRouter);
}
const port = process.env.CLI_PORT || 0; // 0 = OS assigns a free port
const server = app.listen(port, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Callback server listening on port ${boundPort}`);
});

program
    .version('1.0.0')
    .description('CLI tool for audio processing tasks');

program
    .command('split-audio <file>')
    .description('Split an audio file into segments')
    .option('-d, --max-duration <seconds>', 'Maximum duration of each segment in seconds', String(MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS))
    .option('-m, --method <method>', 'Method to use for splitting', 'diarization')
    .option('-D, --diarization-file <file>', 'Diarization file')
    .action(async (file: string, options: { maxDuration: string, method: string, diarizationFile?: string }) => {
        let result: Awaited<ReturnType<typeof splitAudioDiarization>> = [];
        if (options.method === 'diarization') {
            if (!options.diarizationFile) {
                console.error('Diarization file is required for diarization method');
                process.exit(1);
            }
            const diarization = JSON.parse(fs.readFileSync(options.diarizationFile, 'utf8'));
            result = await splitAudioDiarization(
                { file, diarization, maxDuration: parseInt(options.maxDuration) },
                (stage: string, progressPercent: number) => {
                    process.stdout.write(`\rSplitting audio... [${stage}] ${progressPercent.toFixed(2)}%`);
                }
            );
        } else {
            console.error('Invalid method, only diarization is supported');
            process.exit(1);
        }
        console.log(`Audio split into ${result.length} segments`);
        console.log(result);
        server.close();
    });

program
    .command('pipeline <youtubeUrl>')
    .description('Run the full pipeline on a YouTube video')
    .requiredOption('-O, --output-file <file>', 'Output file for the pipeline')
    .option('-l, --language <language>', 'Content language of the meeting (el|fr|sr)', parseLanguageOption, 'el')
    .action(async (youtubeUrl: string, options: { outputFile: string; language: CityLanguage }) => {
        console.log('Running pipeline, output to', options.outputFile);
        const result = await pipeline(
            { youtubeUrl, cityLanguage: options.language },
            (stage: string, progressPercent: number) => {
                process.stdout.write(`\rRunning pipeline... [${stage}] ${progressPercent.toFixed(2)}%`);
            }
        );
        console.log('Pipeline completed');
        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
        server.close();
    });

program
    .command('download-ytv <youtubeUrl>')
    .description('Download a YouTube video')
    .action(async (youtubeUrl: string) => {
        const result = await downloadYTV(youtubeUrl, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rDownloading YouTube video... [${stage}] ${progressPercent.toFixed(2)}%`);
        });
        console.log('\nYouTube video downloaded');
        console.log(result);
        server.close();
    });

program
    .command('upload-to-spaces <file>')
    .alias('upload')
    .description('Upload a file to DigitalOcean Spaces')
    .option('-p, --spaces-path <path>', 'Path in DigitalOcean Spaces')
    .action(async (file: string, options: { spacesPath?: string }) => {
        const result = await uploadToSpaces({ files: [file], spacesPath: options.spacesPath || "test" }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rUploading to DigitalOcean Spaces... [${stage}] ${progressPercent.toFixed(2)}%`);
        });
        console.log('Uploaded to DigitalOcean Spaces');
        console.log(result);
        server.close();
    });

program
    .command('transcribe-single <url>')
    .description('Transcribe an audio url')
    .requiredOption('-O, --output-file <file>', 'Output file for the transcription')
    .option('-l, --language <language>', 'Content language of the audio (el|fr|sr)', parseLanguageOption, 'el')
    .action(async (url: string, options: { outputFile: string; language: CityLanguage }) => {
        const result = await transcribe({ segments: [{ url, start: 0 }], language: options.language }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rTranscribing audio... [${stage}] ${progressPercent.toFixed(2)}%`);
        });

        console.log('Transcribed audio');
        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
        console.log('Transcription saved to', options.outputFile);
        server.close();
    });

program
    .command('transcribe <file>')
    .description('Transcribe an audio file')
    .requiredOption('-O, --output-file <file>', 'Output file for the transcription')
    .option('-v, --voiceprints <file>', 'JSON file containing voiceprints array')
    .option('-l, --language <language>', 'Content language of the audio (el|fr|sr)', parseLanguageOption, 'el')
    .action(async (file: string, options: { outputFile: string; voiceprints?: string; language: CityLanguage }) => {
        const createProgressHandler = (stage: string) => {
            return (subStage: string, perc: number) => {
                process.stdout.write(`\r${stage}:${subStage} ${perc.toFixed(2)}%`);
            };
        };
        const voiceprints = options.voiceprints ? JSON.parse(fs.readFileSync(options.voiceprints, 'utf-8')) : undefined;

        const uploadedFileUrl = await uploadToSpaces({ files: [file], spacesPath: "audio" }, createProgressHandler("uploading-file"));
        console.log("Uploaded file to DigitalOcean Spaces");

        const { diarization } = await diarize({ audioUrl: uploadedFileUrl[0], voiceprints }, createProgressHandler("diarizing"));
        console.log("Diarized audio");

        const audioSegments = await splitAudioDiarization({ file, maxDuration: MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS, diarization }, createProgressHandler("segmenting-audio"));
        console.log("Split audio into segments");

        const audioUrls = await uploadToSpaces({
            files: audioSegments.map((segment) => segment.path),
            spacesPath: "audio"
        }, createProgressHandler("uploading-audio"));
        console.log("Uploaded audio segments to DigitalOcean Spaces");

        const segments = audioSegments.map((segment, index) => ({
            url: audioUrls[index],
            start: segment.startTime
        }));

        const result = await transcribe({
            segments,
            language: options.language
        }, createProgressHandler("transcribing"));
        console.log("Transcribed audio");

        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
        console.log('Transcription saved to', options.outputFile);
        server.close();
    });

program
    .command('upload-and-transcribe <file>')
    .description('Upload a file to DigitalOcean Spaces and transcribe it')
    .option('-p, --spaces-path <path>', 'Path in DigitalOcean Spaces')
    .action(async (file: string, options: { spacesPath?: string }) => {
        const uploadedUrls = await uploadToSpaces({ files: [file], spacesPath: options.spacesPath || "test" }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rUploading to DigitalOcean Spaces... [${stage}] ${progressPercent.toFixed(2)}%`);
        });

        const result = await transcribe({ segments: uploadedUrls.map((url: string, index: number) => ({ url, start: index * 3600 })) }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rTranscribing audio... [${stage}] ${progressPercent.toFixed(2)}%`);
        });

        console.log('Transcribed audio');
        console.log(result);
        server.close();
    });

program
    .command('mux-playback-id <videoUrl>')
    .description('Create a Mux asset for a video URL and return its playback ID')
    .action(async (videoUrl: string) => {
        const { playbackId, assetId } = await createMuxAsset(videoUrl);
        console.log(`Playback ID: ${playbackId}`);
        console.log(`Asset ID: ${assetId}`);
        server.close();
    });

program
    .command('align <audioFile> <text...>')
    .description('Probe the ElevenLabs forced-alignment API: print word timestamps for the given audio + text')
    .action(async (audioFile: string, textParts: string[]) => {
        const { forcedAlign } = await import('./lib/ElevenLabsAlign.js');
        const text = textParts.join(' ');
        const startedAt = Date.now();
        const words = await forcedAlign(audioFile, text);
        console.log(`Aligned ${words.length} words in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        for (const w of words) {
            console.log(`${w.start.toFixed(2).padStart(8)}s → ${w.end.toFixed(2).padStart(8)}s  loss=${w.loss.toFixed(3)}  ${w.text}`);
        }
        server.close();
    });

program
    .command('highlight <requestFile>')
    .description('Run the generateHighlight task locally from a JSON request file (GenerateHighlightRequest without callbackUrl)')
    .action(async (requestFile: string) => {
        const { generateHighlight } = await import('./tasks/generateHighlight.js');
        const request = JSON.parse(fs.readFileSync(requestFile, 'utf-8'));
        const result = await generateHighlight(request, (stage, pct) => console.log(`[${pct.toFixed(0).padStart(3)}%] ${stage}`));
        console.log(JSON.stringify(result, null, 2));
        server.close();
    });

program
    .command('diarize <url>')
    .description('Diarize an audio url')
    .requiredOption('-O, --output-file <file>', 'Output file for the diarization')
    .option('-v, --voiceprints <file>', 'JSON file containing voiceprints array')
    .action(async (url: string, options: { outputFile: string; voiceprints?: string }) => {
        const voiceprints = options.voiceprints ? JSON.parse(fs.readFileSync(options.voiceprints, 'utf-8')) : undefined;
        const result = await diarize({ audioUrl: url, voiceprints }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rDiarizing audio... [${stage}] ${progressPercent.toFixed(2)}%`);
        });

        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
        console.log('Diarized audio saved to', options.outputFile);
        server.close();
    });

program
    .command('apply-diarization')
    .requiredOption('-D, --diarization-file <file>', 'Diarization file')
    .requiredOption('-T, --transcript-file <file>', 'Transcript file')
    .requiredOption('-O, --output-file <file>', 'Output file for the diarization')
    .action(async (options: { diarizationFile: string; transcriptFile: string; outputFile: string }) => {
        const { diarization, speakers }: DiarizeResult = JSON.parse(fs.readFileSync(options.diarizationFile, 'utf8'));
        const transcript = JSON.parse(fs.readFileSync(options.transcriptFile, 'utf8'));
        const result = await applyDiarization({ diarization, speakers, transcript }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rApplying diarization... [${stage}] ${progressPercent.toFixed(2)}%`);
        });
        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
        console.log('Diarization applied to transcript saved to', options.outputFile);
        server.close();
    });

program
    .command('test-callback-server')
    .description('Test the callback server')
    .action(async () => {
        const callbackServer = CallbackServer.getInstance();
        const { callbackPromise, url } = await callbackServer.getCallback<unknown>({ timeoutMinutes: 1 });
        console.log(`Call ${url} within 1 minute to test the callback server`);
        const result = await callbackPromise;
        console.log('Callback called with: ', result);
        server.close();
    });

program
    .command('job-status <jobId>')
    .description('Check the status of a Pyannote job')
    .action(async (jobId: string) => {
        try {
            const diarizer = PyannoteDiarizer.getInstance();
            const status = await diarizer.getJobStatus(jobId);
            console.log(JSON.stringify(status, null, 2));
        } catch (error) {
            console.error('Error checking job status:', error);
        } finally {
            server.close();
        }
    });


program
    .command('poll-decisions')
    .description('Poll decisions from Diavgeia and match them to meeting subjects')
    .option('-d, --meeting-date <date>', 'Meeting date in ISO format (YYYY-MM-DD)')
    .option('-u, --org-uid <uid>', 'Diavgeia organization UID')
    .option('--unit-id <unitIds>', 'Comma-separated Diavgeia unit IDs (e.g., 81689,81690)')
    .option('-s, --subjects-file <file>', 'JSON file (export format or subjects array)')
    .option('-O, --output-file <file>', 'Output file for the result')
    .option('--test', 'Use test subjects (for quick testing)')
    .action(async (options: {
        meetingDate?: string;
        orgUid?: string;
        unitId?: string;
        subjectsFile?: string;
        outputFile?: string;
        test?: boolean;
    }) => {
        let subjects: Array<{ subjectId: string; name: string }>;
        let meetingDate = options.meetingDate;
        let orgUid = options.orgUid;
        let unitIds: string[] | undefined = options.unitId
            ? options.unitId.split(',').map(s => s.trim()).filter(Boolean)
            : undefined;

        if (options.subjectsFile) {
            let fileContent: unknown;
            try {
                fileContent = JSON.parse(fs.readFileSync(options.subjectsFile, 'utf-8'));
            } catch (error) {
                console.error(`Error parsing subjects file: ${error instanceof Error ? error.message : error}`);
                server.close();
                process.exitCode = 1;
                return;
            }

            // Handle export format with meeting metadata
            if (fileContent && typeof fileContent === 'object' && 'meeting' in fileContent && 'subjects' in fileContent) {
                const exportFile = fileContent as { meeting: Record<string, unknown>; subjects: unknown };
                if (!Array.isArray(exportFile.subjects)) {
                    console.error('Error: subjects field must be an array');
                    server.close();
                    process.exitCode = 1;
                    return;
                }
                const invalidItem = exportFile.subjects.find(
                    (s: unknown) => !s || typeof s !== 'object' || typeof (s as any).subjectId !== 'string' || typeof (s as any).name !== 'string'
                );
                if (invalidItem) {
                    console.error('Error: each subject must have "subjectId" and "name" string fields');
                    server.close();
                    process.exitCode = 1;
                    return;
                }
                subjects = exportFile.subjects as Array<{ subjectId: string; name: string }>;
                const meeting = exportFile.meeting;
                // Use meeting metadata from file if not overridden by CLI args
                if (!options.meetingDate && meeting.date) {
                    if (typeof meeting.date !== 'string') {
                        console.error('Error: meeting.date must be a string');
                        server.close();
                        process.exitCode = 1;
                        return;
                    }
                    meetingDate = meeting.date;
                }
                if (!options.orgUid && meeting.diavgeiaOrgUid) {
                    if (typeof meeting.diavgeiaOrgUid !== 'string') {
                        console.error('Error: meeting.diavgeiaOrgUid must be a string');
                        server.close();
                        process.exitCode = 1;
                        return;
                    }
                    orgUid = meeting.diavgeiaOrgUid;
                }
                if (!options.unitId && meeting.diavgeiaUnitIds) {
                    if (!Array.isArray(meeting.diavgeiaUnitIds) || meeting.diavgeiaUnitIds.some((id: unknown) => typeof id !== 'string')) {
                        console.error('Error: meeting.diavgeiaUnitIds must be an array of strings');
                        server.close();
                        process.exitCode = 1;
                        return;
                    }
                    unitIds = meeting.diavgeiaUnitIds as string[];
                } else if (!options.unitId && meeting.diavgeiaUnitId) {
                    // Backwards compat with old export files
                    unitIds = [meeting.diavgeiaUnitId as string];
                }
                console.log(`Loaded export file: ${meeting.administrativeBody || 'Unknown body'}`);
            } else if (Array.isArray(fileContent)) {
                // Simple array format
                const invalidItem = fileContent.find(
                    (s: unknown) => !s || typeof s !== 'object' || typeof (s as any).subjectId !== 'string' || typeof (s as any).name !== 'string'
                );
                if (invalidItem) {
                    console.error('Error: each subject must have "subjectId" and "name" string fields');
                    server.close();
                    process.exitCode = 1;
                    return;
                }
                subjects = fileContent;
            } else {
                console.error('Error: Invalid subjects file format');
                server.close();
                process.exitCode = 1;
                return;
            }
        } else if (options.test) {
            // Test subjects for quick testing
            subjects = [
                { subjectId: 'test-1', name: 'Έγκριση προϋπολογισμού' },
                { subjectId: 'test-2', name: 'Ορισμός επιτροπής' },
            ];
            console.log('Using test subjects:', subjects);
        } else {
            console.error('Error: Either --subjects-file or --test is required');
            server.close();
            process.exitCode = 1;
            return;
        }

        if (!meetingDate || !orgUid) {
            console.error('Error: Meeting date and org UID are required (via CLI args or export file)');
            server.close();
            process.exitCode = 1;
            return;
        }

        console.log(`Polling decisions for org ${orgUid} from ${meetingDate}`);
        if (unitIds?.length) {
            console.log(`Unit IDs: ${unitIds.join(', ')}`);
        }
        console.log(`Number of subjects: ${subjects.length}`);

        try {
            const result = await pollDecisions(
                {
                    callbackUrl: '', // Not used for CLI
                    meetingDate,
                    diavgeiaUid: orgUid,
                    diavgeiaUnitIds: unitIds,
                    people: [], // CLI: no people for extraction
                    subjects: subjects.map((s: { subjectId: string; name: string; agendaItemIndex?: number | null; existingDecision?: { ada?: string; decisionTitle: string; pdfUrl: string } }) => ({
                        ...s,
                        agendaItemIndex: s.agendaItemIndex ?? null,
                    })),
                },
                (stage: string, progressPercent: number) => {
                    process.stdout.write(`\r[${stage}] ${progressPercent.toFixed(2)}%`);
                }
            );
            process.stdout.write('\n');

            console.log('\n--- Results ---');
            console.log(`Matched: ${result.matches.length}`);
            console.log(`Unmatched: ${result.unmatchedSubjects.length}`);
            console.log(`Ambiguous: ${result.ambiguousSubjects.length}`);
            console.log(`Total decisions fetched: ${result.metadata?.fetchedCount || 0}`);

            if (options.outputFile) {
                fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
                console.log(`\nResult saved to ${options.outputFile}`);
            } else {
                console.log('\nFull result:');
                console.log(JSON.stringify(result, null, 2));
            }
        } catch (error) {
            console.error('\nError polling decisions:', error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

const DEFAULT_SMOKE_TEST_VIDEO = "https://www.youtube.com/watch?v=3ugZUq9nm4Y";

program
    .command('smoke [youtubeUrl]')
    .description('Run a full pipeline smoke test and validate the result')
    .option('-O, --output-file <file>', 'Save full result to a JSON file')
    .option('--skip-preflight', 'Skip the callback server reachability check')
    .option('-l, --language <language>', 'Content language of the meeting (el|fr|sr)', parseLanguageOption, 'el')
    .action(async (youtubeUrl: string | undefined, options: { outputFile?: string; skipPreflight?: boolean; language: CityLanguage }) => {
        const url = youtubeUrl || process.env.SMOKE_TEST_VIDEO_URL || DEFAULT_SMOKE_TEST_VIDEO;
        console.log(`Running smoke test with: ${url}\n`);

        // Preflight: verify callback server is reachable from the outside
        if (!options.skipPreflight) {
            const publicUrl = process.env.PUBLIC_URL;
            if (!publicUrl) {
                console.error('PUBLIC_URL is not set. The pipeline requires a publicly reachable callback server');
                console.error('for external services (Pyannote) to post results back.\n');
                console.error('Options:');
                console.error('  1. Start ngrok:  ngrok http <port>');
                console.error('  2. Set PUBLIC_URL=https://your-ngrok-url.ngrok.io');
                console.error('  3. Run:  npm run smoke\n');
                console.error('Or use scripts/smoke.sh to automate ngrok setup.');
                console.error('Use --skip-preflight to bypass this check.');
                server.close();
                process.exitCode = 1;
                return;
            }

            // Self-test: hit our own callback endpoint to verify reachability
            const addr = server.address();
            const localPort = typeof addr === 'object' && addr ? addr.port : 0;
            const testId = `preflight-${Date.now()}`;
            console.log(`Preflight: checking callback server reachability...`);
            console.log(`  Local server on port ${localPort}, PUBLIC_URL=${publicUrl}`);
            try {
                const resp = await fetch(`${publicUrl}/callback/${testId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ test: true }),
                    signal: AbortSignal.timeout(10000),
                });
                // 404 is expected (no callback registered for this ID) — it means the server is reachable
                if (resp.status === 404) {
                    console.log('  Callback server is reachable\n');
                } else {
                    console.log(`  Callback server responded with ${resp.status} (expected 404, but server is reachable)\n`);
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(`  Callback server is NOT reachable: ${msg}\n`);
                console.error('Ensure ngrok (or equivalent tunnel) is running and PUBLIC_URL is correct.');
                console.error('Use --skip-preflight to bypass this check.');
                server.close();
                process.exitCode = 1;
                return;
            }
        }

        const usingRealSpaces = hasRealSpacesCredentials();
        const usingRealMux = hasMuxCredentials();
        console.log('=== Smoke Test Configuration ===');
        console.log(`  Storage:  ${usingRealSpaces ? 'DigitalOcean Spaces' : 'MinIO (local)'}`);
        console.log(`  Mux:      ${usingRealMux ? 'Real' : 'Mock (no credentials)'}`);
        console.log('================================\n');

        // Preflight: verify S3 storage is reachable
        try {
            console.log('Preflight: checking S3 storage connection...');
            await checkSpacesConnection();
            console.log('  S3 storage is reachable\n');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`  S3 storage is NOT reachable: ${msg}\n`);
            console.error('Check your DO_SPACES_ENDPOINT, DO_SPACES_KEY, DO_SPACES_SECRET, and DO_SPACES_BUCKET settings.');
            server.close();
            process.exitCode = 1;
            return;
        }

        const startTime = Date.now();
        try {
            const result = await pipeline(
                { youtubeUrl: url, cityLanguage: options.language },
                (stage: string, progressPercent: number) => {
                    process.stdout.write(`\r  [${stage}] ${progressPercent.toFixed(2)}%`);
                }
            );
            process.stdout.write('\n\n');

            // Validate result shape
            const checks: [string, boolean][] = [
                ['has videoUrl',    typeof result.videoUrl === 'string' && result.videoUrl.length > 0],
                ['has audioUrl',    typeof result.audioUrl === 'string' && result.audioUrl.length > 0],
                ['has muxPlaybackId', typeof result.muxPlaybackId === 'string' && result.muxPlaybackId.length > 0],
                ['has muxAssetId',  typeof result.muxAssetId === 'string' && result.muxAssetId.length > 0],
                ['has transcript',  result.transcript != null],
                ['has utterances',  Array.isArray(result.transcript?.transcription?.utterances) && result.transcript.transcription.utterances.length > 0],
                ['has speakers',    Array.isArray(result.transcript?.transcription?.speakers)],
                ['uses real Mux',   usingRealMux ? !result.muxPlaybackId.startsWith('MOCK') : result.muxPlaybackId.startsWith('MOCK')],
            ];

            let allPassed = true;
            for (const [label, passed] of checks) {
                const icon = passed ? 'PASS' : 'FAIL';
                console.log(`  [${icon}] ${label}`);
                if (!passed) allPassed = false;
            }

            // Clean up Mux asset if we used real credentials
            if (usingRealMux && result.muxAssetId && !result.muxAssetId.startsWith('MOCK')) {
                try {
                    console.log(`\nCleaning up Mux asset: ${result.muxAssetId}`);
                    await deleteMuxAsset(result.muxAssetId);
                } catch (cleanupErr) {
                    console.warn(`Warning: Mux cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
                }
            }

            // Clean up S3 objects if we used real DO Spaces
            if (usingRealSpaces) {
                try {
                    const { videoId } = getVideoIdAndUrl(url);
                    console.log(`\nCleaning up S3 objects for videoId: ${videoId}`);
                    await deleteFromSpacesByPrefix(`audio/${videoId}`);
                    await deleteFromSpacesByPrefix(`council-meeting-videos/${videoId}`);
                } catch (cleanupErr) {
                    console.warn(`Warning: S3 cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
                }
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`\nCompleted in ${elapsed}s`);

            if (options.outputFile) {
                fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
                console.log(`Result saved to ${options.outputFile}`);
            }

            if (!allPassed) {
                console.error('\nSmoke test FAILED — some checks did not pass');
                process.exitCode = 1;
            } else {
                console.log('\nSmoke test PASSED');
            }
        } catch (error) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.error(`\nSmoke test FAILED after ${elapsed}s`);
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

// --- Decision PDF extraction CLI ---

program
    .command('extract-decision <source>')
    .description('Extract decision data from a Diavgeia ADA, PDF URL, or local file path')
    .option('-O, --output-file <file>', 'Save result to file (otherwise prints to stdout)')
    .option('--skip-cache', 'Skip the on-disk extraction cache and re-extract from the PDF')
    .option('--hints-file <file>', "The body's conventions text, as the poll request carries it (opencouncil: scripts/conventions-text.ts); without it the page is read cold")
    .action(async (source: string, options: { outputFile?: string; skipCache?: boolean; hintsFile?: string }) => {
        try {
            // Resolve source: local file, URL, or ADA
            let pdfUrl: string;
            if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) {
                pdfUrl = source; // local file path — passed through to downloadPdfToBase64
                console.log(`Extracting decision data from local file: ${source}`);
            } else if (source.startsWith('http://') || source.startsWith('https://')) {
                pdfUrl = source; // already a URL
                console.log(`Extracting decision data from URL: ${pdfUrl}`);
            } else {
                pdfUrl = adaToPdfUrl(source); // treat as ADA
                console.log(`Extracting decision data for ADA: ${source}`);
                console.log(`PDF URL: ${pdfUrl}`);
            }
            const hints = options.hintsFile ? fs.readFileSync(options.hintsFile, 'utf-8').trim() : undefined;
            const { result, usage, warnings: readWarnings = [] } = await extractDecisionFromPdf(pdfUrl, undefined, options.skipCache, hints);

            // Display summary
            const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
            if (totalTokens > 0) {
                console.log(`\nTokens: ${formatUsage(usage)}`);
            } else {
                console.log(`\n(cached — no API call)`);
            }

            const parts: string[] = [];
            if (result.subjectInfo) {
                parts.push(`subject #${result.subjectInfo.agendaItemIndex}${result.subjectInfo.nonAgendaReason ? ' (out-of-agenda)' : ''}`);
            }
            parts.push(`${result.presentMembers?.length ?? 0} present, ${result.absentMembers?.length ?? 0} absent`);
            if (result.attendanceChanges?.length) parts.push(`${result.attendanceChanges.length} attendance changes`);
            if (result.discussionOrder) {
                const orderStr = result.discussionOrder.map(
                    (ref: AgendaItemRef) => `${ref.agendaItemIndex}${ref.nonAgendaReason ? '(OA)' : ''}`
                ).join(', ');
                parts.push(`order: [${orderStr}]`);
            }
            if (result.voteResult) parts.push(`vote: ${result.voteResult}`);
            console.log(parts.join(' | '));

            if (result.presidedBy) console.log(`Presided by: ${result.presidedBy.name}`);
            const tally = Object.entries(result.voteTally).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ');
            if (tally) console.log(`Tally: ${tally}`);

            // Validate and display warnings
            const rawWarnings = validateRawExtraction(result);
            const processedWarnings = validateProcessedDecision({
                voteResult: result.voteResult,
                voteDetails: result.voteDetails.map(v => ({ vote: v.vote })),
            });
            const allWarnings = [...readWarnings, ...rawWarnings, ...processedWarnings];
            if (allWarnings.length > 0) {
                console.log(`\nWarnings (${allWarnings.length}):`);
                for (const w of allWarnings) {
                    console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
                }
            }

            const output = {
                ...result,
                warnings: allWarnings,
            };
            const json = JSON.stringify(output, null, 2);
            if (options.outputFile) {
                fs.writeFileSync(options.outputFile, json);
                console.log(`\nResult saved to ${options.outputFile}`);
            } else {
                console.log('\n' + json);
            }
        } catch (error) {
            console.error('Error extracting decision:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

program
    .command('observability-check')
    .description('Verify Langfuse tracing end-to-end: runs a dummy task through TaskManager with one small LLM call')
    .action(async () => {
        try {
            if (!isObservabilityEnabled()) {
                console.error('Langfuse is not configured. Set LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY in .env.');
                process.exitCode = 1;
                return;
            }

            const addr = server.address();
            const boundPort = typeof addr === 'object' && addr ? addr.port : 0;
            // The cities/.../meetings/... path exercises meeting tag extraction;
            // the local callback server answers it (any /callback/:id), keeping the run self-contained.
            const callbackUrl = `http://localhost:${boundPort}/callback/cities/dev/meetings/observability-check`;

            const checkTask: Task<Record<string, never>, { ok: string }> = async (_input, onProgress) => {
                onProgress('health_check', 0);
                const response = await withPhaseSpan('Phase: health check', () =>
                    aiChat<string>({
                        model: HAIKU_MODEL,
                        systemPrompt: 'You are a health check for LLM observability. Reply with exactly: ok',
                        userPrompt: 'Reply with exactly: ok',
                        parseJson: false,
                        maxTokens: 1024,
                        label: 'observability-check',
                    })
                );
                onProgress('health_check', 1);
                return { ok: response.result.trim() };
            };

            console.log('Running observability check (one Haiku call through TaskManager)...');
            await taskManager.runTaskWithCallback(checkTask, {}, callbackUrl, 'observability-check').completion;
            await taskManager.finish();

            console.log('\n✅ Check task completed. Verify the trace in Langfuse:');
            console.log(`   ${process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com'} → Traces → filter tag "task:observability-check"`);
            console.log('   Expected: trace "observability-check" with span "Phase: health check" containing one generation.');
        } catch (error) {
            console.error('Observability check failed:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

const runsCommand = program
    .command('runs')
    .description('Inspect and compare task runs from the archive');

runsCommand
    .command('list')
    .description('List archived runs, newest first')
    .option('-t, --task <type>', 'Filter by task type, or "all"', 'summarize')
    .option('-m, --meeting <cityId/meetingId>', 'Filter by meeting')
    .option('-s, --since <days>', 'Only runs from the last N days', parseIntOption, 30)
    .option('-l, --limit <n>', 'Maximum number of runs', parseIntOption, 30)
    .option('-e, --env <env>', 'Only runs from this environment', parseEnvOption)
    .action(async (options: { task: string; meeting?: string; since: number; limit: number; env?: RunEnv }) => {
        try {
            const runs = await listRuns({
                task: options.task === 'all' ? undefined : options.task,
                meeting: options.meeting,
                sinceDays: options.since,
                limit: options.limit,
                env: options.env,
            });

            if (runs.length === 0) {
                console.log(`No runs found for these filters in ${openArchive().url}.`);
                return;
            }

            console.log(`TRACE ID${' '.repeat(28)} DATE${' '.repeat(13)} MEETING${' '.repeat(25)} VER  ENV          PROMPTS       COST`);
            for (const run of runs) {
                const cost = run.totalCost !== null ? `$${run.totalCost.toFixed(2)}` : '-';
                const error = run.isError ? ' ⚠ error' : run.isCancelled ? ' ⊘ cancelled' : '';
                console.log(
                    `${run.traceId.padEnd(36)} ${run.timestamp.slice(0, 16).padEnd(17)} ` +
                    `${(run.meeting ?? '-').padEnd(32)} ${(run.version ?? '-').padEnd(4)} ` +
                    `${(run.env ?? '-').padEnd(12)} ${(run.promptsHash ?? '-').padEnd(13)} ${cost}${error}`
                );
            }
            const total = runs.reduce((sum, run) => sum + (run.totalCost ?? 0), 0);
            console.log(`${runs.length} run${runs.length === 1 ? '' : 's'}, $${total.toFixed(2)} live spend${runs.length === options.limit ? ' (limit reached; raise --limit for the full total)' : ''}`);
        } catch (error) {
            console.error('Error listing runs:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

runsCommand
    .command('show <traceId>')
    .description('Show a run: input, output stats, and its calls by phase with usage and cost')
    .action(async (traceId: string) => {
        try {
            await showRun(traceId);
        } catch (error) {
            console.error('Error showing run:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

runsCommand
    .command('call <traceId> <selector>')
    .description('Print one call record as JSON: selector is a call id, a label, or #N (1-based position)')
    .option('-p, --part <part>', 'request, response, or all', 'all')
    .option('-x, --expand', 'inline the system prompt and output schema stored by hash')
    .action(async (traceId: string, selector: string, options: { part: string; expand?: boolean }) => {
        try {
            const store = openArchive();
            const call = findCall(await requireArchivedRun(traceId, store), selector);
            const request = options.expand ? await expandRequest(call.request, store) : call.request;
            const out = options.part === 'request' ? request : options.part === 'response' ? call.response ?? call.error : { ...call, request };
            console.log(JSON.stringify(out, null, 2));
        } catch (error) {
            console.error('Error reading call:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

runsCommand
    .command('compare [traceA] [traceB]')
    .description('Compare two summarize runs (by trace IDs, or --meeting for the two most recent)')
    .option('-m, --meeting <cityId/meetingId>', 'Compare the two most recent successful runs of this meeting')
    .option('-o, --out-dir <dir>', 'Output directory', 'data/comparisons')
    .action(async (traceA: string | undefined, traceB: string | undefined, options: { meeting?: string; outDir: string }) => {
        try {
            let fromId = traceA;
            let toId = traceB;

            if (!fromId || !toId) {
                if (!options.meeting) {
                    console.error('Provide two trace IDs, or --meeting to compare its two most recent runs.');
                    process.exitCode = 1;
                    return;
                }
                const runs = (await listRuns({ task: 'summarize', meeting: options.meeting, limit: 10 }))
                    .filter(r => !r.isError && !r.isCancelled);
                if (runs.length < 2) {
                    console.error(`Found ${runs.length} successful run(s) for ${options.meeting} — need at least 2 to compare.`);
                    process.exitCode = 1;
                    return;
                }
                // Newest-first listing: older run is "from", newer is "to"
                toId = runs[0].traceId;
                fromId = runs[1].traceId;
                console.log(`Comparing the two most recent runs of ${options.meeting}:`);
                console.log(`  from: ${fromId} (${runs[1].timestamp.slice(0, 16)})`);
                console.log(`  to:   ${toId} (${runs[0].timestamp.slice(0, 16)})`);
            }

            const [from, to] = await Promise.all([fetchRun(fromId), fetchRun(toId)]);
            const comparison = compareRuns(from, to);

            const slug = (from.info.meeting ?? 'run').replace(/\//g, '-');
            const baseName = `compare-${slug}-${fromId.slice(0, 8)}-${toId.slice(0, 8)}`;
            fs.mkdirSync(options.outDir, { recursive: true });
            const jsonPath = path.join(options.outDir, `${baseName}.json`);
            const htmlPath = path.join(options.outDir, `${baseName}.html`);
            fs.writeFileSync(jsonPath, JSON.stringify(comparison, null, 2));
            fs.writeFileSync(htmlPath, renderComparisonHtml(comparison));

            const v = comparison.verdictSummary;
            console.log(`\n${comparison.subjects.matched.length} matched subjects: ${v.structural} structural, ${v.cosmetic} cosmetic, ${v.identical} identical`);
            console.log(`Unmatched: ${comparison.subjects.fromOnly.length} from-only, ${comparison.subjects.toOnly.length} to-only`);
            console.log(`Segment diffs sampled: ${comparison.segmentSamples.length}\n`);
            for (const m of comparison.subjects.matched) {
                console.log(`  #${m.agendaItemIndex} [${m.verdict}] ${m.from.name.slice(0, 60)}${m.changes.length > 0 ? ` — ${m.changes.join(', ')}` : ''}`);
            }
            console.log(`\nJSON: ${jsonPath}`);
            console.log(`HTML: ${htmlPath} — open in a browser to review.`);
        } catch (error) {
            console.error('Error comparing runs:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

program
    .command('read-decision <source>')
    .description('Read the session date, session number and decision number a document states about itself. Source: ADA, PDF URL, or local file path')
    .option('--skip-cache', 'ignore the cached reading and call the model again')
    .action(async (source: string, options: { skipCache?: boolean }) => {
        const isPathOrUrl = source.startsWith('http://') || source.startsWith('https://')
            || source.startsWith('/') || source.startsWith('./') || source.startsWith('../');
        const pdfUrl = isPathOrUrl ? source : adaToPdfUrl(source);
        const { result, usage, fromCache } = await readDecisionDocument(pdfUrl, { skipCache: options.skipCache });
        console.log(JSON.stringify(result, null, 2));
        console.log(fromCache ? '(cached — no API call)' : `Tokens: ${formatUsage(usage)}`);
        server.close();
    });

const callbacksCommand = program
    .command('callbacks')
    .description('Inspect and replay task callbacks that could not be delivered');

callbacksCommand
    .command('list')
    .description('List undelivered callback payloads, newest first')
    .action(async () => {
        try {
            const entries = await listFailedCallbacks();
            if (entries.length === 0) {
                console.log('No undelivered callbacks.');
                return;
            }
            for (const entry of entries) {
                const failure = entry.lastStatus ?? entry.lastError ?? 'unknown';
                console.log(`${entry.savedAt}  ${entry.taskType}  ${extractMeetingId(entry.callbackUrl)}  ${entry.taskStatusId}  ${entry.attempts} attempt(s), last ${failure}`);
            }
        } catch (error) {
            console.error('Error listing callbacks:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

callbacksCommand
    .command('replay [taskStatusId]')
    .description('Redeliver a saved callback payload')
    .option('--all', 'replay every saved payload')
    .option('--force', 'post even if the task changed since the payload was saved')
    .action(async (taskStatusId: string | undefined, options: { all?: boolean; force?: boolean }) => {
        try {
            const entries = await listFailedCallbacks();
            const targets = options.all ? entries : entries.filter(e => e.taskStatusId === taskStatusId);

            if (targets.length === 0) {
                if (options.all) {
                    // An empty store is the healthy state, not a failure — a runbook
                    // wrapper checking the exit code shouldn't see this as broken.
                    console.log('No undelivered callbacks.');
                    return;
                }
                console.error(taskStatusId ? `No saved payload for ${taskStatusId}` : 'Nothing to replay. Pass a task status id or --all.');
                process.exitCode = 1;
                return;
            }

            for (const entry of targets) {
                const { replayed, reason } = await replayStoredCallback(entry, { force: Boolean(options.force) });
                console.log(replayed ? `✓ ${entry.taskStatusId} replayed` : `✗ ${entry.taskStatusId} skipped — ${reason}`);
                if (!replayed) process.exitCode = 1;
            }
        } catch (error) {
            console.error('Error replaying callbacks:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

const tasksCommand = program
    .command('tasks')
    .description('Inspect and control tasks on a running tasks server (TASKS_SERVER_URL, TASKS_API_TOKEN)');

const tasksServerUrl = () => process.env.TASKS_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;

async function tasksServerRequest(path: string, method: 'GET' | 'POST' = 'GET'): Promise<any> {
    const headers: Record<string, string> = {};
    if (process.env.TASKS_API_TOKEN) headers['Authorization'] = `Bearer ${process.env.TASKS_API_TOKEN}`;
    let response: Response;
    try {
        response = await fetch(`${tasksServerUrl()}${path}`, { method, headers });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${method} ${tasksServerUrl()}${path} failed: ${msg}`);
    }
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`${method} ${path} → ${response.status}: ${body.error || JSON.stringify(body)}`);
    }
    return body;
}

tasksCommand
    .command('list')
    .description('List running and queued tasks')
    .action(async () => {
        try {
            const { running, queued, maxParallelTasks } = await tasksServerRequest('/tasks');
            if (running.length === 0 && queued.length === 0) {
                console.log('No running or queued tasks.');
            }
            for (const t of running) {
                const runningFor = Math.round((Date.now() - new Date(t.createdAt).getTime()) / 1000);
                console.log(`${t.taskId}  ${t.taskType}  ${t.stage} ${t.progressPercent.toFixed(0)}%  llm:${t.llmMode}  running ${runningFor}s`);
            }
            for (const t of queued) {
                console.log(`${t.taskId}  ${t.taskType}  queued`);
            }
            console.log(`\n${running.length} running / ${queued.length} queued (max parallel: ${maxParallelTasks})`);
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

tasksCommand
    .command('cancel <taskId>')
    .description('Cancel a running or queued task (cooperative)')
    .action(async (taskId: string) => {
        try {
            const result = await tasksServerRequest(`/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST');
            console.log(`${result.taskId}: ${result.status}`);
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

tasksCommand
    .command('promote <taskId>')
    .description("Switch a running task's LLM calls from the Batch API to streaming")
    .action(async (taskId: string) => {
        try {
            const result = await tasksServerRequest(`/tasks/${encodeURIComponent(taskId)}/promote`, 'POST');
            console.log(`${result.taskId}: llmMode=${result.llmMode}`);
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

program
    .command('process-agenda <agendaUrl>')
    .description('Run the agenda extraction on one document (PDF or .docx URL) and print the subjects, section by section')
    .option('--city <name>', 'City name given to the model', 'Δήμος')
    .option('--date <date>', 'Meeting date given to the model (YYYY-MM-DD)', new Date().toISOString().slice(0, 10))
    .option('--language <el|fr|sr>', 'City language', parseLanguageOption, 'el')
    .option('--body <name>', 'The body that holds the meeting, e.g. "Δημοτικό Συμβούλιο"')
    .option('--body-type <type>', 'council, committee or community (default: read from --body)', parseBodyType)
    .option('--time <HH:MM>', "The meeting's start in the city's time")
    .option('--enrich', 'Also run the enrichment phase (geocoding, web context). Default: extraction only')
    .option('-O, --output-file <file>', 'Save the result JSON (the ProcessAgendaResult shape when --enrich, else the extracted subjects and warnings)')
    .action(async (agendaUrl: string, options: { city: string; date: string; language: CityLanguage; body?: string; bodyType?: AdministrativeBodyType; time?: string; enrich?: boolean; outputFile?: string }) => {
        try {
            const request = {
                agendaUrl,
                people: [],
                topicLabels: [],
                cityName: options.city,
                cityLanguage: options.language,
                date: options.date,
                administrativeBody: bodyOption(options.body, options.bodyType),
                time: options.time,
            };
            const onProgress = () => { };

            let rows: Array<{ agendaSection: { index: number; title: string } | null; agendaItemIndex: number | null; name: string; agendaItemTitle: string | null }>;
            let warnings: { code: string; severity: string; message: string }[];
            let meetings: (AgendaMeeting & { subjectCount?: number; isThisMeeting: boolean })[];
            let output: unknown;

            if (options.enrich) {
                const result = await processAgenda({ ...request, callbackUrl: 'http://localhost/cli/process-agenda' }, onProgress);
                rows = result.subjects.map(s => ({
                    agendaSection: s.agendaSection ?? null,
                    agendaItemIndex: typeof s.agendaItemIndex === 'number' ? s.agendaItemIndex : null,
                    name: s.name,
                    agendaItemTitle: s.agendaItemTitle ?? null,
                }));
                warnings = result.warnings;
                meetings = result.meetingsInAgenda;
                output = result;
            } else {
                const result = await extractAgenda(request, onProgress);
                rows = result.extracted.map(s => ({
                    agendaSection: s.agendaSectionIndex !== null && s.agendaSectionTitle !== null
                        ? { index: s.agendaSectionIndex, title: s.agendaSectionTitle }
                        : null,
                    agendaItemIndex: s.agendaItemIndex,
                    name: s.name,
                    agendaItemTitle: s.agendaItemTitle,
                }));
                warnings = result.warnings;
                meetings = result.meetings.map((m, i) => ({ ...m, subjectCount: result.extracted.filter(x => x.meetingIndex === i).length, isThisMeeting: i === result.thisMeeting }));
                output = { meetings: result.meetings, thisMeeting: result.thisMeeting, meetingRecord: result.meetingRecord, subjects: result.extracted, warnings: result.warnings };
                console.log(`\nTokens: ${formatUsage(result.extraction.usage)}`);
            }

            console.log(`\nMeetings (${meetings.length}):`);
            meetings.forEach((m, i) => console.log(`  ${m.isThisMeeting ? '→' : ' '} #${i} ${m.bodyName ?? '?'}${m.time ? ` ${m.time}` : ''}: ${m.kind ?? '-'}, session ${m.sessionNumber ?? '-'}, ${m.format ?? '-'}${m.subjectCount !== undefined ? `, ${m.subjectCount} subjects` : ''}`));

            // One block per section, in document order; an unsectioned agenda is one block.
            console.log('');
            let currentSection: number | null | undefined = undefined;
            for (const row of rows) {
                const section = row.agendaSection?.index ?? null;
                if (section !== currentSection) {
                    currentSection = section;
                    console.log(row.agendaSection ? `── Section ${row.agendaSection.index}: ${row.agendaSection.title}` : '── (no section)');
                }
                const number = row.agendaItemIndex === null ? '  -' : String(row.agendaItemIndex).padStart(3);
                console.log(`${number}  ${row.name}`);
                if (row.agendaItemTitle) console.log(`       ${row.agendaItemTitle}`);
            }

            if (warnings.length > 0) {
                console.log(`\nWarnings (${warnings.length}):`);
                for (const w of warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
            } else {
                console.log('\nNo warnings.');
            }

            if (options.outputFile) {
                fs.writeFileSync(options.outputFile, JSON.stringify(output, null, 2));
                console.log(`\nResult saved to ${options.outputFile}`);
            }
        } catch (error) {
            console.error('Error processing agenda:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });


const BODY_TYPES: AdministrativeBodyType[] = ['council', 'committee', 'community'];
function parseBodyType(value: string): AdministrativeBodyType {
    if (!BODY_TYPES.includes(value as AdministrativeBodyType)) throw new InvalidArgumentError(`expected one of ${BODY_TYPES.join(', ')}`);
    return value as AdministrativeBodyType;
}

/** The body of `--body`, with its kind from `--body-type` or else from the name itself. */
function bodyOption(name: string | undefined, type: AdministrativeBodyType | undefined): { name: string; type: AdministrativeBodyType } | undefined {
    if (!name) return undefined;
    return { name, type: type ?? bodyTypeOfLabel(name) ?? 'council' };
}

function formatMeetingRecord(record: AgendaMeetingRecord | null): string {
    if (!record) return 'not read';
    const field = (value: unknown, evidence: string | null) => `${value ?? '-'}${evidence ? `  «${evidence}»` : ''}`;
    return [
        `kind:          ${field(record.kind, record.kindEvidence)}`,
        `urgent:        ${field(record.urgent, record.urgentEvidence)}`,
        `sessionNumber: ${field(record.sessionNumber, record.sessionNumberEvidence)}`,
        `format:        ${field(record.format, record.formatEvidence)}`,
    ].join('\n');
}

program
    .command('read-meeting-record <agendaUrl>')
    .description("Read the meetings that an agenda calls, without its subjects: the reading of the archive backfill (processAgenda reads them with the subjects)")
    .option('--date <date>', 'Meeting date given to the model (YYYY-MM-DD)', new Date().toISOString().slice(0, 10))
    .option('--body <name>', 'The body that holds the meeting, e.g. "Δημοτικό Συμβούλιο"')
    .option('--body-type <type>', 'council, committee or community (default: read from --body)', parseBodyType)
    .option('--time <HH:MM>', "The meeting's start in the city's time")
    .action(async (agendaUrl: string, options: { date: string; body?: string; bodyType?: AdministrativeBodyType; time?: string }) => {
        try {
            const body = bodyOption(options.body, options.bodyType);
            const result = await extractAgendaMeetings(await fetchAgendaDocument(agendaUrl), { body, time: options.time, date: options.date });
            console.log(`\nMeetings (${result.meetings.length}):`);
            result.meetings.forEach((m, i) => console.log(`  ${i === result.thisMeeting ? '→' : ' '} #${i} ${m.bodyName ?? '?'}${m.time ? ` ${m.time}` : ''}: ${m.kind ?? '-'}, session ${m.sessionNumber ?? '-'}, ${m.format ?? '-'}`));
            console.log(`\n${formatMeetingRecord(result.record)}`);
            for (const w of result.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
            console.log(`\nTokens: ${formatUsage(result.extraction.usage)}`);
        } catch (error) {
            console.error('Error reading the meetings:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

/** One meeting of the export that opencouncil's scripts/meeting-record-export.ts writes. */
interface MeetingRecordExportRow {
    cityId: string;
    meetingId: string;
    /** The meeting's calendar date in the city's time (YYYY-MM-DD). */
    date: string;
    /** The meeting's start in the city's time (HH:MM). */
    time?: string;
    agendaUrl: string;
    administrativeBody: { name: string; type: AdministrativeBodyType } | null;
}

interface MeetingRecordRead {
    cityId: string;
    meetingId: string;
    agendaUrl: string;
    /** The body and time the reading picked this meeting by: a change re-reads it. */
    body?: string | null;
    time?: string | null;
    record: AgendaMeetingRecord | null;
    meetings: AgendaMeeting[];
    thisMeeting: number | null;
    warnings: TaskWarning[];
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
}

program
    .command('read-meeting-records <exportFile>')
    .description("Read the meetings of every agenda in an export of opencouncil (scripts/meeting-record-export.ts). The output feeds opencouncil's meeting record report. A second run with the same output reads only the meetings that are missing or failed.")
    .requiredOption('-O, --output-file <file>', 'Where the records go (JSON)')
    .option('--concurrency <n>', 'Documents read at once', (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a positive integer');
        return n;
    }, 4)
    .action(async (exportFile: string, options: { outputFile: string; concurrency: number }) => {
        try {
            const rows = (JSON.parse(fs.readFileSync(exportFile, 'utf8')) as { meetings: MeetingRecordExportRow[] }).meetings;
            const key = (r: { cityId: string; meetingId: string }) => `${r.cityId}/${r.meetingId}`;
            const bodyOf = (r: MeetingRecordExportRow) => r.administrativeBody?.name ?? null;
            const done = new Map<string, MeetingRecordRead>();
            if (fs.existsSync(options.outputFile)) {
                for (const r of (JSON.parse(fs.readFileSync(options.outputFile, 'utf8')) as { meetings: MeetingRecordRead[] }).meetings) {
                    if (!r.error) done.set(key(r), r);
                }
            }
            // A reading counts only for the agenda, body and time it was made for.
            const current = (r: MeetingRecordExportRow) => {
                const read = done.get(key(r));
                return read !== undefined && read.agendaUrl === r.agendaUrl && (read.body ?? null) === bodyOf(r) && (read.time ?? null) === (r.time ?? null);
            };
            const pending = rows.filter(r => !current(r));
            console.log(`${rows.length} meetings, ${done.size} already read, ${pending.length} to read`);

            // Written aside and renamed, so an interrupted save never truncates the paid readings.
            const save = () => {
                fs.writeFileSync(`${options.outputFile}.tmp`, JSON.stringify({
                    readAt: new Date().toISOString(),
                    meetings: rows.map(r => done.get(key(r))).filter((r): r is MeetingRecordRead => r !== undefined),
                }, null, 2));
                fs.renameSync(`${options.outputFile}.tmp`, options.outputFile);
            };

            let next = 0, input = 0, output = 0;
            const worker = async () => {
                while (next < pending.length) {
                    const row = pending[next++];
                    const base = { cityId: row.cityId, meetingId: row.meetingId, agendaUrl: row.agendaUrl, body: bodyOf(row), time: row.time ?? null };
                    try {
                        const document = await fetchAgendaDocument(row.agendaUrl);
                        // A meeting with no body is the council's.
                        const result = await extractAgendaMeetings(document, { body: row.administrativeBody ?? { type: 'council' }, time: row.time, date: row.date });
                        input += result.extraction.usage.input_tokens;
                        output += result.extraction.usage.output_tokens;
                        done.set(key(row), {
                            ...base, record: result.record, meetings: result.meetings, thisMeeting: result.thisMeeting, warnings: result.warnings,
                            inputTokens: result.extraction.usage.input_tokens, outputTokens: result.extraction.usage.output_tokens,
                        });
                        const r = result.record;
                        console.log(`  ${key(row)}: ${r ? `${r.kind ?? '-'} #${r.sessionNumber ?? '-'} ${r.format ?? '-'}` : 'not read'}${result.warnings.length ? ` (${result.warnings.map(w => w.code).join(', ')})` : ''}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        done.set(key(row), { ...base, record: null, meetings: [], thisMeeting: null, warnings: [], error: message });
                        console.log(`  ${key(row)}: error: ${message}`);
                    }
                    save();
                }
            };
            await Promise.all(Array.from({ length: options.concurrency }, worker));
            save();
            const failed = [...done.values()].filter(r => r.error).length;
            console.log(`\nRead ${pending.length - failed} of ${pending.length}${failed ? `, ${failed} failed (run again to retry)` : ''}. Tokens: ${input} in, ${output} out. -> ${options.outputFile}`);
        } catch (error) {
            console.error('Error reading the meeting records:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

/** A hand label of one invitation: what the sitting is, read by a person (or a careful reader) from the document. */
interface MeetingRecordLabel {
    key: string;
    kind: AgendaMeetingRecord['kind'];
    urgent: boolean;
    sessionNumber: number | null;
    format: AgendaMeetingRecord['format'];
    confidence?: 'high' | 'low';
    note?: string;
}

program
    .command('evaluate-meeting-records <labelsFile> <recordsFile>')
    .description('Score a read-meeting-records output against hand labels: per field, how often the record equals the label (null included), and every disagreement. Label keys are <cityId>__<meetingId>.')
    .option('--high-only', 'Leave out the labels marked low confidence')
    .action((labelsFile: string, recordsFile: string, options: { highOnly?: boolean }) => {
        const labels = (JSON.parse(fs.readFileSync(labelsFile, 'utf8')) as MeetingRecordLabel[])
            .filter(l => !options.highOnly || l.confidence !== 'low');
        const records = new Map((JSON.parse(fs.readFileSync(recordsFile, 'utf8')) as { meetings: MeetingRecordRead[] }).meetings
            .map(r => [`${r.cityId}__${r.meetingId}`, r]));
        const fields = ['kind', 'urgent', 'sessionNumber', 'format'] as const;
        const score = Object.fromEntries(fields.map(f => [f, { equal: 0, total: 0, falseValue: 0, missed: 0 }])) as
            Record<typeof fields[number], { equal: number; total: number; falseValue: number; missed: number }>;
        const disagreements: string[] = [];
        const unread: string[] = [];
        for (const label of labels) {
            const read = records.get(label.key);
            // A failed read is a run to repeat, not an answer to score.
            if (!read || read.error) { unread.push(`${label.key}: ${read?.error ?? 'no record'}`); continue; }
            for (const field of fields) {
                const want = label[field] ?? null;
                const got = read.record?.[field] ?? null;
                const s = score[field];
                s.total++;
                if (want === got) { s.equal++; continue; }
                // A wrong value would be written; a missing one (or an unread urgency) only leaves the field to a person.
                if (got !== null && got !== false) s.falseValue++; else s.missed++;
                const evidence = read.record?.[`${field}Evidence` as const];
                disagreements.push(`${label.key} ${field}: label ${want ?? '-'}, read ${got ?? '-'}${evidence ? ` «${evidence}»` : ''}${label.note ? `  [label note: ${label.note}]` : ''}`);
            }
        }
        console.log(`${labels.length} labels${options.highOnly ? ' (low-confidence labels left out)' : ''}\n`);
        for (const field of fields) {
            const s = score[field];
            console.log(`${field.padEnd(14)} ${s.equal}/${s.total} equal (${(100 * s.equal / Math.max(1, s.total)).toFixed(1)}%), ${s.falseValue} wrong value, ${s.missed} missed`);
        }
        if (unread.length > 0) console.log(`\nNot scored, not read (${unread.length}):\n${unread.map(u => `  ${u}`).join('\n')}`);
        if (disagreements.length > 0) console.log(`\nDisagreements (${disagreements.length}):\n${disagreements.map(d => `  ${d}`).join('\n')}`);
        server.close();
    });

registerEvalCommands(program);
// The callback server above keeps the process alive; eval commands don't close it themselves.
program.commands.find(c => c.name() === 'eval')?.hook('postAction', () => { server.close(); });
// Sinks buffer (archive ad-hoc calls, PostHog events); a CLI process exits right after its action.
program.hook('postAction', async () => { await flushTelemetry(); });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}