import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import ytdl from "@ybd-project/ytdl-core";
import cp from "child_process";
import ffmpeg from 'ffmpeg-static';
import { getFromEnvOrFile } from "../utils.js";
import { YouTubeDataScraper } from "../lib/YouTubeDataScraper.js";

dotenv.config();

const PROXY_SERVER = process.env.PROXY_SERVER;

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

    const scraper = YouTubeDataScraper.getInstance();
    const youtubeVideoId = ytdl.getURLVideoID(youtubeUrl);
    const { poToken, visitorData } = await scraper.getYouTubeData(youtubeVideoId);
    if (!poToken || !visitorData || poToken === "" || visitorData === "") {
        throw new Error('Missing poToken or visitorData.');
    }

    let agent;
    if (PROXY_SERVER) {
        console.log(`Using proxy server: ${PROXY_SERVER}, and cookies length is ${cookies.length}`);
        agent = ytdl.createProxyAgent({ uri: `http://${PROXY_SERVER}` }, cookies);
    } else {
        agent = ytdl.createAgent(cookies);
    }

    const options = { agent, poToken, visitorData };

    const formats = await (await ytdl.getInfo(youtubeUrl, options))
        .formats.map((f) => ({ quality: f.quality, mimeType: f.mimeType, itag: f.itag }))
        .filter((f) => f.mimeType?.startsWith('video/mp4'));

    const qualityPreference = ['large', 'medium', 'highestvideo'];
    const pickedVideoQuality = qualityPreference.reduce((picked: { quality: string; mimeType: string | undefined; itag: number; } | undefined, quality) => {
        return picked || formats.find(f => f.quality === quality);
    }, undefined) || formats[0];
    console.log(`Picked video quality: ${pickedVideoQuality?.itag} (${pickedVideoQuality?.quality})`);

    // @ts-ignore
    const audio = ytdl(youtubeUrl, { quality: 'highestaudio', ...options })
        .on('progress', (_, downloaded, total) => {
            tracker.audio = { downloaded, total };
            updateProgress();
        });

    // @ts-ignore
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

    await new Promise<void>((resolve, reject) => {
        const combineProcess = cp.spawn(ffmpeg as any as string, [
            '-i', videoOutputPath,
            '-i', audioOutputPath,
            '-c', 'copy',
            filePath
        ], {
            windowsHide: true,
            stdio: ['pipe', 'inherit', 'inherit']
        });

        combineProcess.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        combineProcess.on('error', (err) => {
            reject(err);
        });
    });

    return { audioOnly: audioOutputPath, combined: filePath };
};
