/** Local FFmpeg regression/benchmark. No services or production writes.
 * nix develop --command npx tsx scripts/verify-highlight-seeking.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ffmpegPath } from '../src/lib/ffmpegPath.js';

const dir = mkdtempSync(path.join(tmpdir(), 'highlight-seek-'));
process.env.DATA_DIR = dir;
const { getFileParts } = await import('../src/tasks/utils/mediaOperations.js');
const run = (args: string[]) => execFileSync(ffmpegPath(), ['-v', 'error', ...args], { timeout: 120_000 });
const hashes = (file: string, stream: string) => run(['-i', file, '-map', stream,
  '-f', 'framemd5', '-']).toString().split('\n').filter(l => l && !l.startsWith('#'))
  .map(l => l.split(',').slice(2).join(','));
try {
  const input = path.join(dir, 'source.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30000/1001', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000', '-t', '120', '-c:v', 'libx264', '-preset',
    'ultrafast', '-bf', '3', '-g', '250', '-c:a', 'aac', input]);
  const shifted = path.join(dir, 'shifted.mp4');
  run(['-i', input, '-c', 'copy', '-output_ts_offset', '7', shifted]);
  for (const source of [input, shifted]) {
  for (const [name, cuts, type, effect] of [
    ['near-start', [[0.123, 1.357]], 'video', undefined],
    ['late-video', [[103.123, 105.357]], 'video', undefined],
    ['separated-video', [[80.12, 81.32], [100.04, 101.24]], 'video', 'hue=s=0'],
    ['reordered-video', [[100, 101], [80, 81]], 'video', undefined],
    ['late-audio', [[103.123, 105.357]], 'audio', undefined],
  ] as const) {
    const segments = cuts.map(([startTimestamp, endTimestamp]) => ({ startTimestamp, endTimestamp }));
    const audio = type === 'audio';
    const graph = segments.map((s, i) => audio
      ? `[0:a]atrim=${s.startTimestamp}:${s.endTimestamp},asetpts=PTS-STARTPTS[a${i}];`
      : `[0:v]trim=${s.startTimestamp}:${s.endTimestamp},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${s.startTimestamp}:${s.endTimestamp},asetpts=PTS-STARTPTS[a${i}];`).join('')
      + segments.map((_, i) => audio ? `[a${i}]` : `[v${i}][a${i}]`).join('')
      + `concat=n=${segments.length}:v=${audio ? 0 : 1}:a=1${audio ? '[a]' : '[v][a]'}`
      + (effect ? `;[v]${effect}[effect]` : '');
    const baseline = path.join(dir, `${name}.${audio ? 'mp3' : 'mp4'}`);
    let start = performance.now();
    run(['-y', '-i', source, '-filter_complex', graph, ...(audio ? ['-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '128k']
      : ['-map', effect ? '[effect]' : '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac']), baseline]);
    const before = performance.now() - start;
    start = performance.now();
    const output = await getFileParts(source, segments, type, effect);
    const after = performance.now() - start;
    // Compare decoded content, frame counts and durations, not container bytes.
    if (!audio) assert.ok(JSON.stringify(hashes(output, '0:v')) === JSON.stringify(hashes(baseline, '0:v')), `${name}: video differs`);
    const pcm = (file: string) => run(['-i', file, '-map', '0:a', '-f', 's16le', '-']);
    const a = pcm(output), b = pcm(baseline);
    assert.equal(a.length, b.length, `${name}: audio sample count`);
    let error = 0;
    for (let i = 0; i < a.length; i += 2) error += (a.readInt16LE(i) - b.readInt16LE(i)) ** 2;
    const rms = Math.sqrt(error / (a.length / 2)) / 32768;
    console.log(`${name}: audio difference RMS=${rms}`);
    assert.equal(rms, 0, `${name}: decoded audio differs`);
    console.log(`${path.basename(source)} ${name}: decoded content identical; ${before.toFixed(0)}ms → ${after.toFixed(0)}ms (${(before / after).toFixed(1)}x)`);
  }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
