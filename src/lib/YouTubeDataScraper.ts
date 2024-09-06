import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import { getFromEnvOrFile } from '../utils';

dotenv.config();

const PROXY_SERVER = process.env.PROXY_SERVER;

export class YouTubeDataScraper {
    private static instance: YouTubeDataScraper;
    private youtubeData: { poToken: string, visitorData: string } | null = null;

    private constructor() { }

    public static getInstance(): YouTubeDataScraper {
        if (!YouTubeDataScraper.instance) {
            YouTubeDataScraper.instance = new YouTubeDataScraper();
        }
        return YouTubeDataScraper.instance;
    }

    public async getYouTubeData(videoId: string): Promise<{ poToken: string, visitorData: string }> {
        const savedData = getFromEnvOrFile('SCRAPE_DATA', './secrets/scrapeData.json');
        if (savedData) {
            console.log("Using saved YouTube data:", savedData);
            return savedData;
        }

        if (this.youtubeData) {
            return this.youtubeData;
        }

        console.log("Launching browser to get YouTube data, with proxy server:", PROXY_SERVER);
        const browser = await puppeteer.launch({
            headless: true,
            args: PROXY_SERVER ? [`--proxy-server=${PROXY_SERVER}`] : []
        });

        try {
            const page = await browser.newPage();
            const client = await page.createCDPSession();
            await client.send("Debugger.enable");
            await client.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
            await client.send("Network.enable");

            console.log("Getting YouTube data");
            this.youtubeData = await new Promise<{ poToken: string, visitorData: string }>((resolve, reject) => {
                client.on("Network.requestWillBeSent", (e) => {
                    if (e.request.url.includes("/youtubei/v1/player")) {
                        const jsonData = JSON.parse(e.request.postData || '{}');
                        const poToken = jsonData["serviceIntegrityDimensions"]["poToken"];
                        const visitorData = jsonData["context"]["client"]["visitorData"];
                        resolve({ poToken, visitorData });
                    }
                });

                page.goto("https://www.youtube.com/embed/" + videoId, {
                    waitUntil: "networkidle2",
                }).then(() => {
                    return page.$("#movie_player");
                }).then((playButton) => {
                    if (playButton) {
                        return playButton.click();
                    }
                }).catch(reject);
            });

            console.log("Got YouTube data:", this.youtubeData);
            return this.youtubeData;
        } catch (error) {
            console.error("Error scraping YouTube data:", error);
            throw error;
        } finally {
            await browser.close();
        }
    }
}