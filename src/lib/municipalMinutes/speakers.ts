import { addUsage, NO_USAGE, ResultWithUsage } from "../ai.js";
import { isCancellation } from "../taskControl.js";
import { llmMatchMembers, matchPersonByName } from "../../tasks/utils/decisionPdfExtraction.js";
import type { FixFromMinutesReport, RosterPerson, SpeakerHint } from "../../types.js";
import { formatTime } from "../../utils.js";
import type { Matching, TimedUtterance } from "./matching.js";
import { foldLine } from "./text.js";
import { canonicalRole, parseLabel, type Turn } from "./turns.js";

/**
 * The speakers: for each diarization tag, the labels the minutes give the
 * utterances inside it, resolved to people of the roster. The person with the
 * largest share of the tag's aligned words is the tag's `minutes` opinion,
 * with that share as its purity. The minutes never overwrite a speaker by
 * themselves: opencouncil combines this opinion with the others.
 */

/** Purity (0–100) at or above which the opinion is actionable. A starting value for the backtest to set. */
export const PURITY_FLOOR = 80;
/** Aligned words a tag needs before its opinion is actionable. A starting value for the backtest to set. */
export const MIN_ALIGNED_WORDS = 50;

export type LabelResolution = Map<string, string | null>;

/** The roles a roster line lists («Πρόεδρος, Δημοτικό Συμβούλιο; Αντιδήμαρχος Παιδείας»), each as a title and the body it is held in. */
const roleEntries = (person: RosterPerson): { title: string; body: string | null }[] =>
    (person.role ?? "").split(";").map(part => {
        const [title, ...body] = part.split(",");
        return { title: foldLine(title), body: body.length > 0 ? foldLine(body.join(",")) : null };
    }).filter(e => e.title);

/**
 * The one roster person who holds the role: in the body that is meeting when
 * someone holds it there (the council and a committee each have a vice-chair),
 * else anywhere in the municipality. Null when none or several do.
 */
function resolveRole(role: string, roster: RosterPerson[], bodyName: string | null): string | null {
    const body = bodyName ? foldLine(bodyName) : null;
    const holds = (e: { title: string }) => canonicalRole(e.title) === role || (role === "προεδροσ" && e.title === "head");
    const inBody = roster.filter(p => roleEntries(p).some(e => holds(e) && e.body !== null && e.body === body));
    const candidates = inBody.length > 0 ? inBody : roster.filter(p => roleEntries(p).some(holds));
    return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Resolves each label key to a person. A name the label prints wins: the name
 * of a name label, or the name a role label's parenthesis gives («ΠΡΟΕΔΡΟΣ
 * (κ. Μάγκος)» is the vice-chair in the chair's seat, not the chair). A role
 * label without a name resolves through the roster's roles. A name neither
 * the name matcher nor the roles settle goes to the model matcher; a role
 * label whose printed name the matcher misses never falls back on the role.
 * A label that resolves to nobody (a resident, an employee, «ΣΥΜΒΟΥΛΟΣ» for an
 * unknown voice) stays null. A label that does not follow the grammar names
 * no one the matchers could find, and never reaches them.
 */
export async function resolveLabels(turns: Turn[], roster: RosterPerson[], bodyName: string | null = null): Promise<ResultWithUsage<LabelResolution>> {
    const resolution: LabelResolution = new Map();
    const unmatched = new Map<string, string>();
    for (const turn of turns) {
        if (resolution.has(turn.key)) continue;
        const parsed = parseLabel(turn.label);
        const name = parsed?.role ? parsed.parenthesisName : parsed?.name ?? null;
        let personId: string | null = null;
        if (name) {
            personId = matchPersonByName(name, roster);
            if (!personId) unmatched.set(turn.key, name);
        } else if (parsed?.role) {
            personId = resolveRole(parsed.role, roster, bodyName);
        }
        resolution.set(turn.key, personId);
    }

    let usage = NO_USAGE;
    if (unmatched.size > 0 && roster.length > 0) {
        try {
            const names = [...unmatched.values()];
            const matched = await llmMatchMembers(names, roster);
            usage = addUsage(usage, matched.usage);
            for (const [key, name] of unmatched) {
                const hit = matched.matched.find(m => m.name === name);
                if (hit) resolution.set(key, hit.personId);
            }
        } catch (error) {
            if (isCancellation(error)) throw error;
            console.error("Minutes label matching: the model matcher failed; the unmatched labels resolve to nobody:", error);
        }
    }
    return { result: resolution, usage };
}

type PersonShare = { personId: string | null; words: number; from: number; to: number; labels: Set<string> };

export type TagOpinion = {
    speakerTagId: string;
    alignedWords: number;
    people: PersonShare[];
    /** The person with the largest share, when the minutes name anyone. */
    personId: string | null;
    purity: number;
    actionable: boolean;
};

/** Sums the aligned words of each tag by the person the minutes give them. */
export function tagOpinions(turns: Turn[], utterances: TimedUtterance[], matching: Matching, resolution: LabelResolution): TagOpinion[] {
    const byTag = new Map<string, Map<string | null, PersonShare>>();
    matching.utterances.forEach((match, i) => {
        const utterance = utterances[i];
        if (!utterance.speakerTagId || match.matched === 0) return;
        const shares = byTag.get(utterance.speakerTagId) ?? new Map();
        byTag.set(utterance.speakerTagId, shares);
        for (const [turnIndex, words] of match.byTurn) {
            const turn = turns[turnIndex];
            const personId = resolution.get(turn.key) ?? null;
            const share = shares.get(personId) ?? { personId, words: 0, from: utterance.start, to: utterance.end, labels: new Set<string>() };
            share.words += words;
            share.from = Math.min(share.from, utterance.start);
            share.to = Math.max(share.to, utterance.end);
            share.labels.add(turn.label);
            shares.set(personId, share);
        }
    });

    return [...byTag].map(([speakerTagId, shares]) => {
        const people = [...shares.values()].sort((a, b) => b.words - a.words);
        const alignedWords = people.reduce((n, p) => n + p.words, 0);
        const best = people.find(p => p.personId !== null) ?? null;
        // The floor applies to the share itself: 159 of 200 words round to 80 and are under it.
        const share = best ? (best.words / alignedWords) * 100 : 0;
        const actionable = best !== null && people[0] === best && share >= PURITY_FLOOR && alignedWords >= MIN_ALIGNED_WORDS;
        return { speakerTagId, alignedWords, people, personId: best?.personId ?? null, purity: Math.round(share), actionable };
    });
}

const describeShare = (share: PersonShare, alignedWords: number): string =>
    `${[...share.labels].join("/")}${share.personId ? "" : " (nobody)"} ${Math.round((share.words / alignedWords) * 100)}% (${formatTime(share.from)}–${formatTime(share.to)})`;

/** The opinions as speaker hints of method `minutes`: confidence is the purity, the evidence lists every label with its share and time range. */
export function toMinutesHints(opinions: TagOpinion[]): SpeakerHint[] {
    return opinions.filter(o => o.personId !== null).map(o => ({
        speakerTagId: o.speakerTagId,
        personId: o.personId!,
        actionable: o.actionable,
        evidenceKind: null,
        confidence: o.purity,
        evidence: `${o.alignedWords} aligned words: ${o.people.map(p => describeShare(p, o.alignedWords)).join("; ")}`,
    }));
}

export function speakersReport(opinions: TagOpinion[], utterances: TimedUtterance[], turns: Turn[], resolution: LabelResolution): FixFromMinutesReport["speakers"] {
    const speakerByTag = new Map<string, string | null>();
    for (const u of utterances) if (u.speakerTagId && !speakerByTag.has(u.speakerTagId)) speakerByTag.set(u.speakerTagId, u.speakerId);

    const contested = opinions
        .filter(o => o.personId !== null && !o.actionable && o.alignedWords >= MIN_ALIGNED_WORDS)
        .map(o => ({
            speakerTagId: o.speakerTagId,
            people: o.people.filter(p => p.personId !== null).map(p => ({ personId: p.personId!, share: Math.round((p.words / o.alignedWords) * 100), from: p.from, to: p.to })),
        }));
    // The request carries the speaker the app has for the segment, documented as the voiceprint match.
    const disagreements = opinions
        .filter(o => o.actionable && speakerByTag.get(o.speakerTagId) && speakerByTag.get(o.speakerTagId) !== o.personId)
        .map(o => ({
            speakerTagId: o.speakerTagId,
            opinions: [
                { method: "voiceprint" as const, personId: speakerByTag.get(o.speakerTagId)! },
                { method: "minutes" as const, personId: o.personId! },
            ],
        }));
    const unresolvedLabels = [...new Set(turns.filter(t => resolution.get(t.key) === null).map(t => t.label))];

    return { actionable: opinions.filter(o => o.actionable).length, contested, disagreements, unresolvedLabels };
}
