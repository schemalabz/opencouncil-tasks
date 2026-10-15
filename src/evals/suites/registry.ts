import { agendaContext, agendaExtraction } from './agenda.js';
import { decisionsExtraction } from './decisionsExtraction.js';
import { decisionsMatching } from './decisionsMatching.js';
import { fixSpeakerId } from './fixSpeakerId.js';
import { decisionsReading } from './decisionsReading.js';
import { fixTranscriptSuite } from './fixTranscript.js';
import { summarizeContext, summarizeContributions, summarizeE2e } from './summarize.js';
import type { Suite } from './suite.js';

export const SUITES: Record<string, Suite<any, any>> = {
    [decisionsReading.id]: decisionsReading,
    [decisionsExtraction.id]: decisionsExtraction,
    [decisionsMatching.id]: decisionsMatching,
    [fixSpeakerId.id]: fixSpeakerId,
    [summarizeContributions.id]: summarizeContributions,
    [summarizeContext.id]: summarizeContext,
    [summarizeE2e.id]: summarizeE2e,
    [agendaExtraction.id]: agendaExtraction,
    [agendaContext.id]: agendaContext,
    [fixTranscriptSuite.id]: fixTranscriptSuite,
};

export function getSuite(id: string): Suite<any, any> {
    const suite = SUITES[id];
    if (!suite) throw new Error(`Unknown suite "${id}" (known: ${Object.keys(SUITES).join(', ')})`);
    return suite;
}
