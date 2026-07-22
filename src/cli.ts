#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { splitAudioDiarization } from './tasks/splitAudioDiarization.js';
import { pipeline, Task } from './tasks/pipeline.js';
import { downloadYTV } from './tasks/downloadYTV.js';
import { uploadToSpaces, deleteFromSpacesByPrefix, checkSpacesConnection } from './tasks/uploadToSpaces.js';
import { transcribe } from './tasks/transcribe.js';
import fs from 'fs';
import { diarize } from './tasks/diarize.js';
import { pollDecisions } from './tasks/pollDecisions.js';
import { extractDecisionFromPdf, adaToPdfUrl, AgendaItemRef } from './tasks/utils/decisionPdfExtraction.js';
import { processRawExtraction } from './tasks/utils/effectiveAttendance.js';
import { validateRawExtraction, validateProcessedDecision } from './tasks/utils/decisionValidation.js';
import { aiChat, formatUsage, HAIKU_MODEL } from './lib/ai.js';
import { taskManager } from './lib/TaskManager.js';
import { isObservabilityEnabled, withPhaseSpan } from './lib/observability.js';
import { listRuns, fetchRun } from './lib/runs/fetch.js';
import { showRun } from './lib/runs/show.js';
import { compareRuns } from './lib/runs/compare.js';
import { renderComparisonHtml } from './lib/runs/html.js';
import path from 'path';
import { applyDiarization } from './tasks/applyDiarization.js';
import { getExpressAppWithCallbacks, isUsingMinIO, hasRealSpacesCredentials } from './utils.js';
import { CallbackServer } from './lib/CallbackServer.js';
import PyannoteDiarizer from './lib/PyannoteDiarize.js';
import { CityLanguage, DiarizeResult } from './types.js';
import devRouter from './routes/dev.js';
import { createMuxAsset, deleteMuxAsset, hasMuxCredentials } from './lib/mux.js';
import { MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS } from './lib/ScribeTranscribe.js';
import { getVideoIdAndUrl } from './tasks/downloadYTV.js';

const program = new Command();
const app = getExpressAppWithCallbacks();

// Commander coercion for the --language option: reject anything but el/fr so a
// typo errors out instead of silently falling back to Greek.
function parseLanguageOption(value: string): CityLanguage {
    if (value !== 'el' && value !== 'fr') throw new InvalidArgumentError("expected 'el' or 'fr'");
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
    .option('-l, --language <language>', 'Content language of the meeting (el|fr)', parseLanguageOption, 'el')
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
    .option('-l, --language <language>', 'Content language of the audio (el|fr)', parseLanguageOption, 'el')
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
    .option('-l, --language <language>', 'Content language of the audio (el|fr)', parseLanguageOption, 'el')
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
                    subjects: subjects.map((s: { subjectId: string; name: string; agendaItemIndex?: number | null; existingDecision?: { ada: string; decisionTitle: string; pdfUrl: string } }) => ({
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
    .option('-l, --language <language>', 'Content language of the meeting (el|fr)', parseLanguageOption, 'el')
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
    .action(async (source: string, options: { outputFile?: string; skipCache?: boolean }) => {
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
            const { result, usage } = await extractDecisionFromPdf(pdfUrl, undefined, options.skipCache);

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

            // Compute effective attendance and infer votes (same logic as the pipeline)
            const processed = processRawExtraction(result);

            if (result.subjectInfo) {
                console.log(`Effective attendance at #${result.subjectInfo.agendaItemIndex}${result.subjectInfo.nonAgendaReason ? ' (OA)' : ''}: ${processed.effectivePresent.length} present, ${processed.effectiveAbsent.length} absent`);
            }
            if (processed.inferredVoteCount > 0) {
                console.log(`Inferred ${processed.inferredVoteCount} FOR votes from effective present members`);
            }

            // Validate and display warnings
            const rawWarnings = validateRawExtraction(result);
            const processedWarnings = validateProcessedDecision({
                voteResult: result.voteResult,
                voteDetails: processed.voteDetails.map(v => ({ vote: v.vote })),
            });
            const allWarnings = [...rawWarnings, ...processedWarnings];
            if (allWarnings.length > 0) {
                console.log(`\nWarnings (${allWarnings.length}):`);
                for (const w of allWarnings) {
                    console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
                }
            }

            const output = {
                ...result,
                effectivePresent: processed.effectivePresent,
                effectiveAbsent: processed.effectiveAbsent,
                voteDetails: processed.voteDetails,
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
    .description('Inspect and compare traced task runs (requires Langfuse env vars)');

const parseIntOption = (value: string): number => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) throw new InvalidArgumentError('expected a number');
    return parsed;
};

runsCommand
    .command('list')
    .description('List traced runs, newest first')
    .option('-t, --task <type>', 'Filter by task type', 'summarize')
    .option('-m, --meeting <cityId/meetingId>', 'Filter by meeting')
    .option('-s, --since <days>', 'Only runs from the last N days', parseIntOption)
    .option('-l, --limit <n>', 'Maximum number of runs', parseIntOption, 30)
    .action(async (options: { task: string; meeting?: string; since?: number; limit: number }) => {
        try {
            const runs = await listRuns({
                task: options.task,
                meeting: options.meeting,
                sinceDays: options.since,
                limit: options.limit,
            });

            if (runs.length === 0) {
                console.log('No traced runs found for these filters.');
                return;
            }

            console.log(`TRACE ID${' '.repeat(28)} DATE${' '.repeat(13)} MEETING${' '.repeat(25)} VER  ENV          PROMPTS       COST`);
            for (const run of runs) {
                const cost = run.totalCost !== null ? `$${run.totalCost.toFixed(2)}` : '-';
                const error = run.isError ? ' ⚠ error' : '';
                console.log(
                    `${run.traceId.padEnd(36)} ${run.timestamp.slice(0, 16).padEnd(17)} ` +
                    `${(run.meeting ?? '-').padEnd(32)} ${(run.version ?? '-').padEnd(4)} ` +
                    `${(run.env ?? '-').padEnd(12)} ${(run.promptsHash ?? '-').padEnd(13)} ${cost}${error}`
                );
            }
        } catch (error) {
            console.error('Error listing runs:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

runsCommand
    .command('show <traceId>')
    .description('Show a traced run: tags, output stats, and the span/generation tree with usage and cost')
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
                    .filter(r => !r.isError);
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
            const result = await tasksServerRequest(`/tasks/${taskId}/cancel`, 'POST');
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
            const result = await tasksServerRequest(`/tasks/${taskId}/promote`, 'POST');
            console.log(`${result.taskId}: llmMode=${result.llmMode}`);
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        } finally {
            server.close();
        }
    });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}