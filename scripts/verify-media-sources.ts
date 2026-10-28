/** Download/inspection integration checks. No uploads, transcription, or callbacks.
 * nix develop --command npx tsx scripts/verify-media-sources.ts [--remote cases.json] [--output report.json]
 * Remote cases: [{name,url,download?:boolean}]. Each download is complete, not a sample.
 */
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ffmpegPath } from '../src/lib/ffmpegPath.js';
import { helpers as ytdlpHelpers } from 'ytdlp-nodejs';
import { getMediaDurationSeconds } from '../src/tasks/utils/mediaOperations.js';


const dir = mkdtempSync(path.join(tmpdir(), 'media-sources-'));
const updateTimeout = process.argv.includes('--update-timeout');
const updateRace = process.argv.includes('--update-race') || updateTimeout;
// Pin a private copy: another download process may self-update the shared bundled zipapp.
const binary = process.env.YTDLP_BIN_PATH || ytdlpHelpers.findYtdlpBinary();
assert(binary, 'yt-dlp binary missing');
copyFileSync(binary, path.join(dir, 'yt-dlp'));
process.env.YTDLP_BIN_PATH = path.join(dir, 'yt-dlp');
process.env.YTDLP_AUTO_UPDATE = updateRace ? 'true' : 'false';
if (updateRace) {
    // Deterministic updater fixture: reads during replacement fail just as Python zipimport did.
    const fixture = path.join(dir, 'fixtures', 'fixture.mp4');
    writeFileSync(process.env.YTDLP_BIN_PATH, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const lock = ${JSON.stringify(path.join(dir, 'updating'))};
if (args.includes('--version')) { console.log('update-race-fixture'); process.exit(0); }
if (args.includes('--update-to')) {
 fs.writeFileSync(lock, String(process.pid));
 if (${updateTimeout}) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
 } else setTimeout(() => { fs.unlinkSync(lock); process.exit(0); }, 500);
} else {
 if (fs.existsSync(lock)) {
  let alive = true;
  try { process.kill(Number(fs.readFileSync(lock, 'utf8')), 0); }
  catch (err) { if (err.code === 'ESRCH') alive = false; else throw err; }
  if (alive) { console.error('ERROR: binary read while updating'); process.exit(1); }
 }
 if (args.includes('-O')) console.log(JSON.stringify({extractor_key:'Fixture',id:'one',duration:3}));
 else {
  const at = args.includes('-o') ? args.indexOf('-o') : args.indexOf('--output');
  fs.copyFileSync(${JSON.stringify(fixture)}, args[at+1].replace('%(ext)s','mp4'));
 }
}
`);
    chmodSync(process.env.YTDLP_BIN_PATH, 0o755);
}
const { downloadMedia, inspectMedia } = await import('../src/tasks/downloadYTV.js');
const version = (await promisify(execFile)(process.env.YTDLP_BIN_PATH, ['--version'])).stdout.trim();
const fixtures = path.join(dir, 'fixtures');
mkdirSync(fixtures);
process.env.DATA_DIR = path.join(dir, 'downloads');
process.env.LIVESTREAM_DOWNLOAD_MAX_WAIT_MS = '1000';
process.env.LIVESTREAM_DOWNLOAD_POLL_MS = '60000';
const run = promisify(execFile);
const ff = (args: string[]) => run(ffmpegPath(), ['-v', 'error', '-y', ...args], { timeout: 60_000 });
const { default: inspectRouter } = await import('../src/routes/inspectMedia.js');
const app = express();
app.use(express.json());
app.use('/inspectMedia', inspectRouter);
app.get('/redirect', (_req, res) => res.redirect('/fixture.mp4'));
app.get('/page', (_req, res) => res.type('html').send('<video controls src="/fixture.mp4"></video>'));
app.get('/multiple', (_req, res) => res.type('html').send('<video src="/fixture.mp4"></video><video src="/second.mp4"></video>'));
app.get('/octet', (_req, res) => res.type('application/octet-stream').sendFile(path.join(fixtures, 'fixture.mp4')));
app.get('/empty', (_req, res) => res.type('html').send('<h1>No video</h1>'));
let interruptedTransfers = 0;
app.get('/interrupted.mp4', (req, res) => {
    if (req.headers['sec-ch-ua'] && interruptedTransfers++ === 0) {
        res.type('video/mp4');
        res.setHeader('content-length', statSync(path.join(fixtures, 'fixture.mp4')).size);
        res.write(readFileSync(path.join(fixtures, 'fixture.mp4')).subarray(0, 4096));
        setTimeout(() => res.destroy(), 100);
    } else res.sendFile(path.join(fixtures, 'fixture.mp4'));
});
app.use(express.static(fixtures));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const addr = server.address();
assert(addr && typeof addr !== 'string');
const base = `http://127.0.0.1:${addr.port}`;
const reports: object[] = [];
const onlyAt = process.argv.indexOf('--only');
const selected = onlyAt < 0 ? undefined : new Set(process.argv[onlyAt + 1].split(','));
async function check(name: string, url: string, download: boolean, expected?: boolean) {
    if (updateRace || (selected && !selected.has(name))) return;
    const start = Date.now();
    const inspection = await inspectMedia(url);
    const row: Record<string, unknown> = { name, url, inspection };
    try {
        if (expected !== undefined) assert.equal(inspection.supported, expected, name);
        if (download && inspection.supported && (inspection.source.durationSeconds ?? 0) > 600) {
            row.download = 'skipped: sample exceeds ten minutes';
        } else if (download && inspection.supported) {
            const result = await downloadMedia(url, () => {});
            const sizeBytes = statSync(result.combined).size;
            const durationSeconds = await getMediaDurationSeconds(result.combined);
            assert(sizeBytes > 0 && durationSeconds > 0, `${name}: empty media`);
            const before = statSync(result.combined).mtimeMs;
            const cached = await downloadMedia(url, () => {});
            assert.equal(cached.combined, result.combined);
            assert.equal(statSync(cached.combined).mtimeMs, before, `${name}: cache not reused`);
            Object.assign(row, { download: 'passed', sizeBytes, durationSeconds, source: result.source, cacheReused: true });
        }
    } catch (err) {
        row.error = (err as Error).message;
        process.exitCode = 1;
    }
    row.elapsedSeconds = (Date.now() - start) / 1000;
    reports.push(row);
    console.log(JSON.stringify(row));
}
try {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(fixtures, 'fixture.mp4')]);
    await ff(['-i', path.join(fixtures, 'fixture.mp4'), '-c', 'copy', path.join(fixtures, 'second.mp4')]);
    await ff(['-i', path.join(fixtures, 'fixture.mp4'), '-vn', path.join(fixtures, 'audio.mp3')]);
    await ff(['-i', path.join(fixtures, 'fixture.mp4'), '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0', path.join(fixtures, 'stream.m3u8')]);
    await ff(['-i', path.join(fixtures, 'fixture.mp4'), '-c', 'copy', '-f', 'dash', path.join(fixtures, 'stream.mpd')]);
    if (!updateRace && (!selected || selected.has('interrupted'))) {
        const row: Record<string, unknown> = { name: 'interrupted' };
        try {
            await assert.rejects(downloadMedia(base + '/interrupted.mp4', () => {}));
            const retried = await downloadMedia(base + '/interrupted.mp4', () => {});
            assert.equal(statSync(retried.combined).size, statSync(path.join(fixtures, 'fixture.mp4')).size, 'partial file reused');
            assert(interruptedTransfers >= 2, 'retry must fetch again');
            row.download = 'passed';
        } catch (err) { row.error = (err as Error).message; process.exitCode = 1; }
        reports.push(row);
        console.log(JSON.stringify(row));
    }
    for (const [name, route] of [['file', '/fixture.mp4'], ['audio', '/audio.mp3'], ['redirect', '/redirect'], ['octet', '/octet'], ['html5', '/page'], ['hls', '/stream.m3u8'], ['dash', '/stream.mpd']] as const)
        await check(name, base + route, true, true);
    await check('multiple', base + '/multiple', false, false);
    await check('empty', base + '/empty', false, false);
    await check('404', base + '/missing', false, false);
    process.env.DO_SPACES_BUCKET = 'fixture-bucket';
    process.env.DO_SPACES_ENDPOINT = 'http://localhost:9000';
    process.env.PUBLIC_URL = base;
    app.get('/dev/files/fixture-bucket/video.mp4', (_req, res) => res.sendFile(path.join(fixtures, 'fixture.mp4')));
    await check('spaces', base + '/dev/files/fixture-bucket/video.mp4', true, true);
    if (updateRace) {
        const downloading = downloadMedia(base + '/page', () => {});
        const deadline = Date.now() + 5000;
        while (!existsSync(path.join(dir, 'updating'))) {
            assert(Date.now() < deadline, 'updater did not start');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const [downloaded, inspection] = await Promise.all([downloading, inspectMedia(base + '/another')]);
        assert.equal(inspection.supported, true, 'lookup read the binary during update');
        assert.equal(statSync(downloaded.combined).size, statSync(path.join(fixtures, 'fixture.mp4')).size);
        reports.push({ name: updateTimeout ? 'update-timeout' : 'update-race', download: 'passed', inspection });
    }
    const response = await fetch(base + '/inspectMedia', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: base + '/fixture.mp4' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { supported: boolean }).supported, true);
    const malformed = await fetch(base + '/inspectMedia', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=bad' }) });
    assert.equal(malformed.status, 200);
    assert.equal((await malformed.json() as { supported: boolean }).supported, false);
    const bad = await fetch(base + '/inspectMedia', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'file:///etc/passwd' }) });
    assert.equal(bad.status, 400);
    reports.push({ name: 'inspect-route', checks: ['valid URL: 200', 'invalid protocol: 400', 'malformed YouTube id: handled refusal'] });
    const remote = process.argv.indexOf('--remote');
    if (remote >= 0) {
        const cases: { name: string; url: string; download?: boolean }[] = JSON.parse(readFileSync(process.argv[remote + 1], 'utf8'));
        for (const test of cases) await check(test.name, test.url, !!test.download);
    }
} finally {
    const output = process.argv.indexOf('--output');
    if (output >= 0) writeFileSync(process.argv[output + 1], JSON.stringify({ testedAt: new Date().toISOString(), ytDlpVersion: version, reports }, null, 2));
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
}
