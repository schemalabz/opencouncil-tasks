import { Task } from "./pipeline";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import ytdl from "@ybd-project/ytdl-core";
import cp from "child_process";
import ffmpeg from 'ffmpeg-static';
import { getFromEnvOrFile } from "../utils";

dotenv.config();

export const downloadYTV: Task<string, { audioOnly: string, combined: string }> = async (youtubeUrl, onProgress) => {
    const randomFileName = Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
    const outputDir = process.env.DATA_DIR || "./data";
    const filePath = path.join(outputDir, `${randomFileName}.mp4`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const audioOutputPath = path.join(outputDir, `${randomFileName}_audio.mp3`);
    const videoOutputPath = path.join(outputDir, `${randomFileName}_video.mp4`);

    const tracker = {
        start: Date.now(),
        audio: { downloaded: 0, total: Infinity },
        video: { downloaded: 0, total: Infinity },
    };

    let cookies = getFromEnvOrFile('COOKIES', './secrets/cookies.json');
    let scrapeData = getFromEnvOrFile('SCRAPE_DATA', './secrets/scrapeData.json');

    const poToken = scrapeData.poToken;
    const visitorData = scrapeData.visitorData;
    if (!poToken || !visitorData) {
        throw new Error('Missing poToken or visitorData. Please ensure scrapeData.json contains valid data.');
    }

    const agent = ytdl.createAgent(cookies);
    const options = { agent, poToken, visitorData };

    const formats = await (await ytdl.getInfo(youtubeUrl, options))
        .formats.map((f) => ({ quality: f.quality, mimeType: f.mimeType, itag: f.itag }))
        .filter((f) => f.mimeType?.startsWith('video/mp4'));

    const qualityPreference = ['large', 'medium', 'highestvideo'];
    const pickedVideoQuality = qualityPreference.reduce((picked: { quality: string; mimeType: string | undefined; itag: number; } | undefined, quality) => {
        return picked || formats.find(f => f.quality === quality);
    }, undefined) || formats[0];
    console.log(`Picked video quality: ${pickedVideoQuality?.itag} (${pickedVideoQuality?.quality})`);

    const audio = ytdl(youtubeUrl, { quality: 'highestaudio', ...options })
        .on('progress', (_, downloaded, total) => {
            tracker.audio = { downloaded, total };
            updateProgress();
        });

    const video = ytdl(youtubeUrl, { quality: pickedVideoQuality?.itag, ...options })
        .on('progress', (_, downloaded, total) => {
            tracker.video = { downloaded, total };
            updateProgress();
        });

    function updateProgress() {
        const audioProgress = tracker.audio.downloaded / tracker.audio.total;
        const videoProgress = tracker.video.downloaded / tracker.video.total;
        const totalProgress = (0.25 * audioProgress) + (0.75 * videoProgress);
        onProgress("downloading-video", totalProgress * 100);
    }

    await Promise.all([
        new Promise<void>((resolve) => {
            audio.pipe(fs.createWriteStream(audioOutputPath)).on('finish', resolve);
        }),
        new Promise<void>((resolve) => {
            video.pipe(fs.createWriteStream(videoOutputPath)).on('finish', resolve);
        })
    ]);

    await new Promise<void>((resolve) => {
        const combineProcess = cp.spawn(ffmpeg || '', [
            '-i', videoOutputPath,
            '-i', audioOutputPath,
            '-c', 'copy',
            filePath
        ], {
            windowsHide: true,
            stdio: ['pipe', 'inherit', 'inherit']
        });

        combineProcess.on('close', () => {
            resolve();
        });
    });

    return { audioOnly: audioOutputPath, combined: filePath };
};