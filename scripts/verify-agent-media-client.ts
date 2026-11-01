/** App-side half of verify-media-sources --app-root. Runs with the app's tsconfig aliases.
 * Uses real HTTP for inspection and real app status projection; no database or paid tasks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const [appRoot, base, payloadFile] = process.argv.slice(2);
assert(appRoot && base && payloadFile, 'app root, local fixture URL, and callback payload required');
assert.deepEqual(
    JSON.parse(readFileSync(path.join(appRoot, 'tests/fixtures/media-contract.json'), 'utf8')),
    JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/media-contract.json', import.meta.url)), 'utf8')),
    'paired repositories disagree about the media callback contract',
);
const { inspectMedia } = await import(pathToFileURL(path.join(appRoot, 'src/lib/tasks/inspectMedia.ts')).href);
const { mcpTaskSummary } = await import(pathToFileURL(path.join(appRoot, 'src/lib/mcp/taskSummary.ts')).href);
const resolved = await inspectMedia({ url: base + '/fixture.mp4' });
assert.equal(resolved.supported, true);
assert.equal(resolved.source.kind, 'file');
const refused = await inspectMedia({ url: base + '/empty' });
assert.equal(refused.supported, false);
assert.equal(refused.reason, 'unsupported');
assert.equal(refused.retryable, false);
await assert.rejects(inspectMedia({ url: 'file:///etc/passwd' }));

const { failure, source } = JSON.parse(readFileSync(payloadFile, 'utf8'));
const row = {
    id: 'bridge-task', type: 'transcribe', stage: 'finished', percentComplete: 100,
    createdAt: new Date(), updatedAt: new Date(), version: failure.version,
};
const failed = mcpTaskSummary({ ...row, status: 'failed', error: failure.error, mediaFailure: failure.mediaFailure, mediaSource: null });
assert.deepEqual(failed.mediaFailure, failure.mediaFailure);
assert.equal(failed.error, failure.error);
const succeeded = mcpTaskSummary({ ...row, status: 'succeeded', error: null, mediaFailure: null, mediaSource: source });
assert.deepEqual(succeeded.source, source);
const legacy = mcpTaskSummary({ ...row, status: 'failed', error: 'older failure' });
assert.equal(legacy.mediaFailure, undefined);
console.log(JSON.stringify({ inspection: resolved.source.kind, refusal: refused.reason, mediaFailure: failed.mediaFailure, source: succeeded.source, legacy: true }));
