/** Download/inspection integration checks. No uploads, paid services, or external callbacks.
 * nix develop --command npx tsx scripts/verify-media-sources.ts [--remote cases.json] [--output report.json]
 * Remote cases: [{name,url,download?:boolean}]. Each download is complete, not a sample.
 */
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TaskCancelledError } from '../src/lib/taskControl.js';
import { ffmpegPath } from '../src/lib/ffmpegPath.js';
import { helpers as ytdlpHelpers } from 'ytdlp-nodejs';
import { getMediaDurationSeconds } from '../src/tasks/utils/mediaOperations.js';


const dir = mkdtempSync(path.join(tmpdir(), 'media-sources-'));
const appRootAt = process.argv.indexOf('--app-root');
const appRoot = appRootAt >= 0 ? path.resolve(process.argv[appRootAt + 1]) : undefined;
const callbackContract = process.argv.includes('--callback-contract') || Boolean(appRoot);
const bridgeToken = 'local-media-bridge';
const routeHeaders = { 'content-type': 'application/json', ...(appRoot && { authorization: `Bearer ${bridgeToken}` }) };
const updateTimeout = process.argv.includes('--update-timeout');
const updateRace = process.argv.includes('--update-race') || updateTimeout;
const inspectionFallback = process.argv.includes('--inspection-fallback');
// Pin a private copy: another download process may self-update the shared bundled zipapp.
const binary = process.env.YTDLP_BIN_PATH || ytdlpHelpers.findYtdlpBinary();
assert(binary, 'yt-dlp binary missing');
copyFileSync(binary, path.join(dir, 'yt-dlp'));
process.env.YTDLP_BIN_PATH = path.join(dir, 'yt-dlp');
process.env.YTDLP_AUTO_UPDATE = updateRace ? 'true' : 'false';
if (updateRace || inspectionFallback) {
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
 if (args.includes('-O')) {
  if (${inspectionFallback}) { console.error('ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable'); process.exit(1); }
  console.log(JSON.stringify({extractor_key:'Fixture',id:'one',duration:3}));
 }
 else {
  const at = args.includes('-o') ? args.indexOf('-o') : args.indexOf('--output');
  fs.copyFileSync(${JSON.stringify(fixture)}, args[at+1].replace('%(ext)s','mp4'));
 }
}
`);
    chmodSync(process.env.YTDLP_BIN_PATH, 0o755);
}
const { downloadMedia, downloadYTV, inspectMedia } = await import('../src/tasks/downloadYTV.js');
const { MediaDownloadError } = await import('../src/tasks/utils/mediaSource.js');
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
const callbacks: any[] = [];
app.use(express.json());
app.post('/task-callback', (req, res) => { callbacks.push(req.body); res.sendStatus(204); });
app.use('/inspectMedia', (req, res, next) => {
    if (appRoot && req.headers.authorization !== `Bearer ${bridgeToken}`) return res.sendStatus(401);
    next();
}, inspectRouter);
app.get('/redirect', (_req, res) => res.redirect('/fixture.mp4'));
app.get('/page', (_req, res) => res.type('html').send('<video controls src="/fixture.mp4"></video>'));
app.get('/webm-page', (_req, res) => res.type('html').send('<video controls src="/fixture.webm"></video>'));
app.get('/multiple', (_req, res) => res.type('html').send('<video src="/fixture.mp4"></video><video src="/second.mp4"></video>'));
app.get('/octet', (_req, res) => res.type('application/octet-stream').sendFile(path.join(fixtures, 'fixture.mp4')));
app.get('/empty', (_req, res) => res.type('html').send('<h1>No video</h1>'));
let interruptedTransfers = 0;
app.get(['/interrupted.mp4', '/concurrent-interrupted.mp4'], (req, res) => {
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
    if (callbackContract || updateRace || (selected && !selected.has(name))) return;
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
    if (!callbackContract && !updateRace && (!selected || selected.has('audio-preparation'))) {
        await ff(['-f', 'lavfi', '-i', 'color=size=32x32:color=blue', '-frames:v', '1', path.join(fixtures, 'cover.jpg')]);
        await ff(['-i', path.join(fixtures, 'audio.mp3'), '-i', path.join(fixtures, 'cover.jpg'), '-map', '0:a:0', '-map', '1:v:0', '-c', 'copy', '-disposition:v', 'attached_pic', path.join(fixtures, 'audio-cover.mp3')]);
        for (const route of ['/audio.mp3', '/audio-cover.mp3']) {
            const prepared = await downloadYTV(base + route, () => {});
            try {
                assert.equal(path.extname(prepared.combined), '.mp3', 'audio-only preparation must preserve an MP3 recording');
                assert.notEqual(prepared.combined, prepared.audioOnly, 'recording and transcription audio share a path');
                const probe = JSON.parse((await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', prepared.combined])).stdout);
                assert.equal(probe.format.format_name, 'mp3');
                assert(probe.streams.every((s: { codec_type: string }) => s.codec_type === 'audio'));
                assert(await getMediaDurationSeconds(prepared.audioOnly) > 2.9);
                reports.push({ name: 'audio-preparation', route, durationSeconds: await getMediaDurationSeconds(prepared.combined), sizeBytes: statSync(prepared.combined).size, format: 'mp3' });
            } finally { prepared.cleanup?.(); }
        }
    }
    if (!callbackContract && !updateRace && (!selected || selected.has('webm'))) {
        await ff(['-i', path.join(fixtures, 'fixture.mp4'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-c:a', 'libopus', path.join(fixtures, 'fixture.webm')]);
        const url = base + '/webm-page';
        const raw = await downloadMedia(url, () => {});
        assert.equal(raw.source.kind, 'yt-dlp');
        const probe = JSON.parse((await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', raw.combined])).stdout);
        assert(probe.format.format_name.includes('mp4'), 'yt-dlp output is not an MP4 container');
        assert(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'video'));
        assert(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'));
        const mtime = statSync(raw.combined).mtimeMs;
        const prepared = await downloadYTV(url, () => {});
        assert(await getMediaDurationSeconds(prepared.combined) > 2.9);
        assert(await getMediaDurationSeconds(prepared.audioOnly) > 2.9);
        assert.equal(statSync(raw.combined).mtimeMs, mtime, 'raw MP4 cache changed during preparation');
        reports.push({ name: 'webm', source: raw.source, sizeBytes: statSync(raw.combined).size,
            durationSeconds: await getMediaDurationSeconds(raw.combined), prepared: true, cacheReused: true });
        prepared.cleanup?.();
    }
    if (!callbackContract && !updateRace && (!selected || selected.has('concurrency'))) {
        // Real downloads and FFmpeg: both cold-cache writers and later consumers must
        // be isolated. Retain the first result while another preparation runs.
        delete process.env.SKIP_LOUDNORM;
        const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
        for (const route of ['/fixture.mp4', '/page']) {
            const url = base + route;
            const results = await Promise.allSettled([downloadYTV(url, () => {}), downloadYTV(url, () => {})]);
            const [a, b] = results.map(result => {
                if (result.status === 'rejected') throw result.reason;
                return result.value;
            });
            assert.notEqual(a.combined, b.combined, 'tasks share their prepared video');
            assert.notEqual(a.audioOnly, b.audioOnly, 'tasks share their extracted audio');
            assert.equal(path.basename(a.combined), path.basename(b.combined), 'upload names must stay stable');
            const before = [hash(a.combined), hash(a.audioOnly)];
            const raw = await downloadMedia(url, () => {});
            assert.equal(hash(raw.combined), hash(path.join(fixtures, 'fixture.mp4')), 'preparation mutated the raw cache');
            const c = await downloadYTV(url, () => {});
            assert.deepEqual([hash(a.combined), hash(a.audioOnly)], before, 'later preparation changed a prior consumer’s files');
            for (const result of [a, b, c]) {
                assert.equal(result.mediaRewritten, true, 'fixture must exercise the rewrite');
                assert(await getMediaDurationSeconds(result.combined) > 2.9);
                assert(await getMediaDurationSeconds(result.audioOnly) > 2.9);
            }
            const bHash = hash(b.combined);
            a.cleanup?.();
            assert(!existsSync(a.combined), 'task-local cleanup left its video behind');
            assert.equal(hash(b.combined), bHash, 'cleanup removed another task’s files');
            b.cleanup?.();
            c.cleanup?.();
            const cancelled = await Promise.allSettled([
                downloadMedia(url, () => { throw new TaskCancelledError(); }),
                downloadMedia(url, () => {}),
            ]);
            assert.equal(cancelled[0].status, 'rejected');
            if (cancelled[0].status === 'rejected') assert(cancelled[0].reason instanceof TaskCancelledError);
            assert.equal(cancelled[1].status, 'fulfilled', 'cancellation left the cache locked');
            assert.equal(hash(raw.combined), hash(path.join(fixtures, 'fixture.mp4')), 'cancellation dropped the cache');
            reports.push({ name: 'concurrency', route, tasks: 3, isolated: true, rawCacheUnchanged: true });
        }
        const interrupted = await Promise.allSettled([
            downloadMedia(base + '/concurrent-interrupted.mp4', () => {}),
            downloadMedia(base + '/concurrent-interrupted.mp4', () => {}),
        ]);
        assert.equal(interrupted.filter(result => result.status === 'rejected').length, 1);
        const recovered = interrupted.find(result => result.status === 'fulfilled');
        assert(recovered?.status === 'fulfilled', 'failed download left the cache locked');
        assert.equal(hash(recovered.value.combined), hash(path.join(fixtures, 'fixture.mp4')));
        reports.push({ name: 'concurrent-failure-recovery', passed: true });
        interruptedTransfers = 0;
        const workRoot = path.join(process.env.DATA_DIR!, 'work');
        rmSync(workRoot, { recursive: true, force: true });
        writeFileSync(workRoot, 'simulate an unavailable task workspace');
        try {
            await assert.rejects(downloadYTV(base + '/fixture.mp4', () => {}), (err: unknown) => {
                assert(!(err instanceof MediaDownloadError), 'local preparation was misreported as a source failure');
                assert.equal((err as NodeJS.ErrnoException).code, 'EEXIST');
                return true;
            });
        } finally { rmSync(workRoot, { force: true }); }
        reports.push({ name: 'workspace-failure', sourceFailure: false });
    }
    if (!callbackContract && !updateRace && (!selected || selected.has('interrupted'))) {
        const row: Record<string, unknown> = { name: 'interrupted' };
        try {
            await assert.rejects(downloadMedia(base + '/interrupted.mp4', () => {}), (err: unknown) => {
                assert(err instanceof MediaDownloadError);
                assert.equal(err.mediaFailure.retryable, true, 'a disconnected file may succeed on a later bounded retry');
                return true;
            });
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
    if (callbackContract) {
        process.env.ENABLE_TELEMETRY = 'false';
        process.env.CAPTURE_PAYLOADS = 'false';
        const { TaskManager } = await import('../src/lib/TaskManager.js');
        const manager = new TaskManager(1);
        await manager.runTaskWithCallback(downloadMedia, 'https://www.youtube.com/watch?v=bad', base + '/task-callback', 'transcribe', 6).completion;
        const failure = callbacks.at(-1);
        assert.equal(failure.status, 'error');
        assert.equal(failure.error, 'Invalid YouTube video ID');
        assert.deepEqual(failure.mediaFailure, {
            reason: 'unsupported', retryable: false,
            hint: 'Send the URL of a video page, a page that embeds a video player, or a media file.',
        });
        await manager.runTaskWithCallback(downloadMedia, base + '/fixture.mp4', base + '/task-callback', 'transcribe', 6).completion;
        const success = callbacks.at(-1);
        assert.equal(success.status, 'success');
        assert.equal(success.result.source.kind, 'file');
        assert.equal(success.result.source.extractor, 'Generic');
        assert.equal(success.mediaFailure, undefined);
        reports.push({ name: 'callback-contract', failure, source: success.result.source });
        if (appRoot) {
            const payload = path.join(dir, 'bridge.json');
            writeFileSync(payload, JSON.stringify({ failure, source: success.result.source }));
            const worker = fileURLToPath(new URL('./verify-agent-media-client.ts', import.meta.url));
            // Next resolves this marker at compile time; plain tsx needs the same server alias.
            const tsconfig = path.join(dir, 'app-tsconfig.json');
            writeFileSync(tsconfig, JSON.stringify({
                extends: path.join(appRoot, 'tsconfig.json'),
                compilerOptions: { baseUrl: appRoot, paths: {
                    '@/*': [path.join(appRoot, 'src/*')],
                    'server-only': [path.join(appRoot, 'node_modules/next/dist/compiled/server-only/empty.js')],
                } },
            }));
            const { stdout } = await run(process.execPath, [
                '--conditions=react-server', '--import', 'tsx', worker, appRoot, base, payload,
            ], {
                cwd: appRoot,
                env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig,
                    SKIP_ENV_VALIDATION: '1', TASK_API_URL: base, TASK_API_KEY: bridgeToken },
                timeout: 90_000,
            });
            const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
            reports.push({ name: 'app-bridge', result });
        }
    }
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
    const inspectLogs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args) => { inspectLogs.push(args.join(' ')); originalLog(...args); };
    console.warn = (...args) => { inspectLogs.push(args.join(' ')); originalWarn(...args); };
    try {
        const privateUrl = 'https://private-user:private-password@www.youtube.com/watch?v=bad&opaque=private-query#private-fragment';
        const privateResponse = await fetch(base + '/inspectMedia', { method: 'POST', headers: routeHeaders, body: JSON.stringify({ url: privateUrl }) });
        assert.equal(privateResponse.status, 200);
        assert.equal((await privateResponse.json() as { supported: boolean }).supported, false);
        const privateSpaces = await fetch(base + '/inspectMedia', { method: 'POST', headers: routeHeaders,
            body: JSON.stringify({ url: base + '/dev/files/fixture-bucket/private-object.mp4?opaque=private-query#private-fragment' }) });
        assert.equal(privateSpaces.status, 200);
        assert.equal((await privateSpaces.json() as { supported: boolean }).supported, true);
        const privateFile = await fetch(base + '/inspectMedia', { method: 'POST', headers: routeHeaders,
            body: JSON.stringify({ url: base + '/fixture.mp4?opaque=private-query' }) });
        assert.equal(privateFile.status, 200);
        assert.equal((await privateFile.json() as { supported: boolean }).supported, true);
        if (inspectionFallback) assert(inspectLogs.some(line => line.includes('[media-source]')), 'direct-file fallback warning missing');
        assert(inspectLogs.some(line => line.includes('[inspect-media]')), 'inspection log missing');
        assert(!inspectLogs.join('\n').includes('private-'), 'inspection logs expose private URL components');
    } finally { console.log = originalLog; console.warn = originalWarn; }
    const response = await fetch(base + '/inspectMedia', { method: 'POST', headers: routeHeaders, body: JSON.stringify({ url: base + '/fixture.mp4' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { supported: boolean }).supported, true);
    const malformed = await fetch(base + '/inspectMedia', { method: 'POST', headers: routeHeaders, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=bad' }) });
    assert.equal(malformed.status, 200);
    assert.equal((await malformed.json() as { supported: boolean }).supported, false);
    const bad = await fetch(base + '/inspectMedia', { method: 'POST', headers: routeHeaders, body: JSON.stringify({ url: 'file:///etc/passwd' }) });
    assert.equal(bad.status, 400);
    reports.push({ name: 'inspect-route', checks: ['valid URL: 200', 'invalid protocol: 400', 'malformed YouTube id: handled refusal', 'private URL components absent from supported/refused inspection logs'] });
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
