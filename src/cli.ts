#!/usr/bin/env node

import { Command } from 'commander';
import { splitAudioDiarization } from './tasks/splitAudioDiarization.js';
import { pipeline } from './tasks/pipeline.js';
import { downloadYTV } from './tasks/downloadYTV.js';
import { uploadToSpaces } from './tasks/uploadToSpaces.js';
import { transcribe } from './tasks/transcribe.js';
import fs from 'fs';
import { diarize } from './tasks/diarize.js';
import { applyDiarization } from './tasks/applyDiarization.js';
import { getExpressAppWithCallbacks } from './utils.js';
import { CallbackServer } from './lib/CallbackServer.js';

const program = new Command();
const app = getExpressAppWithCallbacks();
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
    console.log(`Callback server listening on port ${port}`);
});

program
    .version('1.0.0')
    .description('CLI tool for audio processing tasks');

program
    .command('split-audio <file>')
    .description('Split an audio file into segments')
    .option('-d, --max-duration <seconds>', 'Maximum duration of each segment in seconds', '3600')
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
    .action(async (youtubeUrl: string, options: { outputFile: string }) => {
        console.log('Running pipeline, output to', options.outputFile);
        const result = await pipeline(
            { youtubeUrl },
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
    .command('transcribe <url>')
    .description('Transcribe an audio url')
    .requiredOption('-O, --output-file <file>', 'Output file for the transcription')
    .action(async (url: string, options: { outputFile: string }) => {
        const result = await transcribe({ segments: [{ url, start: 0 }] }, (stage: string, progressPercent: number) => {
            process.stdout.write(`\rTranscribing audio... [${stage}] ${progressPercent.toFixed(2)}%`);
        });

        console.log('Transcribed audio');
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
    .command('diarize <url>')
    .description('Diarize an audio url')
    .requiredOption('-O, --output-file <file>', 'Output file for the diarization')
    .action(async (url: string, options: { outputFile: string }) => {
        const result = await diarize(url, (stage: string, progressPercent: number) => {
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
        const diarization = JSON.parse(fs.readFileSync(options.diarizationFile, 'utf8'));
        const transcript = JSON.parse(fs.readFileSync(options.transcriptFile, 'utf8'));
        const result = await applyDiarization({ diarization, transcript }, (stage: string, progressPercent: number) => {
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

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}