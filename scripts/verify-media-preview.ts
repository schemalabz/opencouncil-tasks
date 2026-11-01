/** Deployed media verification. No task writes without explicit flags. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { InspectMediaResponse } from '../src/types.js';

type Json = Record<string, any>;
type Check = { name: string; status: 'passed' | 'failed' | 'skipped'; elapsedMs: number; details?: unknown; error?: string };
type Case = { name: string; url: string; supported?: boolean; reason?: string; kind?: string };
// Explicit opt-in for operator-approved credentials; never discover/read service env files.
const credentialsAt = process.argv.indexOf('--credentials-file');
if (credentialsAt >= 0) {
    const file = process.argv[credentialsAt + 1];
    if (!file || (statSync(file).mode & 0o077)) throw new Error('Credentials file must be private (chmod 600)');
    let credentials: Record<string, unknown>;
    try { credentials = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('Invalid credentials JSON; content omitted'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Invalid credentials object');
    if (typeof credentials.tasksToken === 'string') process.env.PREVIEW_TASK_TOKEN = credentials.tasksToken;
    if (typeof credentials.mcpToken === 'string') process.env.PREVIEW_MCP_TOKEN = credentials.mcpToken;
    process.argv.splice(credentialsAt, 2);
}
const secrets = ['PREVIEW_TASK_TOKEN', 'PREVIEW_MCP_TOKEN', 'PREVIEW_APP_COOKIE'].map(k => process.env[k]).filter((s): s is string => !!s);
function safe(value: unknown): string {
    let text = JSON.stringify(value);
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    // Do not retain URL credentials, signed queries, embedded MCP tokens or response bodies.
    return text.replace(/https?:\/\/[^\s"<>\\]+/g, raw => {
        try { const u = new URL(raw); return u.origin + u.pathname.replace(/mcp_[A-Za-z0-9_-]+/g, '[REDACTED]'); }
        catch { return '[URL]'; }
    });
}
function requireThat(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
function previewUrl(raw: string | undefined, tasks: boolean): string {
    requireThat(raw, tasks ? '--tasks-url required' : '--app-url required');
    const url = new URL(raw);
    const pattern = tasks ? /^pr-\d+\.tasks\.opencouncil\.dev$/ : /^pr-\d+\.opencouncil\.dev$/;
    requireThat(url.protocol === 'https:' && pattern.test(url.hostname) && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Only HTTPS PR preview origins are allowed');
    return url.origin;
}
async function http(url: string, body: unknown, headers: Record<string, string>, timeout: number) {
    const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
    });
    return response;
}
async function rpcBody(response: Response, id: number, allowError = false): Promise<Json> {
    const text = await response.text();
    let messages: Json[];
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
        messages = text.split(/\r?\n\r?\n/).flatMap(event => {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            return data ? [JSON.parse(data)] : [];
        });
    } else messages = [JSON.parse(text)];
    const message = messages.find(m => m.id === id);
    if (allowError && message?.error) return { rpcError: true };
    requireThat(message && !message.error && message.result, `MCP response missing result or JSON-RPC error (request ${id})`);
    return message.result;
}
class Mcp {
    id = 0;
    session?: string;
    protocol = '2025-03-26';
    constructor(readonly url: string, readonly headers: Record<string, string>, readonly timeout: number) {}
    async send(method: string, params: unknown, allowError = false): Promise<Json> {
        const id = ++this.id;
        const response = await http(this.url, { jsonrpc: '2.0', id, method, params }, {
            ...this.headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': this.protocol,
            ...(this.session && { 'mcp-session-id': this.session }),
        }, this.timeout);
        requireThat(response.ok, `MCP ${method} HTTP ${response.status}`);
        this.session = response.headers.get('mcp-session-id') ?? this.session;
        return rpcBody(response, id, allowError);
    }
    async initialize() {
        const result = await this.send('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: 'media-preview-verifier', version: '1' } });
        requireThat(typeof result.protocolVersion === 'string', 'MCP initialize missing protocolVersion');
        this.protocol = result.protocolVersion;
        const response = await http(this.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, {
            ...this.headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': this.protocol,
            ...(this.session && { 'mcp-session-id': this.session }),
        }, this.timeout);
        requireThat(response.ok, `MCP initialized notification HTTP ${response.status}`);
        await response.body?.cancel();
        return { protocolVersion: this.protocol, serverInfo: result.serverInfo };
    }
    async list() {
        const tools: Json[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await this.send('tools/list', cursor ? { cursor } : {});
            requireThat(Array.isArray(page.tools), 'MCP tools/list missing tools');
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor) { requireThat(!seen.has(cursor) && seen.size < 100, 'MCP pagination loop'); seen.add(cursor); }
        } while (cursor);
        return tools;
    }
    async call(name: string, args: Json): Promise<Json> {
        const result = await this.send('tools/call', { name, arguments: args });
        requireThat(!result.isError, `MCP ${name} returned a tool error`);
        if (result.structuredContent) return result.structuredContent;
        const content = result.content?.find((c: Json) => c.type === 'text');
        requireThat(content, `MCP ${name} missing text/structuredContent`);
        return JSON.parse(content.text);
    }
}
function inspection(value: Json): InspectMediaResponse {
    requireThat(typeof value.supported === 'boolean', 'Missing supported boolean');
    if (value.supported) {
        requireThat(['spaces', 'file', 'yt-dlp'].includes(value.source?.kind), 'Invalid source kind');
        const duration = value.source.durationSeconds;
        requireThat(duration === undefined || (Number.isFinite(duration) && duration >= 0), 'Invalid source duration');
    } else {
        requireThat(['unsupported', 'playlist', 'embed_only', 'login_required', 'drm', 'unavailable', 'not_found', 'error'].includes(value.reason)
            && typeof value.retryable === 'boolean' && typeof value.message === 'string', 'Invalid refusal contract');
    }
    return value as InspectMediaResponse;
}
function summary(value: Json) {
    return value.supported ? { supported: true, kind: value.source.kind, extractor: value.source.extractor, id: value.source.id, durationSeconds: value.source.durationSeconds }
        : { supported: false, reason: value.reason, retryable: value.retryable, message: value.message, hint: value.hint };
}
function boundedFixture(value: InspectMediaResponse, maxDuration: number, localDuration?: number) {
    requireThat(value.supported, 'Fixture must be supported');
    const remoteDuration = value.source.durationSeconds;
    // A verified local copy can fill absent metadata, never override a known long duration.
    const duration = remoteDuration ?? localDuration;
    requireThat(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= maxDuration, 'Fixture must resolve with a known positive duration within --max-duration');
}
function localFixture(file: string, maxDuration: number) {
    const stat = statSync(file);
    requireThat(stat.isFile() && stat.size > 0 && stat.size <= 32 * 1024 * 1024, 'Fixture must be a nonempty local file at most 32 MiB');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    requireThat(!probe.error && probe.status === 0, 'Local fixture ffprobe failed');
    const durationSeconds = Number(JSON.parse(probe.stdout).format?.duration);
    boundedFixture({ supported: true, source: { kind: 'file' } } as InspectMediaResponse, maxDuration, durationSeconds);
    const bytes = readFileSync(file);
    requireThat(bytes.length === stat.size, 'Fixture size changed while reading');
    return { bytes, durationSeconds };
}
async function matchFixture(url: string, bytes: Buffer, timeout: number) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
    requireThat(response.ok, `Fixture fetch HTTP ${response.status}`);
    requireThat(response.body, 'Fixture fetch missing body');
    const reader = response.body.getReader();
    let offset = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            requireThat(offset + value.length <= bytes.length && bytes.subarray(offset, offset + value.length).equals(value), 'Remote fixture bytes differ from local fixture');
            offset += value.length;
        }
        requireThat(offset === bytes.length, 'Remote fixture bytes differ from local fixture');
    } finally { await reader.cancel(); }
}
const help = `Usage: nix develop --command npx tsx scripts/verify-media-preview.ts
  --tasks-url https://pr-121.tasks.opencouncil.dev --app-url https://pr-N.opencouncil.dev
  [--credentials-file private.json] [--matrix cases.json] [--only comma,separated,names] [--output report.json]
  [--test-meeting cityId/meetingId | --create-test-meeting cityId]
  [--run-failure-task | --run-pipeline]
  [--video-url https://... [--fixture-file local.mp4] | --upload-fixture local.mp4]
  [--timeout-ms 180000] [--poll-ms 5000] [--wait-ms 900000] [--max-duration 60]
  [--self-test] [--help]
Environment: PREVIEW_TASK_TOKEN, PREVIEW_MCP_TOKEN (personal mcp_ admin token),
  PREVIEW_APP_COOKIE (optional Cookie header; not an MCP identity).
Default matrix reuses scripts/fixtures/media-sources.json; download flags are ignored.
Creation/upload flags explicitly opt into preview writes. Tasks require a disposable test meeting.
No force, release, callback simulation, or automatic retries of create_meeting/start_task.
`;

async function main() {
    const { values: v } = parseArgs({ options: {
        'tasks-url': { type: 'string' }, 'app-url': { type: 'string' }, matrix: { type: 'string' }, only: { type: 'string' }, output: { type: 'string' },
        'test-meeting': { type: 'string' }, 'create-test-meeting': { type: 'string' }, 'upload-fixture': { type: 'string' }, 'fixture-file': { type: 'string' }, 'fixture-media-url': { type: 'string' }, 'failure-url': { type: 'string' }, 'expected-failure-reason': { type: 'string' }, 'expect-retryable': { type: 'boolean' }, 'run-failure-task': { type: 'boolean' }, 'run-pipeline': { type: 'boolean' }, 'video-url': { type: 'string' },
        'timeout-ms': { type: 'string', default: '180000' }, 'poll-ms': { type: 'string', default: '5000' }, 'wait-ms': { type: 'string', default: '900000' },
        'max-duration': { type: 'string', default: '60' }, 'self-test': { type: 'boolean' }, help: { type: 'boolean' },
    }, strict: true });
    if (v.help) { console.log(help); return; }
    if (v['self-test']) { await selfTest(v['fixture-file']); return; }
    const tasksUrl = previewUrl(v['tasks-url'], true), appUrl = previewUrl(v['app-url'], false);
    const timeout = Number(v['timeout-ms']), poll = Number(v['poll-ms']), wait = Number(v['wait-ms']), maxDuration = Number(v['max-duration']);
    for (const number of [timeout, poll, wait, maxDuration]) requireThat(Number.isFinite(number) && number > 0, 'Timeouts and duration must be positive numbers');
    requireThat(maxDuration <= 120, '--max-duration cannot exceed 120 seconds');
    const taskToken = process.env.PREVIEW_TASK_TOKEN, mcpToken = process.env.PREVIEW_MCP_TOKEN;
    requireThat(taskToken && mcpToken?.startsWith('mcp_'), 'Set PREVIEW_TASK_TOKEN and PREVIEW_MCP_TOKEN in environment');
    requireThat(!(v['run-failure-task'] && v['run-pipeline']), 'Choose one task mode per run and use a fresh test meeting');
    const writing = !!(v['run-failure-task'] || v['run-pipeline']);
    const meetingParts = v['test-meeting']?.split('/');
    requireThat(!meetingParts || (meetingParts.length === 2 && meetingParts.every(Boolean)), '--test-meeting must be cityId/meetingId');
    requireThat(!(v['test-meeting'] && v['create-test-meeting']), '--test-meeting and --create-test-meeting are mutually exclusive');
    requireThat(!v['create-test-meeting'] || /^[a-zA-Z0-9_-]+$/.test(v['create-test-meeting']), '--create-test-meeting must be a cityId');
    requireThat(!writing || meetingParts || v['create-test-meeting'], 'Task mode requires --test-meeting or --create-test-meeting');
    requireThat(!v['run-pipeline'] || v['video-url'] || v['upload-fixture'], '--run-pipeline requires --video-url or --upload-fixture');
    requireThat(!v['upload-fixture'] || (v['run-pipeline'] && !v['video-url'] && !v['fixture-file']), '--upload-fixture requires --run-pipeline and is exclusive with --video-url/--fixture-file');
    requireThat(!v['fixture-file'] || (v['run-pipeline'] && v['video-url']), '--fixture-file requires --run-pipeline and --video-url');
    const fixturePath = v['upload-fixture'] ?? v['fixture-file'];
    const fixture = fixturePath ? localFixture(fixturePath, maxDuration) : undefined;
    const matrix: Case[] = JSON.parse(readFileSync(v.matrix ?? new URL('./fixtures/media-sources.json', import.meta.url), 'utf8'));
    requireThat(Array.isArray(matrix) && matrix.every(c => typeof c.name === 'string' && typeof c.url === 'string'), 'Matrix must be an array of {name,url}');
    const selected = v.only?.split(',');
    requireThat(!selected || selected.every(name => matrix.some(c => c.name === name)), '--only contains an unknown case');
    const checks: Check[] = [];
    // Persist accepted write IDs before further calls, including on timeout/interruption.
    function accepted(name: string, details: Json) {
        checks.push({ name, status: 'passed', elapsedMs: 0, details });
        const progress = { status: 'in-progress', checks };
        if (v.output) writeFileSync(v.output, safe(progress) + '\n', { mode: 0o600 });
        console.error(safe({ event: name, ...details, instruction: 'If interrupted, inspect this record; do not submit again blindly' }));
    }
    async function check<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
        const start = Date.now();
        try { const details = await fn(); checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, details }); return details; }
        catch (error) { checks.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : 'Unknown error' }); return undefined; }
    }
    const taskHeaders = { authorization: `Bearer ${taskToken}` };
    const appHeaders = { authorization: `Bearer ${mcpToken}`, ...(process.env.PREVIEW_APP_COOKIE && { cookie: process.env.PREVIEW_APP_COOKIE }) };
    const mcp = new Mcp(appUrl + '/api/mcp', appHeaders, timeout);
    async function direct(body: unknown, headers = taskHeaders) {
        const response = await http(tasksUrl + '/inspectMedia', body, headers, timeout);
        requireThat(response.status === 200, `inspectMedia HTTP ${response.status}`);
        return inspection(await response.json() as Json);
    }
    const startedAt = new Date().toISOString();
    await check('tasks.health.auth', async () => {
        const response = await http(tasksUrl + '/health', undefined, taskHeaders, timeout);
        requireThat(response.ok, `health HTTP ${response.status}`);
        const health = await response.json() as Json;
        requireThat(health.authenticated === true, 'Task token rejected');
        return { version: health.version, services: health.services };
    });
    for (const [name, headers, status] of [['missing', {}, 401], ['invalid', { authorization: 'Bearer preview-verifier-invalid' }, 403]] as const) {
        await check(`tasks.auth.${name}`, async () => {
            const response = await http(tasksUrl + '/inspectMedia', {}, headers, timeout);
            await response.body?.cancel();
            requireThat(response.status === status, `Expected ${status}; got ${response.status}`); return { httpStatus: response.status };
        });
    }
    for (const [name, body] of [['missing', {}], ['protocol', { url: 'file:///etc/passwd' }]] as const) {
        await check(`tasks.invalid.${name}`, async () => {
            const response = await http(tasksUrl + '/inspectMedia', body, taskHeaders, timeout);
            await response.body?.cancel();
            requireThat(response.status === 400, `Expected 400; got ${response.status}`); return { httpStatus: response.status };
        });
    }
    await check('mcp.auth.invalid', async () => {
        const response = await http(appUrl + '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'auth-probe', version: '1' } } }, { ...appHeaders, authorization: 'Bearer mcp_preview_verifier_invalid', accept: 'application/json, text/event-stream' }, timeout);
        await response.body?.cancel(); requireThat([401, 403].includes(response.status), `Expected 401/403; got ${response.status}`); return { httpStatus: response.status };
    });
    const initialized = await check('mcp.initialize', () => mcp.initialize());
    const tools = initialized ? await check('mcp.tools.list', async () => {
        const tools = await mcp.list();
        for (const name of ['inspect_media', 'start_task', 'get_meeting']) requireThat(tools.some(t => t.name === name), `Missing ${name}: MCP token needs preview admin access`);
        for (const name of [v['create-test-meeting'] && 'create_meeting', v['upload-fixture'] && 'create_upload_url'].filter(Boolean)) requireThat(tools.some(t => t.name === name), `Missing ${name}: deploy latest app preview first`);
        return tools.map(t => t.name as string);
    }) : undefined;
    if (tools) {
        await check('mcp.invalid.protocol', async () => {
            const result = await mcp.send('tools/call', { name: 'inspect_media', arguments: { url: 'file:///etc/passwd' } }, true);
            requireThat(result.isError === true || result.rpcError === true, 'MCP must reject invalid URL'); return { rejected: true };
        });
    }
    for (const c of matrix.filter(c => !selected || selected.includes(c.name))) {
        let directValue: InspectMediaResponse | undefined;
        await check(`inspect.tasks.${c.name}`, async () => {
            directValue = await direct({ url: c.url });
            requireThat(c.supported === undefined || directValue.supported === c.supported, 'Unexpected supported result');
            requireThat(!c.reason || (!directValue.supported && directValue.reason === c.reason), 'Unexpected refusal reason');
            requireThat(!c.kind || (directValue.supported && directValue.source.kind === c.kind), 'Unexpected source kind');
            return summary(directValue);
        });
        if (tools) await check(`inspect.mcp.${c.name}`, async () => {
            const value = inspection(await mcp.call('inspect_media', { url: c.url }));
            requireThat(directValue, 'Direct inspection failed; parity unknown');
            requireThat(value.supported === directValue.supported, 'Paired supported values differ');
            if (value.supported && directValue.supported) requireThat(value.source.kind === directValue.source.kind, 'Paired source kinds differ');
            if (!value.supported && !directValue.supported) requireThat(value.reason === directValue.reason && value.retryable === directValue.retryable, 'Paired refusals differ');
            return summary(value);
        });
    }
    let meetingArgs = meetingParts ? { cityId: meetingParts[0], meetingId: meetingParts[1] } : undefined;
    if (v['create-test-meeting']) await check('mcp.create_meeting', async () => {
        requireThat(tools && checks.every(c => c.status !== 'failed'), 'Preflight checks failed: no meeting created');
        const cityId = v['create-test-meeting']!;
        const row = await mcp.call('create_meeting', { cityId, dateTime: new Date().toISOString(), processAgenda: false });
        requireThat(typeof row.id === 'string' && row.id.length > 0, 'create_meeting missing id; do not retry blindly');
        meetingArgs = { cityId, meetingId: row.id };
        accepted('mcp.create_meeting.accepted', { ...meetingArgs, released: row.released });
        requireThat(row.cityId === cityId && row.released === false, 'Created meeting is not the expected unreleased draft');
        return { ...meetingArgs, released: row.released };
    });
    const meeting = tools && meetingArgs ? await check('mcp.get_meeting', async () => {
        const row = await mcp.call('get_meeting', meetingArgs!);
        requireThat(Array.isArray(row.tasks), 'Admin tasks not visible');
        return { id: row.id, hasTranscript: row.hasTranscript, tasks: row.tasks, notifications: row.notifications };
    }) : undefined;
    if (writing) {
        await check('pipeline.callback', async () => {
            requireThat(meeting && !meeting.hasTranscript && meeting.tasks.length === 0, 'Use a fresh disposable test meeting with no transcript or previous tasks');
            requireThat(checks.every(c => c.status !== 'failed'), 'Preflight checks failed: no task submitted');
            let videoUrl = v['run-failure-task'] ? (v['failure-url'] ?? 'https://www.youtube.com/watch?v=bad') : v['video-url']!;
            if (v['run-pipeline']) {
                if (v['upload-fixture']) {
                    requireThat(fixture && meetingArgs, 'Upload requires a verified local fixture and test meeting');
                    const identifier = `media-preview-${randomUUID().slice(0, 12)}`;
                    const plan = await mcp.call('create_upload_url', { cityId: meetingArgs.cityId, kind: 'recording', identifier, format: 'mp4', sizeBytes: fixture.bytes.length });
                    requireThat(plan.method === 'PUT' && plan.completion === null && plan.parts?.length === 1 && plan.parts[0].partNumber === 1 && typeof plan.parts[0].uploadUrl === 'string' && typeof plan.publicUrl === 'string' && plan.headers && Object.values(plan.headers).every(h => typeof h === 'string'), 'Expected a single-part PUT upload plan');
                    requireThat(new URL(plan.parts[0].uploadUrl).protocol === 'https:' && new URL(plan.publicUrl).protocol === 'https:', 'Upload plan must use HTTPS');
                    // Never put signed URLs, storage keys, completion tokens or headers in checks/errors.
                    const response = await fetch(plan.parts[0].uploadUrl, { method: 'PUT', headers: plan.headers, body: new Uint8Array(fixture.bytes), redirect: 'error', signal: AbortSignal.timeout(timeout) });
                    await response.body?.cancel();
                    requireThat(response.ok, `Fixture upload HTTP ${response.status}`);
                    videoUrl = plan.publicUrl;
                    accepted('mcp.upload_fixture.accepted', { sizeBytes: fixture.bytes.length, durationSeconds: fixture.durationSeconds });
                }
                if (fixture) {
                    await matchFixture(v['fixture-media-url'] ?? videoUrl, fixture.bytes, timeout);
                    checks.push({ name: 'fixture.local-verified', status: 'passed', elapsedMs: 0, details: { durationSeconds: fixture.durationSeconds, sizeBytes: fixture.bytes.length, remoteBytesMatch: true } });
                }
                const metadata = await direct({ url: videoUrl });
                boundedFixture(metadata, maxDuration, fixture?.durationSeconds);
            }
            const task = await mcp.call('start_task', { ...meetingArgs, type: 'transcribe', videoUrl, force: false });
            requireThat(typeof task.id === 'string' && task.id.length > 0, 'start_task missing id; do not retry blindly');
            // Save the accepted id immediately: timeout/interruption must not invite duplicate starts.
            accepted('mcp.start_task.accepted', { ...meetingArgs, taskId: task.id, type: task.type });
            const deadline = Date.now() + wait;
            while (Date.now() < deadline) {
                const row = await mcp.call('get_meeting', meetingArgs!);
                const current = row.tasks?.find((t: Json) => t.id === task.id);
                if (current && ['succeeded', 'failed'].includes(current.status)) {
                    requireThat(current.status === (v['run-failure-task'] ? 'failed' : 'succeeded'), `Unexpected terminal status ${current.status}`);
                    if (v['run-failure-task']) {
                        const failure = current.mediaFailure;
                        const expectedReason = v['expected-failure-reason'] ?? (v['failure-url'] ? 'error' : 'unsupported');
                        requireThat(failure && ['unsupported', 'playlist', 'embed_only', 'login_required', 'drm', 'unavailable', 'not_found', 'error'].includes(failure.reason) && failure.reason === expectedReason && typeof failure.retryable === 'boolean' && failure.retryable === Boolean(v['expect-retryable']) && (failure.hint === undefined || typeof failure.hint === 'string'), 'Failure callback missing expected mediaFailure reason/retryability');
                    }
                    else requireThat(current.source && ['spaces', 'file', 'yt-dlp'].includes(current.source.kind) && row.hasTranscript === true, 'Success callback missing source or persisted transcript');
                    return { taskId: task.id, status: current.status, source: current.source, mediaFailure: current.mediaFailure, hasTranscript: row.hasTranscript, evidence: 'get_meeting terminal task projection', realMux: 'unverified: missing Mux credentials may produce MOCK IDs', downstreamFixTranscript: 'not awaited' };
                }
                await delay(Math.min(poll, Math.max(1, deadline - Date.now())));
            }
            throw new Error(`Callback deadline exceeded for task ${task.id}; task may still run. Poll get_meeting, do not restart`);
        });
    } else checks.push({ name: 'pipeline.callback', status: 'skipped', elapsedMs: 0, details: 'Requires explicit task flag and disposable test meeting' });
    const failed = checks.filter(c => c.status === 'failed').map(c => c.name);
    const report = { startedAt, finishedAt: new Date().toISOString(), tasksUrl, appUrl, status: failed.length ? 'failed' : 'passed', failureGates: failed, checks,
        unexercised: [...(!v['create-test-meeting'] ? ['meeting creation'] : []), ...(!v['upload-fixture'] ? ['fixture upload'] : []), 'meeting release', 'DRM and mid-download network failures', 'callback payload/version inspection (get_meeting omits version)', 'real Mux hosting (MOCK IDs can complete)', 'fixTranscript completion/summarize/notifications', 'exact app TASK_API_URL pairing requires operator verification', ...(!writing ? ['start_task and persisted callbacks', 'actual short speech success pipeline'] : v['run-failure-task'] ? ['actual short speech success pipeline'] : ['permanent failure callback'])] };
    const output = safe(report);
    if (v.output) writeFileSync(v.output, output + '\n', { mode: 0o600 });
    console.log(output);
    if (failed.length) process.exitCode = 1;
}

async function selfTest(fixtureFile?: string) {
    // Local contract checks only; never calls a deployed endpoint.
    assert.equal(previewUrl('https://pr-121.tasks.opencouncil.dev', true), 'https://pr-121.tasks.opencouncil.dev');
    for (const url of ['https://opencouncil.gr', 'https://pr-1.opencouncil.dev.evil.test', 'http://pr-1.opencouncil.dev', 'https://pr-1.opencouncil.dev/path']) assert.throws(() => previewUrl(url, false));
    assert.equal(inspection({ supported: true, source: { kind: 'file', durationSeconds: 3 } }).supported, true);
    assert.throws(() => inspection({ supported: false, reason: 'oops' }));
    boundedFixture(inspection({ supported: true, source: { kind: 'spaces' } }), 60, 15.4);
    for (const duration of [0, -1, NaN, Infinity, 121]) assert.throws(() => boundedFixture(inspection({ supported: true, source: { kind: 'spaces' } }), 120, duration));
    assert.throws(() => boundedFixture(inspection({ supported: true, source: { kind: 'file' } }), 60));
    assert.throws(() => boundedFixture(inspection({ supported: true, source: { kind: 'file', durationSeconds: 121 } }), 60, 15.4));
    const body = { jsonrpc: '2.0', id: 9, result: { tools: [] } };
    for (const response of [new Response(JSON.stringify(body)), new Response(`event: message\r\ndata: ${JSON.stringify(body)}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } })]) assert.deepEqual(await rpcBody(response, 9), { tools: [] });
    await assert.rejects(rpcBody(new Response(JSON.stringify({ id: 9, error: { code: -1 } })), 9));
    assert(!safe({ url: 'https://user:pass@example.test/a?token=private', token: secrets[0] }).includes('token=private'));
    const originalFetch = globalThis.fetch;
    try {
        for (const bytes of [Buffer.from('speech'), Buffer.from('different'), Buffer.from('speech-extra'), Buffer.from('spee')]) {
            globalThis.fetch = async () => new Response(bytes);
            const check = matchFixture('https://fixture.test/speech.mp4', Buffer.from('speech'), 1000);
            if (bytes.equals(Buffer.from('speech'))) await check;
            else await assert.rejects(check, /Remote fixture bytes differ/);
        }
    } finally { globalThis.fetch = originalFetch; }
    const fixture = fixtureFile ? localFixture(fixtureFile, 120) : undefined;
    console.log(JSON.stringify({ ...(fixture && { fixture: { durationSeconds: fixture.durationSeconds, sizeBytes: fixture.bytes.length } }), selfTest: 'passed', checks: ['preview-only targets', 'inspection contract', 'JSON and SSE transport', 'RPC errors', 'URL redaction', 'bounded local fixture duration fallback', 'remote byte equality and mismatch rejection'] }));
}

main().catch(error => {
    console.log(safe({ status: 'failed', failureGates: ['configuration-or-runtime'], error: error instanceof Error ? error.message : 'Unknown error' }));
    process.exitCode = 1;
});
