#!/usr/bin/env npx tsx
/**
 * Builds the request opencouncil would send a task, from opencouncil's public
 * data, for `npm run cli -- eval task run <task> --request <file>`. No
 * callbackUrl: the CLI runner does not need one.
 *
 * Usage:
 *   npx tsx scripts/build-task-request.ts <task> <cityId/meetingId> [--base-url https://opencouncil.gr] [--out file.json]
 *   task: fixTranscript | summarize | processAgenda | pollDecisions
 *
 * The fields public data cannot give, and what is sent instead, are listed in
 * src/evals/requests/buildRequests.ts. Keep requests under .eval-requests/ (git-ignored).
 */
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import {
    buildFixTranscriptRequest, buildPollDecisionsRequest, buildProcessAgendaRequest, buildSummarizeRequest,
    type ConventionsGlossary, type PublicMeetingPayload, type PublicTopic,
} from '../src/evals/requests/buildRequests.js';

// The conventions glossary the app renders pollDecisions' conventionsText from.
const GLOSSARY_URL = 'https://raw.githubusercontent.com/schemalabz/opencouncil/main/messages/en/admin.json';
const TASKS = ['fixTranscript', 'summarize', 'processAgenda', 'pollDecisions'] as const;
type Task = typeof TASKS[number];

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return await response.json() as T;
}

async function buildRequest(task: Task, data: PublicMeetingPayload, baseUrl: string): Promise<object> {
    if (task === 'pollDecisions') return buildPollDecisionsRequest(data, await getJson<ConventionsGlossary>(GLOSSARY_URL));
    const topics = await getJson<PublicTopic[]>(`${baseUrl}/api/topics`);
    if (task === 'fixTranscript') return buildFixTranscriptRequest(data, topics);
    if (task === 'summarize') return buildSummarizeRequest(data, topics);
    return buildProcessAgendaRequest(data, topics);
}

/** Counts only: the request holds meeting text and names, which stay out of the terminal. */
function describeRequest(task: Task, request: Record<string, any>): string {
    const parts: string[] = [];
    if (Array.isArray(request.transcript)) {
        const segments = request.transcript as { text: string; utterances: unknown[] }[];
        parts.push(`${segments.length} segments`, `${segments.reduce((n, s) => n + s.utterances.length, 0)} utterances`, `${segments.reduce((n, s) => n + s.text.length, 0)} chars`);
    }
    if (Array.isArray(request.existingSubjects)) parts.push(`${request.existingSubjects.length} existing subjects`);
    if (Array.isArray(request.subjects)) {
        parts.push(`${request.subjects.length} subjects (${request.subjects.filter((s: { existingDecision?: unknown }) => s.existingDecision).length} with a linked decision)`);
    }
    if (Array.isArray(request.people)) parts.push(`${request.people.length} people`);
    if (Array.isArray(request.topicLabels)) parts.push(`${request.topicLabels.length} topic labels`);
    if (task === 'pollDecisions') parts.push(`extract=${request.extract}`, `conventionsText ${request.conventionsText ? `${request.conventionsText.length} chars` : 'none'}`, `${request.diavgeiaUnitIds?.length ?? 0} unit scopes`);
    return `${task}: ${parts.join(', ')}`;
}

const program = new Command()
    .argument('<task>', TASKS.join(' | '))
    .argument('<meeting>', 'cityId/meetingId')
    .option('--base-url <url>', 'opencouncil instance', 'https://opencouncil.gr')
    .option('--out <file>', 'write the request here instead of stdout')
    .action(async (task: string, meeting: string, opts: { baseUrl: string; out?: string }) => {
        if (!(TASKS as readonly string[]).includes(task)) throw new Error(`Unknown task "${task}" (expected ${TASKS.join(', ')})`);
        const match = meeting.match(/^([^/]+)\/([^/]+)$/);
        if (!match) throw new Error(`Expected cityId/meetingId, got "${meeting}"`);
        const baseUrl = opts.baseUrl.replace(/\/$/, '');
        const data = await getJson<PublicMeetingPayload>(`${baseUrl}/api/cities/${encodeURIComponent(match[1])}/meetings/${encodeURIComponent(match[2])}`);
        const request = await buildRequest(task as Task, data, baseUrl);
        const json = JSON.stringify(request, null, 2);
        if (opts.out) {
            fs.mkdirSync(path.dirname(opts.out), { recursive: true });
            fs.writeFileSync(opts.out, json);
        } else {
            process.stdout.write(json + '\n');
        }
        console.error(describeRequest(task as Task, request as Record<string, any>));
    });

program.parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
