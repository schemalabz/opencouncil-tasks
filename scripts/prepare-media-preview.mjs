#!/usr/bin/env node
/**
 * PR952-only bootstrap. No app environment files are loaded, and no meetings
 * are changed. Create fresh meetings through the authenticated preview MCP.
 *
 * nix develop --command node scripts/prepare-media-preview.mjs --check
 * nix develop --command node scripts/prepare-media-preview.mjs --tasks-credentials /tmp/media-preview-tasks-secrets.json
 * nix develop --command node scripts/prepare-media-preview.mjs --output /tmp/media-preview-mcp-secrets.json
 * nix develop --command node scripts/prepare-media-preview.mjs --revoke /tmp/media-preview-mcp-secrets.json
 * nix develop --command node scripts/prepare-media-preview.mjs --verify-callback-guards /tmp/media-preview-callback-guards.json
 *
 * Output is exclusive-create, mode 0600; keep it private. Revoke before deleting
 * it. A failed creation leaves a pending file so revocation can still be retried.
 * The raw token stays local; SSH transmits only its hash and display prefix.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { open, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';

const target = {
  host: '159.89.98.26', pr: 952, port: 30952,
  database: 'opencouncil', email: 'superadmin@test.com',
  app: '/var/lib/opencouncil-previews/pr-952/app',
  dataDirectory: '/var/lib/opencouncil-previews/pr-952/postgres',
};
const node = '/nix/store/ws50yvm6vzlzf7jzz6n7xh4szddrack1-nodejs-20.19.1/bin/node';
const guardCases = [
  { name: 'success-direct', id: 'cmvy70e4p00027wklv5esx49l', meetingId: 'nov1_2026', status: 'succeeded' },
  { name: 'success-html5', id: 'cmvy719b4000u7wklgxkp1yy5', meetingId: 'nov1_2026_4', status: 'succeeded' },
  { name: 'failure-permanent', id: 'cmvy70py9000d7wkl4tt8ccgw', meetingId: 'nov1_2026_2', status: 'failed', retryable: false },
  { name: 'failure-transient', id: 'cmvy716zt000k7wklwumanbej', meetingId: 'nov1_2026_5', status: 'failed', retryable: true },
];

// New capability in existing remote(): DB reads and signed callback replays stay
// on the isolated preview host. Only digests, counters and allowlisted metadata
// leave it. Never stringify an exception or return a request/response body.
async function verifyCallbackGuards(db, config) {
  const { createHash } = require('node:crypto');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const requireGuard = (ok, code) => { if (!ok) throw new Error(code); };
  const select = {
    id: true, cityId: true, councilMeetingId: true, createdAt: true,
    status: true, type: true, version: true, responseBody: true, requestBody: true,
    failureReason: true, stage: true, percentComplete: true,
  };
  async function snapshot(test) {
    return db.$transaction(async tx => {
      const [identity] = await tx.$queryRawUnsafe(
        "SELECT current_database() AS database, inet_server_port() AS port, current_setting('data_directory') AS directory");
      requireGuard(identity.database === config.target.database && identity.port === config.target.port &&
        identity.directory === config.target.dataDirectory, 'ISOLATION_CHECK_FAILED');
      const row = await tx.taskStatus.findUnique({ where: { id: test.id }, select });
      requireGuard(row && row.cityId === 'athens' && row.councilMeetingId === test.meetingId &&
        /^[a-z]{3}\d{1,2}_\d{4}(?:_[0-9]+)?$/.test(row.councilMeetingId) &&
        row.createdAt >= new Date(test.notBefore ?? '2026-11-01T18:57:00Z') &&
        row.createdAt < new Date(test.notAfter ?? '2026-11-02T00:00:00Z') &&
        row.type === 'transcribe' && row.status === test.status && row.version === 6,
      'TASK_SCOPE_OR_TERMINAL_CHECK_FAILED');
      if (test.expectMp3) {
        const result = JSON.parse(row.responseBody);
        const request = JSON.parse(row.requestBody);
        const meeting = await tx.councilMeeting.findUnique({
          where: { cityId_id: { cityId: row.cityId, id: row.councilMeetingId } }, select: { videoUrl: true },
        });
        // The HTTP/ffprobe check read the uploaded object. Prove that this is
        // also the actual processed result and persisted meeting recording.
        requireGuard(result.source?.kind === 'spaces' && result.videoUrl === request.youtubeUrl &&
          new URL(result.videoUrl).hostname === 'opencouncil-previews.fra1.digitaloceanspaces.com' &&
          new URL(result.videoUrl).pathname.endsWith('.mp3') && meeting?.videoUrl === result.videoUrl,
        'PROCESSED_MP3_RECORDING_MISMATCH');
      }
      const scope = { cityId: row.cityId, meetingId: row.councilMeetingId };
      const counters = {
        speakerSegments: await tx.speakerSegment.count({ where: scope }),
        utterances: await tx.utterance.count({ where: { speakerSegment: scope } }),
        words: await tx.word.count({ where: { utterance: { speakerSegment: scope } } }),
        tasks: await tx.taskStatus.count({ where: { cityId: row.cityId, councilMeetingId: row.councilMeetingId } }),
      };
      const state = {
        status: row.status, version: row.version, bodyDigest: digest(row.responseBody),
        failureReasonDigest: digest(row.failureReason), stageDigest: digest(row.stage),
        percentComplete: row.percentComplete, requestBodyDigest: digest(row.requestBody), counters,
      };
      return { row, state, digest: digest(state) };
    }, { isolationLevel: 'RepeatableRead' });
  }
  const report = {
    target: config.target, startedAt: new Date().toISOString(), status: 'failed', tasks: [],
    legacyMetadata: { status: 'skipped', reason: 'Requires a separate fresh TaskStatus; existing metadata preserved and no records created' },
  };
  try {
    // Preflight ALL rows before the first HTTP request. No task creation or DB writes.
    const prepared = [];
    for (const test of config.cases) {
      const before = await snapshot(test);
      const request = JSON.parse(before.row.requestBody);
      const callback = new URL(request.callbackUrl);
      requireGuard(callback.protocol === 'https:' && callback.hostname === 'pr-952.opencouncil.dev' &&
        callback.port === '' && !callback.username && !callback.password && !callback.hash &&
        callback.pathname === '/api/cities/athens/meetings/' + test.meetingId + '/taskStatuses/' + test.id &&
        callback.searchParams.getAll('token').length === 1 && Boolean(callback.searchParams.get('token')) &&
        [...callback.searchParams.keys()].every(key => key === 'token'), 'CALLBACK_URL_SCOPE_FAILED');
      const body = JSON.parse(before.row.responseBody);
      let summary;
      if (test.status === 'failed') {
        requireGuard(body.$opencouncilTaskResponse === 'media-source-failure-v1' &&
          ['unsupported', 'playlist', 'embed_only', 'login_required', 'drm', 'unavailable', 'not_found', 'error'].includes(body.mediaFailure?.reason) &&
          body.mediaFailure.retryable === test.retryable && typeof before.row.failureReason === 'string', 'FAILURE_METADATA_FAILED');
        summary = { envelope: body.$opencouncilTaskResponse, reason: body.mediaFailure.reason, retryable: body.mediaFailure.retryable };
      } else {
        requireGuard(['spaces', 'file', 'yt-dlp'].includes(body.source?.kind) &&
          before.state.counters.speakerSegments > 0 && before.state.counters.utterances > 0 &&
          before.row.failureReason === null, 'SUCCESS_METADATA_FAILED');
        summary = { kind: body.source.kind,
          ...(Number.isFinite(body.source.durationSeconds) ? { durationSeconds: body.source.durationSeconds } : {}) };
      }
      const entry = { name: test.name, id: test.id, meetingId: test.meetingId,
        createdAt: before.row.createdAt, type: before.row.type, version: before.row.version,
        status: before.row.status, metadata: summary, before: before.state, beforeDigest: before.digest, checks: [] };
      report.tasks.push(entry);
      prepared.push({ test, before, callback, body, entry });
    }
    for (const { test, before, callback, body, entry } of prepared) {
      const late = { status: 'processing', version: 6, stage: 'callback guard late processing', progressPercent: 1 };
      const unsigned = new URL(callback);
      unsigned.search = '';
      const duplicate = test.status === 'failed'
        ? { status: 'error', version: 6, error: before.row.failureReason, mediaFailure: body.mediaFailure }
        : { status: 'success', version: 6, result: body };
      for (const [name, url, payload, expected] of [
        ['missing-token', unsigned, late, 401],
        ['late-processing', callback, late, 200],
        [test.status === 'failed' ? 'duplicate-typed-error' : 'duplicate-stored-success', callback, duplicate, 200],
      ]) {
        const check = { name, expectedHttpStatus: expected, httpStatus: null, unchanged: false };
        entry.checks.push(check);
        try {
          const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(8000) });
          check.httpStatus = response.status;
          await response.body?.cancel();
        } catch { check.error = 'CALLBACK_TRANSPORT_FAILED'; }
        const after = await snapshot(test);
        entry.after = after.state;
        entry.afterDigest = after.digest;
        check.unchanged = after.digest === before.digest;
        requireGuard(check.unchanged, 'CALLBACK_CHANGED_TERMINAL_STATE');
        requireGuard(check.httpStatus === expected, 'CALLBACK_HTTP_STATUS_FAILED');
      }
    }
    // Cross-check every record again after the whole sequence, not just its own callbacks.
    for (const { test, before, entry } of prepared) {
      const after = await snapshot(test);
      entry.after = after.state;
      entry.afterDigest = after.digest;
      requireGuard(after.digest === before.digest, 'CALLBACK_CHANGED_TERMINAL_STATE');
    }
    report.status = 'passed';
  } catch (error) {
    const allowed = ['ISOLATION_CHECK_FAILED', 'TASK_SCOPE_OR_TERMINAL_CHECK_FAILED', 'CALLBACK_URL_SCOPE_FAILED',
      'FAILURE_METADATA_FAILED', 'SUCCESS_METADATA_FAILED', 'CALLBACK_CHANGED_TERMINAL_STATE', 'CALLBACK_HTTP_STATUS_FAILED', 'PROCESSED_MP3_RECORDING_MISMATCH'];
    report.error = allowed.includes(error.message) ? error.message : 'CALLBACK_GUARD_OPERATION_FAILED';
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// New capability: mint/revoke a disposable token through the deployed app's
// Prisma client. Existing seed/testUsers owns account setup; require its seeded
// super-admin instead of duplicating its grants, fixtures, or seed logic.
function remote(action, token = {}) {
  const config = Buffer.from(JSON.stringify({ target, action, ...token })).toString('base64');
  const source = `
const { createRequire } = require('node:module');
const { realpathSync } = require('node:fs');
const config = JSON.parse(Buffer.from('${config}', 'base64').toString());
const { target, action } = config;
const appRuntime = realpathSync(target.app);
// Match the packaged start.sh engine override without sourcing app environment.
process.env.PRISMA_QUERY_ENGINE_LIBRARY = appRuntime + '/prisma/libquery_engine.node';
const appRequire = createRequire(appRuntime + '/package.json');
const { PrismaClient } = appRequire('@prisma/client');
const db = new PrismaClient({ datasourceUrl: 'postgresql://opencouncil@127.0.0.1:30952/opencouncil', log: [] });
const verifyCallbackGuards = ${verifyCallbackGuards.toString()};
(async () => {
  const result = await db.$transaction(async tx => {
    const [identity] = await tx.$queryRawUnsafe(
      "SELECT current_database() AS database, inet_server_port() AS port, current_setting('data_directory') AS directory");
    if (identity.database !== target.database || identity.port !== target.port || identity.directory !== target.dataDirectory)
      throw new Error('ISOLATION_CHECK_FAILED');
    const user = await tx.user.findUnique({ where: { email: target.email }, select: { id: true, email: true, name: true, isSuperAdmin: true } });
    if (!user?.isSuperAdmin) throw new Error('SEEDED_SUPERADMIN_MISSING');
    const summary = { target, appRuntime, user };
    if (action === 'check' || action === 'verify-callback-guards') return summary;
    if (action === 'revoke') {
      const result = await tx.userMcpToken.updateMany({
        where: { hashedKey: config.hashedKey, userId: user.id, name: config.name, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      return { ...summary, revokedCount: result.count };
    }
    const row = await tx.userMcpToken.create({ data: {
      userId: user.id, name: config.name, hashedKey: config.hashedKey, keyPrefix: config.keyPrefix
    }, select: { id: true } });
    return { ...summary, tokenId: row.id };
  });
  process.stdout.write(JSON.stringify(action === 'verify-callback-guards' ? await verifyCallbackGuards(db, config) : result));
})().catch(error => {
  // Never print Prisma errors: they can contain query/connection details.
  console.error(['ISOLATION_CHECK_FAILED', 'SEEDED_SUPERADMIN_MISSING'].includes(error.message)
    ? error.message : 'PREVIEW_DATABASE_OPERATION_FAILED');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
`;
  const child = spawnSync('ssh', [
    '-i', resolve(homedir(), '.ssh/framework'), '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10', 'root@' + target.host, node + ' -',
  ], { input: source, encoding: 'utf8', timeout: action === 'verify-callback-guards' ? 150_000 : 60_000, maxBuffer: 128 * 1024 });
  if (child.error || child.status !== 0) {
    const reason = child.stderr?.match(/ISOLATION_CHECK_FAILED|SEEDED_SUPERADMIN_MISSING|PREVIEW_DATABASE_OPERATION_FAILED/)?.[0];
    throw new Error(reason ?? 'Preview SSH/runtime failed; no credentials printed. Check preview availability.');
  }
  return JSON.parse(child.stdout);
}

async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
    throw new Error('Secret file must be a regular file owned by you with mode 0600');
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--tasks-credentials') {
    // Read only the documented tasks-preview env file. Never inspect /proc or
    // print the token; exclusive creation prevents replacing an existing secret.
    const source = `
const fs = require('node:fs');
const dotenv = require('/var/lib/opencouncil-tasks-previews/pr-121/app/node_modules/dotenv');
try {
 const config = dotenv.parse(fs.readFileSync('/var/lib/opencouncil-tasks-previews/.env'));
 const tokens = JSON.parse(config.API_TOKENS);
 if (!Array.isArray(tokens) || typeof tokens[0] !== 'string' || !tokens[0]) throw Error();
 process.stdout.write(JSON.stringify({tasksToken:tokens[0]}));
} catch { console.error('PREVIEW_TOKEN_READ_FAILED'); process.exitCode=1; }
`;
    const child = spawnSync('ssh', ['-i', resolve(homedir(), '.ssh/framework'), '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10', 'root@' + target.host, node + ' -'],
      { input: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 });
    if (child.error || child.status !== 0) throw new Error('Preview token read failed; no credentials printed');
    const credentials = JSON.parse(child.stdout);
    if (typeof credentials.tasksToken !== 'string' || !credentials.tasksToken) throw new Error('Preview token missing');
    const file = await open(resolve(args[1]), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(credentials) + '\n'); }
    finally { await file.close(); }
    console.log(JSON.stringify({ credentialsFile: resolve(args[1]), status: 'ready' }));
    return;
  }
  if (args[0] === '--verify-callback-guards' && args[1] && !args[1].startsWith('--')) {
    const reportFiles = [];
    for (let i = 2; i < args.length; i += 2) {
      if (args[i] !== '--task-report' || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --task-report <passed preview report>');
      reportFiles.push(args[i + 1]);
    }
    const cases = [];
    const inputs = reportFiles.length ? reportFiles : guardCases.map(test => '/tmp/media-preview-' + test.name + '.json');
    for (const [index, input] of inputs.entries()) {
      const report = JSON.parse(await readFile(input, 'utf8'));
      const accepted = report.checks?.filter(check => check.name === 'mcp.start_task.accepted');
      const terminal = report.checks?.find(check => check.name === 'pipeline.callback' && check.status === 'passed')?.details;
      const before = new Date(report.startedAt), after = new Date(report.finishedAt);
      if (report.status !== 'passed' || accepted?.length !== 1 ||
          new URL(report.tasksUrl).origin !== 'https://pr-121.tasks.opencouncil.dev' ||
          new URL(report.appUrl).origin !== 'https://pr-952.opencouncil.dev' ||
          accepted[0].details?.cityId !== 'athens' || accepted[0].details?.type !== 'transcribe' ||
          !/^[a-z]{3}\d{1,2}_\d{4}(?:_[0-9]+)?$/.test(accepted[0].details?.meetingId ?? '') ||
          terminal?.taskId !== accepted[0].details?.taskId || !['succeeded', 'failed'].includes(terminal?.status) ||
          !Number.isFinite(+before) || !Number.isFinite(+after) || +after <= +before || +after - +before > 24 * 3600_000 ||
          (terminal.status === 'failed' && reportFiles.length && typeof terminal.mediaFailure?.retryable !== 'boolean'))
        throw new Error('Require a passed paired-preview report with one exact accepted test task');
      const test = reportFiles.length ? {
        name: 'report-' + (index + 1), id: accepted[0].details.taskId, meetingId: accepted[0].details.meetingId,
        status: terminal.status, retryable: terminal.mediaFailure?.retryable, notBefore: before.toISOString(), notAfter: after.toISOString(),
        expectMp3: terminal.uploadedRecording?.format === 'mp3',
      } : guardCases[index];
      if (accepted[0].details.taskId !== test.id || accepted[0].details.meetingId !== test.meetingId || terminal.status !== test.status)
        throw new Error('Task report does not match the designated test case');
      cases.push(test);
    }
    const path = resolve(args[1]);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ status: 'pending', target }) + '\n');
      await file.sync();
      const report = remote('verify-callback-guards', { cases });
      await file.truncate(0);
      await file.write(JSON.stringify(report, null, 2) + '\n', 0, 'utf8');
      await file.sync();
      console.log(JSON.stringify({ reportFile: path, status: report.status,
        tasks: report.tasks.map(task => ({ id: task.id, version: task.version, status: task.status,
          metadata: task.metadata, checks: task.checks })), ...(report.error ? { error: report.error } : {}) }));
      if (report.status !== 'passed') process.exitCode = 1;
    } finally { await file.close(); }
    return;
  }
  if (args.length === 4 && args[0] === '--merge-credentials' && args[2] === '--from') {
    const source = await privateFile(resolve(args[3]));
    if (source.status !== 'ready' || JSON.stringify(source.target) !== JSON.stringify(target) ||
        !/^mcp_[A-Za-z0-9_-]{43}$/.test(source.mcpToken)) throw new Error('Source must be a ready PR952 token file');
    const path = resolve(args[1]);
    const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid())
        throw new Error('Credentials file must be owned by you with mode 0600');
      const credentials = JSON.parse(await file.readFile('utf8'));
      if (typeof credentials.tasksToken !== 'string' || !credentials.tasksToken)
        throw new Error('Credentials file must contain tasksToken');
      if (credentials.mcpToken && credentials.mcpToken !== source.mcpToken)
        throw new Error('Refusing to replace a different MCP token');
      credentials.mcpToken = source.mcpToken;
      await file.truncate(0);
      await file.write(JSON.stringify(credentials, null, 2) + '\n', 0, 'utf8');
      await file.sync();
      console.log(JSON.stringify({ credentialsFile: path, status: 'merged', mode: '0600' }));
    } finally { await file.close(); }
    return;
  }
  if (args.length === 1 && args[0] === '--help') {
    console.log('PR952/PR121 only. --check | --tasks-credentials <NEW private JSON path> | --output <NEW private JSON path> | --revoke <private JSON path> | --merge-credentials <tasks JSON> --from <token JSON> | --verify-callback-guards <NEW report JSON path> [--task-report <passed preview report>]...');
    return;
  }
  if (args.length === 1 && args[0] === '--check') {
    console.log(JSON.stringify(remote('check'), null, 2));
    return;
  }
  if (args.length !== 2 || !['--output', '--revoke'].includes(args[0]) || !args[1] || args[1].startsWith('--')) {
    throw new Error('Use --check, --output <NEW private JSON path>, or --revoke <private JSON path>');
  }
  const path = resolve(args[1]);
  if (args[0] === '--revoke') {
    const secret = await privateFile(path);
    if (JSON.stringify(secret.target) !== JSON.stringify(target) ||
        !/^mcp_[A-Za-z0-9_-]{43}$/.test(secret.mcpToken) ||
        !/^media-preview-bootstrap:[0-9a-f-]{36}$/.test(secret.name)) {
      throw new Error('File is not a token issued by this PR952 bootstrap');
    }
    const result = remote('revoke', {
      hashedKey: createHash('sha256').update(secret.mcpToken).digest('hex'), name: secret.name,
    });
    console.log(JSON.stringify({ ...result, secretFile: path, status: 'revoked' }, null, 2));
    return;
  }
  const secret = {
    target, name: 'media-preview-bootstrap:' + randomUUID(),
    mcpToken: 'mcp_' + randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(), status: 'pending',
  };
  // Never overwrite an existing credential file (including tasksToken files).
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(secret, null, 2) + '\n');
    await file.sync();
    const result = remote('create', {
      name: secret.name, hashedKey: createHash('sha256').update(secret.mcpToken).digest('hex'),
      keyPrefix: secret.mcpToken.slice(0, 10),
    });
    Object.assign(secret, result, { status: 'ready' });
    await file.truncate(0);
    await file.write(JSON.stringify(secret, null, 2) + '\n', 0, 'utf8');
    await file.sync();
    console.log(JSON.stringify({ ...result, secretFile: path, status: 'ready' }, null, 2));
  } finally {
    await file.close();
  }
}

main().catch(error => {
  console.error(error.code === 'EEXIST' ? 'Refusing to overwrite existing secret file' : error instanceof SyntaxError ? 'Invalid JSON input; content omitted' : error.message);
  process.exitCode = 1;
});
