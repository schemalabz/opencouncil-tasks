import { gatherMeetingCandidates, resolveMeetingDecisions, type WindowRequest } from '../../tasks/pollDecisions.js';
import type { PollDecisionsRequest } from '../../types.js';
import { assignSplit } from '../cases/caseStore.js';
import type { Case, Expected, FieldOutcome, ResultRow } from '../types.js';
import { HUMAN_TIERS } from '../types.js';
import type { Suite } from './suite.js';

/**
 * A matching case is one meeting's decision window: the poll request production sent,
 * with every link hidden. The matching core (phase-0 reading, partition, resolver, gap
 * resolver) has to find the links again.
 *
 * Expectations:
 * - `link[<subjectId>]`: the ΑΔΑ the subject carries, or null for a subject with none.
 * - `reject[<ada>]`: a candidate a person dismissed; `subjectId` is the subject it was
 *   suggested for, null for one placed on no subject. Proposing it there is wrong.
 */
export type MatchingInput = WindowRequest & {
    meeting: string;
    subjects: PollDecisionsRequest['subjects'];
};

export type MatchingOutput = {
    /** subjectId → proposed ΑΔΑ. */
    proposals: Record<string, string>;
    window: { fetched: number; inMeeting: number; fallback: number };
};

export type RejectExpectation = { subjectId: string | null };

const LINK = /^link\[(.+)\]$/;
const REJECT = /^reject\[(.+)\]$/;

/**
 * Per field, the finer verdict: `recovered`, `wrong`, `missed` for a linked subject;
 * `extra` or `none` for an unlinked one; `rejected-proposed` / `rejected-kept-out` for a
 * dismissed candidate. These are the evaluate-decision-matching outcomes, kept so its
 * recall and precision can be read off a run.
 */
export function matchingDetail(output: MatchingOutput, c: Case<MatchingInput>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [field, e] of Object.entries(c.expect)) {
        const link = LINK.exec(field);
        if (link) {
            const truth = e.value as string | null;
            const proposed = output.proposals[link[1]] ?? null;
            out[field] = truth ? (proposed === truth ? 'recovered' : proposed ? 'wrong' : 'missed') : (proposed ? 'extra' : 'none');
            continue;
        }
        const reject = REJECT.exec(field);
        if (reject) {
            const { subjectId } = e.value as RejectExpectation;
            const proposedFor = Object.entries(output.proposals).filter(([, ada]) => ada === reject[1]).map(([s]) => s);
            const hit = subjectId ? proposedFor.includes(subjectId) : proposedFor.length > 0;
            out[field] = hit ? 'rejected-proposed' : 'rejected-kept-out';
        }
    }
    return out;
}

const OUTCOME: Record<string, FieldOutcome> = {
    recovered: 'agree', none: 'agree', 'rejected-kept-out': 'agree',
    wrong: 'disagree', extra: 'disagree', 'rejected-proposed': 'disagree',
    missed: 'missing',
};

export function scoreMatching(output: MatchingOutput, c: Case<MatchingInput>): Record<string, FieldOutcome> {
    return Object.fromEntries(Object.entries(matchingDetail(output, c)).map(([f, d]) => [f, OUTCOME[d]]));
}

/** Recall and precision over linked subjects, as evaluate-decision-matching printed them, per tier group. */
export function matchingReport(rows: ResultRow[], cases: Case<MatchingInput>[]): string {
    const byId = new Map(cases.map(c => [c.id, c]));
    const groups = { human: new Map<string, number>(), all: new Map<string, number>() };
    for (const row of rows) {
        const c = byId.get(row.caseId);
        for (const [field, verdict] of Object.entries(row.detail ?? {})) {
            const human = c ? HUMAN_TIERS.includes(c.expect[field]?.tier) : false;
            for (const [name, tally] of Object.entries(groups)) {
                if (name === 'human' && !human) continue;
                tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
            }
        }
    }
    const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
    const lines: string[] = [`${rows.length} row(s) over ${new Set(rows.map(r => r.caseId)).size} meeting(s)`];
    for (const [name, t] of Object.entries(groups)) {
        const n = (k: string) => t.get(k) ?? 0;
        const linked = n('recovered') + n('wrong') + n('missed');
        const proposals = n('recovered') + n('wrong') + n('extra');
        lines.push(`${name === 'human' ? 'imported/adjudicated values' : 'all values'}:`);
        lines.push(`  linked subjects: ${linked}`);
        lines.push(`  recall:    ${n('recovered')}/${linked}  ${pct(n('recovered'), linked)}`);
        lines.push(`  precision: ${n('recovered')}/${proposals}  ${pct(n('recovered'), proposals)}`);
        lines.push(`  wrong: ${n('wrong')}, missed: ${n('missed')}, extra proposals on unlinked subjects: ${n('extra')}`);
        if (n('rejected-proposed') + n('rejected-kept-out')) lines.push(`  dismissed candidates proposed again: ${n('rejected-proposed')}/${n('rejected-proposed') + n('rejected-kept-out')}`);
    }
    return lines.join('\n');
}

export type MatchingLinks = {
    /** A person's link: imported. */
    human: Map<string, { ada: string; expected: Omit<Expected, 'value' | 'tier'> }>;
    /** Dismissed candidates by ΑΔΑ: imported. */
    rejected: Map<string, { subjectId: string | null; expected: Omit<Expected, 'value' | 'tier'> }>;
    /** The meeting's other links (a task's own): drafted. */
    task: Map<string, string>;
};

/**
 * A case per meeting window. A subject a person linked is imported truth; a link the
 * task made itself, and a subject with no link, are drafted (regression only). A
 * dismissed candidate the meeting also links somewhere is no rejection.
 */
export function matchingCase(input: MatchingInput, links: MatchingLinks, now = new Date()): Case<MatchingInput> {
    const [cityId, meetingId] = input.meeting.split('/');
    const id = `decisions.matching/${cityId}-${meetingId}`;
    const at = now.toISOString().slice(0, 10);
    const expect: Record<string, Expected> = {};
    for (const s of input.subjects) {
        const human = links.human.get(s.subjectId);
        if (human) {
            expect[`link[${s.subjectId}]`] = { value: human.ada, tier: 'imported', ...human.expected };
            continue;
        }
        const task = links.task.get(s.subjectId) ?? null;
        expect[`link[${s.subjectId}]`] = { value: task, tier: 'drafted', by: 'opencouncil', at, source: task ? 'opencouncil:task-link' : 'opencouncil:no-link' };
    }
    const linked = new Set([...links.human.values()].map(h => h.ada).concat([...links.task.values()]));
    for (const [ada, r] of links.rejected) {
        if (linked.has(ada)) continue;
        expect[`reject[${ada}]`] = { value: { subjectId: r.subjectId } satisfies RejectExpectation, tier: 'imported', ...r.expected };
    }
    return {
        id, suite: 'decisions.matching', split: assignSplit(id), input, replay: null, expect,
        cluster: `${cityId}/${input.administrativeBodyName ?? 'unknown body'}`, tags: ['opencouncil-signals'],
    };
}

const quiet = () => {};

/**
 * Phase-0 readings replay from recordings (an unrecorded one is read live once and
 * recorded); the resolvers are what a matching variant changes, so they stay live.
 */
export const decisionsMatching: Suite<MatchingInput, MatchingOutput> = {
    id: 'decisions.matching',
    task: 'pollDecisions',
    labels: ['decision-resolver', 'protocol-gap-resolver'],
    replay: { live: ['decision-resolver', 'protocol-gap-resolver'], onMiss: 'live' },
    run: async c => {
        const { decisions, partition } = await gatherMeetingCandidates(c.input, quiet);
        const outcome = await resolveMeetingDecisions({
            subjects: c.input.subjects,
            inMeeting: partition.inMeeting.map(r => r.decision),
            fallback: partition.fallback.map(r => r.decision),
            diavgeiaUid: c.input.diavgeiaUid,
            log: quiet,
        });
        return {
            proposals: Object.fromEntries(outcome.matches.map(m => [m.subjectId, m.ada])),
            window: { fetched: decisions.length, inMeeting: partition.inMeeting.length, fallback: partition.fallback.length },
        };
    },
    score: scoreMatching,
    detail: matchingDetail,
    labelValue: (output, field) => {
        const link = LINK.exec(field);
        return link ? output.proposals[link[1]] ?? null : undefined;
    },
    report: matchingReport,
};
