#!/usr/bin/env node

import { Command } from 'commander';
import { splitAudio } from './tasks/splitAudio';
import { pipeline, pipelineWithStatus } from './tasks/pipeline';
import { downloadYTV } from './tasks/downloadYTV';
import { uploadToSpaces } from './tasks/uploadToSpaces';
import { transcribe } from './tasks/transcribe';
import fs from 'fs';
import { diarize } from './tasks/diarize';
import { callbackServer } from './lib/CallbackServer';

const program = new Command();

program
    .version('1.0.0')
    .description('CLI tool for audio processing tasks');

program
    .command('split-audio <file>')
    .description('Split an audio file into segments')
    .option('-d, --max-duration <seconds>', 'Maximum duration of each segment in seconds', '3600')
    .action(async (file, options) => {
        console.log('Splitting audio...');
        const result = await splitAudio(
            { file, maxDuration: parseInt(options.maxDuration) },
            (progress) => {
                process.stdout.write(`\rSplitting audio... ${progress.toFixed(2)}%`);
            }
        );
        console.log(`Audio split into ${result.length} segments`);
        console.log(result);
    });
program
    .command('pipeline <youtubeUrl>')
    .description('Run the full pipeline on a YouTube video')
    .requiredOption('-O, --output-file <file>', 'Output file for the pipeline')
    .action(async (youtubeUrl, options) => {
        console.log('Running pipeline, output to', options.outputFile);
        const result = await pipelineWithStatus(
            { youtubeUrl, callbackUrl: '' },
            ({ stage, progressPercent }) => {
                process.stdout.write(`\rRunning pipeline... [${stage}] ${progressPercent.toFixed(2)}%`);
            }
        );
        console.log('Pipeline completed');
        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
    });

program
    .command('download-ytv <youtubeUrl>')
    .description('Download a YouTube video')
    .action(async (youtubeUrl) => {
        const result = await downloadYTV(youtubeUrl, (progress) => {
            process.stdout.write(`\rDownloading YouTube video... ${progress.toFixed(2)}%`);
        });
        console.log('\nYouTube video downloaded');
        console.log(result);
    });

program
    .command('upload-to-spaces <file>')
    .description('Upload a file to DigitalOcean Spaces')
    .option('-p, --spaces-path <path>', 'Path in DigitalOcean Spaces')
    .action(async (file, options) => {
        const result = await uploadToSpaces({ files: [file], spacesPath: options.spacesPath || "test" }, (progress) => {
            process.stdout.write(`\rUploading to DigitalOcean Spaces... ${progress.toFixed(2)}%`);
        });
        console.log('Uploaded to DigitalOcean Spaces');
        console.log(result);
    });

program
    .command('transcribe <url>')
    .description('Transcribe an audio url')
    .action(async (url) => {
        const result = await transcribe({ segments: [{ url, start: 0 }] }, (progress) => {
            process.stdout.write(`\rTranscribing audio... ${progress.toFixed(2)}%`);
        });

        console.log('Transcribed audio');
        console.log(result);
    });

program
    .command('upload-and-transcribe <file>')
    .description('Upload a file to DigitalOcean Spaces and transcribe it')
    .option('-p, --spaces-path <path>', 'Path in DigitalOcean Spaces')
    .action(async (file, options) => {
        const uploadedUrls = await uploadToSpaces({ files: [file], spacesPath: options.spacesPath || "test" }, (progress) => {
            process.stdout.write(`\rUploading to DigitalOcean Spaces... ${progress.toFixed(2)}%`);
        });

        const result = await transcribe({ segments: uploadedUrls.map((url, index) => ({ url, start: index * 3600 })) }, (progress) => {
            process.stdout.write(`\rTranscribing audio... ${progress.toFixed(2)}%`);
        });

        console.log('Transcribed audio');
        console.log(result);
    });

program
    .command('diarize <url>')
    .description('Diarize an audio url')
    .requiredOption('-O, --output-file <file>', 'Output file for the diarization')
    .action(async (url, options) => {
        const result = await diarize({ url }, (progress) => {
            process.stdout.write(`\rDiarizing audio... ${progress.toFixed(2)}%`);
        });

        fs.writeFileSync(options.outputFile, JSON.stringify(result, null, 2));
        console.log('Diarized audio saved to', options.outputFile);
    });


program
    .command('test-callback-server')
    .description('Test the callback server')
    .action(async () => {
        const { callbackPromise, url } = await callbackServer.getCallback({ timeoutMinutes: 1 });
        console.log(`Call ${url} within 1 minute to test the callback server`);
        const result = await callbackPromise;
        console.log('Callback called with: ', result);
        await callbackServer.stopServer();
    });
program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}