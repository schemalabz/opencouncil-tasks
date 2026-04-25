import { createWriteStream, statSync, renameSync, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

const MAX_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_FILES = 5; // keep 5 rotated files (~300MB total max)
const ROTATION_CHECK_MS = 60_000;

let stream: WriteStream;
let logPath: string;

function rotatedPath(i: number): string {
  return `${logPath}.${i}`;
}

function rotate(): void {
  try {
    if (!existsSync(logPath)) return;
    const { size } = statSync(logPath);
    if (size < MAX_SIZE) return;

    const oldStream = stream;

    for (let i = MAX_FILES; i > 1; i--) {
      const from = rotatedPath(i - 1);
      if (existsSync(from)) renameSync(from, rotatedPath(i));
    }
    renameSync(logPath, rotatedPath(1));

    stream = createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => {});
    oldStream.end();
  } catch {
    // rotation failure must never crash the app
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

export function enableLogPersistence(): void {
  const logDir = process.env.LOG_DIR || './logs';
  logPath = join(logDir, 'app.log');

  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    return; // can't create dir — skip file logging silently
  }

  try {
    stream = createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => {}); // suppress — never crash the app for logging
  } catch {
    return;
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = function (chunk: string | Uint8Array, ...args: unknown[]): boolean {
    try { stream.write(`${timestamp()} ${stripAnsi(String(chunk))}`); } catch {}
    return origStdoutWrite(chunk, ...(args as []));
  } as typeof process.stdout.write;

  process.stderr.write = function (chunk: string | Uint8Array, ...args: unknown[]): boolean {
    try { stream.write(`${timestamp()} [stderr] ${stripAnsi(String(chunk))}`); } catch {}
    return origStderrWrite(chunk, ...(args as []));
  } as typeof process.stderr.write;

  const timer = setInterval(rotate, ROTATION_CHECK_MS);
  timer.unref();
}
