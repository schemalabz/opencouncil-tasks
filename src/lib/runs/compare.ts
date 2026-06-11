import { SummarizeResult } from '../../types.js';
import {
    ComparisonData, MatchedSubject, RunWithResult, SegmentSample,
    SideStats, SubjectVerdict, SubjectView,
} from './types.js';

/** Strip REF:UTTERANCE/PERSON/PARTY markdown links down to their text. */
function cleanRefs(text: string | null | undefined): string {
    return (text ?? '').replace(/\[([^\]]*)\]\(REF:[A-Z]+:[^)]+\)/g, '$1');
}

function toSubjectViews(result: SummarizeResult): SubjectView[] {
    const statusesBySubject = new Map<string, Record<string, number>>();
    for (const u of result.utteranceDiscussionStatuses) {
        if (!u.subjectId) continue;
        const statuses = statusesBySubject.get(u.subjectId) ?? {};
        statuses[u.status] = (statuses[u.status] ?? 0) + 1;
        statusesBySubject.set(u.subjectId, statuses);
    }

    return result.subjects.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        agendaItemIndex: typeof s.agendaItemIndex === 'number' ? s.agendaItemIndex : null,
        nonAgendaReason: s.agendaItemIndex === 'BEFORE_AGENDA' ? 'beforeAgenda' as const
            : s.agendaItemIndex === 'OUT_OF_AGENDA' ? 'outOfAgenda' as const : null,
        topic: s.topicLabel,
        withdrawn: s.withdrawn ?? false,
        context: s.context?.text ?? null,
        contextCitationUrls: s.context?.citationUrls ?? [],
        discussedIn: s.discussedIn,
        topicImportance: s.topicImportance,
        proximityImportance: s.proximityImportance,
        contributions: s.speakerContributions.map((c, i) => ({
            speakerName: c.speakerName ?? c.speakerId ?? 'unknown',
            text: c.text,
            order: c.order ?? i,
        })),
        utteranceStatuses: statusesBySubject.get(s.id) ?? {},
    }));
}

function totalUtterances(view: SubjectView): number {
    return Object.values(view.utteranceStatuses).reduce((a, b) => a + b, 0);
}

/**
 * Classify how a subject changed between runs. The point is separating
 * generation variance (cosmetic) from behavioral differences (structural)
 * when assessing a prompt or pipeline change.
 */
function classifySubject(from: SubjectView, to: SubjectView): { verdict: SubjectVerdict; changes: string[] } {
    const changes: string[] = [];
    let structural = false;

    if (from.name !== to.name) changes.push('name');
    if (from.topic !== to.topic) { changes.push(`topic:${from.topic}→${to.topic}`); structural = true; }
    if (from.withdrawn !== to.withdrawn) { changes.push('withdrawn'); structural = true; }
    if (from.topicImportance !== to.topicImportance) changes.push('topicImportance');
    if (from.proximityImportance !== to.proximityImportance) changes.push('proximityImportance');
    if (from.context !== to.context) changes.push('context');

    const fromDesc = cleanRefs(from.description);
    const toDesc = cleanRefs(to.description);
    if (fromDesc !== toDesc) {
        const delta = Math.abs(toDesc.length - fromDesc.length) / Math.max(fromDesc.length, 1);
        changes.push(`desc(${fromDesc.length}→${toDesc.length})`);
        if (delta > 0.3) structural = true;
    }

    const fromSpeakers = new Map(from.contributions.map(c => [c.speakerName, c.text]));
    const toSpeakers = new Map(to.contributions.map(c => [c.speakerName, c.text]));
    const added = [...toSpeakers.keys()].filter(s => !fromSpeakers.has(s));
    const removed = [...fromSpeakers.keys()].filter(s => !toSpeakers.has(s));
    if (added.length > 0) { changes.push(`+speakers:${added.join(',')}`); structural = true; }
    if (removed.length > 0) { changes.push(`-speakers:${removed.join(',')}`); structural = true; }
    const changedContribs = [...fromSpeakers.keys()]
        .filter(s => toSpeakers.has(s) && cleanRefs(fromSpeakers.get(s)) !== cleanRefs(toSpeakers.get(s)));
    if (changedContribs.length > 0) changes.push(`contribs-changed:${changedContribs.length}`);

    const fromUtt = totalUtterances(from);
    const toUtt = totalUtterances(to);
    if (fromUtt !== toUtt) {
        changes.push(`utterances:${fromUtt}→${toUtt}`);
        if (Math.abs(toUtt - fromUtt) / Math.max(fromUtt, 1) > 0.2) structural = true;
    }

    if (changes.length === 0) return { verdict: 'identical', changes };
    return { verdict: structural ? 'structural' : 'cosmetic', changes };
}

function computeStats(views: SubjectView[]): SideStats {
    return {
        totalSubjects: views.length,
        agendaSubjects: views.filter(v => v.agendaItemIndex !== null).length,
        beforeAgenda: views.filter(v => v.nonAgendaReason === 'beforeAgenda').length,
        outOfAgenda: views.filter(v => v.nonAgendaReason === 'outOfAgenda').length,
        totalContributions: views.reduce((sum, v) => sum + v.contributions.length, 0),
        totalUtterancesAssigned: views.reduce((sum, v) => sum + totalUtterances(v), 0),
    };
}

/** Normalized token set for fuzzy name matching (lowercase, accents stripped). */
function nameTokens(name: string): Set<string> {
    // Single-character tokens stay: they are often the discriminator
    // between otherwise identical names ("Ανακοίνωση Α" vs "Ανακοίνωση Β").
    return new Set(
        name.toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .split(/[^a-z0-9α-ω]+/)
            .filter(Boolean)
    );
}

function nameSimilarity(a: string, b: string): number {
    const tokensA = nameTokens(a);
    const tokensB = nameTokens(b);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
    return intersection / (tokensA.size + tokensB.size - intersection);
}

const NAME_MATCH_THRESHOLD = 0.6;

/**
 * Fallback for subjects the index match left unpaired: the same subject can
 * change agenda classification between runs (e.g. agenda item ↔ out-of-agenda),
 * which would otherwise show as removed + added instead of one structural change.
 */
function matchLeftoversByName(fromOnly: SubjectView[], toOnly: SubjectView[]): MatchedSubject[] {
    const matched: MatchedSubject[] = [];
    for (const from of [...fromOnly]) {
        let best: { to: SubjectView; score: number } | null = null;
        for (const to of toOnly) {
            const score = nameSimilarity(from.name, to.name);
            if (score >= NAME_MATCH_THRESHOLD && (!best || score > best.score)) best = { to, score };
        }
        if (!best) continue;

        const { verdict, changes } = classifySubject(from, best.to);
        const classification = (v: SubjectView): string => v.agendaItemIndex !== null ? `#${v.agendaItemIndex}` : v.nonAgendaReason ?? 'unknown';
        const classificationChanged = classification(from) !== classification(best.to);
        matched.push({
            agendaItemIndex: from.agendaItemIndex ?? best.to.agendaItemIndex,
            matchedBy: 'name',
            from,
            to: best.to,
            verdict: classificationChanged ? 'structural' : verdict,
            changes: classificationChanged
                ? [`agenda-classification:${classification(from)}→${classification(best.to)}`, ...changes]
                : changes,
        });
        fromOnly.splice(fromOnly.indexOf(from), 1);
        toOnly.splice(toOnly.indexOf(best.to), 1);
    }
    return matched;
}

const MAX_SEGMENT_SAMPLES = 10;

function collectSegmentSamples(from: SummarizeResult, to: SummarizeResult): SegmentSample[] {
    const toBySegment = new Map(to.speakerSegmentSummaries.map(s => [s.speakerSegmentId, s]));

    const substantive: SegmentSample[] = [];
    const procedural: SegmentSample[] = [];
    from.speakerSegmentSummaries.forEach((f, index) => {
        const t = toBySegment.get(f.speakerSegmentId);
        if (!t || (f.summary === t.summary && f.type === t.type)) return;
        const sample: SegmentSample = {
            segmentId: f.speakerSegmentId,
            index,
            from: { type: f.type, text: f.summary },
            to: { type: t.type, text: t.summary },
        };
        if (f.type === 'SUBSTANTIAL' || t.type === 'SUBSTANTIAL') substantive.push(sample);
        else procedural.push(sample);
    });

    const pickEvenly = (samples: SegmentSample[], count: number): SegmentSample[] => {
        if (samples.length <= count) return samples;
        if (count === 1) return [samples[0]];
        const step = (samples.length - 1) / (count - 1);
        return Array.from({ length: count }, (_, i) => samples[Math.round(i * step)]);
    };

    const picked = pickEvenly(substantive, MAX_SEGMENT_SAMPLES);
    if (picked.length < MAX_SEGMENT_SAMPLES) {
        picked.push(...pickEvenly(procedural, MAX_SEGMENT_SAMPLES - picked.length));
    }
    return picked.sort((a, b) => a.index - b.index);
}

/** Build the full comparison between two runs of the same meeting. */
export function compareRuns(from: RunWithResult, to: RunWithResult): ComparisonData {
    const fromViews = toSubjectViews(from.result);
    const toViews = toSubjectViews(to.result);

    const fromByIndex = new Map(fromViews.filter(v => v.agendaItemIndex !== null).map(v => [v.agendaItemIndex, v]));
    const toByIndex = new Map(toViews.filter(v => v.agendaItemIndex !== null).map(v => [v.agendaItemIndex, v]));

    const matched: MatchedSubject[] = [];
    const fromOnly: SubjectView[] = fromViews.filter(v => v.agendaItemIndex === null);
    const toOnly: SubjectView[] = toViews.filter(v => v.agendaItemIndex === null);

    const allIndices = [...new Set([...fromByIndex.keys(), ...toByIndex.keys()])].sort((a, b) => a! - b!);
    for (const index of allIndices) {
        const f = fromByIndex.get(index);
        const t = toByIndex.get(index);
        if (f && t) {
            matched.push({ agendaItemIndex: index!, matchedBy: 'index', from: f, to: t, ...classifySubject(f, t) });
        } else if (f) {
            fromOnly.push(f);
        } else if (t) {
            toOnly.push(t);
        }
    }

    matched.push(...matchLeftoversByName(fromOnly, toOnly));

    const verdictSummary: Record<SubjectVerdict, number> = { identical: 0, cosmetic: 0, structural: 0 };
    for (const m of matched) verdictSummary[m.verdict]++;

    return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        sources: { from: from.info, to: to.info },
        subjects: { matched, fromOnly, toOnly },
        segmentSamples: collectSegmentSamples(from.result, to.result),
        stats: { from: computeStats(fromViews), to: computeStats(toViews) },
        verdictSummary,
    };
}
