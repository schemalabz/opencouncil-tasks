import { aiChat, addUsage, NO_USAGE, ResultWithUsage } from "./ai.js";
import { getLanguageConfig } from "./language.js";
import { CityLanguage, RosterPerson } from "../types.js";
import { formatTime } from "../utils.js";

export type { RosterPerson };

/**
 * Text-only speaker identification.
 *
 * Diarization labels every voice in a meeting consistently (all "S3" lines are
 * the same person) but, without voiceprints, has no idea who S3 is. Council
 * transcripts carry that information in the text: the chair gives the floor
 * by name, people answer the roll call, replies are addressed by name or
 * role. This module asks the model to read those cues and map each
 * diarization label to a roster person.
 *
 * Long meetings are read in contiguous chunks; the per-chunk verdicts are
 * merged by summing confidence per candidate, so a speaker named once early
 * and once late still resolves to one person.
 */

export type SpeakerSegmentInput = {
    speakerLabel: string;
    start: number;
    end: number;
    text: string;
};

/** A label whose identity is already established (e.g. by a voiceprint match). */
export type KnownSpeaker = {
    speakerLabel: string;
    personId: string;
};

export type SpeakerIdentification = {
    speakerLabel: string;
    personId: string | null;
    /** 0–100. 0 when no chunk offered a candidate. */
    confidence: number;
    evidence: string;
    /** Competing candidates seen in other chunks, strongest first. */
    alternatives: { personId: string; confidence: number }[];
    /** Passed through from knownSpeakers instead of being asked of the model. */
    known: boolean;
};

export type ChunkIdentification = {
    speakerLabel: string;
    personId: string | null;
    confidence: number;
    evidence: string;
};

/** One verdict as the model writes it: a roster key, and the name it believes that key holds. */
export type ModelVerdict = {
    speakerLabel: string;
    person: string | null;
    personName: string | null;
    confidence: number;
    evidence: string;
};

export type IdentifySpeakersArgs = {
    cityName: string;
    language: CityLanguage;
    /** ISO date (YYYY-MM-DD) of the meeting; shown to the model for context. */
    meetingDate: string;
    /** Name of the administrative body that is meeting (council, committee, ...). */
    administrativeBodyName?: string | null;
    roster: RosterPerson[];
    /** Time-ordered speaker segments of the whole meeting. */
    segments: SpeakerSegmentInput[];
    knownSpeakers?: KnownSpeaker[];
    model?: string;
    /** Max characters of transcript per model call. */
    chunkChars?: number;
    /** Parallel model calls. */
    concurrency?: number;
    onChunkDone?: (done: number, total: number) => void;
};

export const DEFAULT_IDENTIFICATION_MODEL = "claude-sonnet-4-6";
// Greek and Serbian Cyrillic tokenize at roughly 2–3 characters per token, so
// 60k characters stays well inside the context window with the roster on top.
export const DEFAULT_CHUNK_CHARS = 60_000;
const DEFAULT_CONCURRENCY = 3;

// A rival candidate whose summed confidence reaches this share of the winner's
// makes the verdict contested: the winner's confidence is capped so a
// threshold-based consumer treats it as a guess.
const CONTESTED_RATIO = 0.6;
const CONTESTED_CONFIDENCE_CAP = 50;

/**
 * The model sees roster people under short keys (P1, P2, ...) instead of
 * database ids. The cuids of one city share a long prefix and differ in a few
 * characters, and the model copied the wrong id while its evidence quoted the
 * right name.
 */
export const rosterKey = (index: number) => `P${index + 1}`;

export function buildSystemPrompt(language: CityLanguage): string {
    const { promptName } = getLanguageConfig(language);
    return `You identify who is speaking in an automatic transcript of a ${promptName} municipal meeting.

The speakers were separated by audio diarization and labelled S1, S2, S3, ... The labels are consistent across the whole meeting: every line marked S3 is the same voice, even in a different part of the transcript. Nothing about the label says who the person is — that is what you determine, from the text alone.

You receive the body that is meeting (a municipality has several: the council, committees, community councils), the roster of the municipality split into members of that body and everyone else (key, name, roles, party), any speakers whose identity is already known, and one contiguous chunk of the transcript as lines "[hh:mm:ss] S<n>: text".

EVIDENCE TO USE, strongest first:
- The chair giving the floor by name right before a label starts speaking ("τον λόγο έχει ο κ. Δημάκης", "la parole est à Madame ...", "реч има ...").
- Roll calls, where the chair reads a name and the next label answers ("Παρών", "Présent", "Присутан").
- A speaker introducing themselves, or stating their own role.
- Being addressed by name or role title in the lines around them ("κύριε Δήμαρχε", "κυρία Πρόεδρε" — resolve the title with the roster).
- Role behaviour: the person who opens the session, runs the roll call, puts items to a vote and grants the floor chairs THIS body. Resolve that to the head of the body that is meeting, never to the head of another body of the municipality. A vice-chair often presides for a stretch: a second label doing the chair's work is a stand-in, not the chair, unless its own name or title is spoken. The person answering as the executive is usually the mayor or a deputy mayor.

The speech-to-text often misspells names phonetically. Match spoken names to the roster by sound, not by exact spelling. A name that matches nobody on the roster stays unresolved. Prefer members of the meeting body, but other people of the municipality (deputy mayors, officials, other councillors) do attend. Several roster names can sound alike; check the whole name before choosing.

RULES:
- Use only evidence in the text. Never guess from the party or the topic, and never because a line continues someone else's argument: diarization starts a new label because the voice changed.
- Evidence must be about the label itself. A name or title addressed to one label says nothing about another label.
- confidence: 90–100 = explicit and repeated evidence (named when given the floor, answering a roll call, self-introduced); 60–89 = one clear spoken cue; role behaviour with no name or title spoken is worth at most 60; below 50 = a guess, which you must express as null with confidence 0.
- A wrong assignment puts words in the mouth of a named elected official on the public record. An omission is harmless. When unsure, answer null.
- Diarization sometimes splits one voice into two labels or merges two voices into one. Assigning the same person to two labels is allowed only when each label has its own explicit evidence.
- Include every label that appears in this chunk exactly once. Skip the speakers listed as already known.
- person: the roster key of the speaker (for example P12), or null when unknown. personName: the name on that key's roster line, copied exactly, or null.
- evidence: quote the decisive line(s) briefly, with their timestamp.

Answer with JSON only.`;
}

export function buildUserPrompt(args: {
    cityName: string;
    administrativeBodyName: string | null;
    meetingDate: string;
    roster: RosterPerson[];
    knownSpeakers: KnownSpeaker[];
    chunkIndex: number;
    chunkCount: number;
    segments: SpeakerSegmentInput[];
}): string {
    const { cityName, administrativeBodyName, meetingDate, roster, knownSpeakers, chunkIndex, chunkCount, segments } = args;
    const indexById = new Map(roster.map((p, i) => [p.id, i]));
    const rosterLine = (p: RosterPerson) => {
        const details = [p.role, p.party].filter(Boolean).join(", ");
        return `${rosterKey(indexById.get(p.id)!)} — ${p.name}${details ? ` (${details})` : ""}`;
    };
    const members = roster.filter(p => p.memberOfMeetingBody);
    const others = roster.filter(p => !p.memberOfMeetingBody);
    const rosterBlock = members.length > 0
        ? `Members of ${administrativeBodyName ?? "the meeting body"} (key — name (roles, party)):\n${members.map(rosterLine).join("\n")}\n\nOther people of the municipality:\n${others.length > 0 ? others.map(rosterLine).join("\n") : "(none)"}`
        : `Roster (key — name (roles, party)):\n${roster.map(rosterLine).join("\n")}`;
    const knownLines = knownSpeakers.map(k => {
        const index = indexById.get(k.personId);
        return index === undefined ? `${k.speakerLabel} = (not on the roster)` : `${k.speakerLabel} = ${rosterKey(index)} ${roster[index].name}`;
    });
    const transcriptLines = segments.map(s => `[${formatTime(s.start)}] ${s.speakerLabel}: ${s.text}`);

    return `City: ${cityName}
Body meeting: ${administrativeBodyName ?? "(unknown)"}
Meeting date: ${meetingDate}

${rosterBlock}

Already identified speakers:
${knownLines.length > 0 ? knownLines.join("\n") : "(none)"}

Transcript chunk ${chunkIndex + 1} of ${chunkCount}:
${transcriptLines.join("\n")}`;
}

/**
 * Splits time-ordered segments into contiguous chunks of at most maxChars of
 * text. A single segment longer than maxChars becomes its own chunk rather
 * than being cut, so no utterance is ever split across calls.
 */
export function chunkSegments(segments: SpeakerSegmentInput[], maxChars: number): SpeakerSegmentInput[][] {
    const chunks: SpeakerSegmentInput[][] = [];
    let current: SpeakerSegmentInput[] = [];
    let currentChars = 0;

    for (const segment of segments) {
        const size = segment.text.length + segment.speakerLabel.length + 12;
        if (current.length > 0 && currentChars + size > maxChars) {
            chunks.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(segment);
        currentChars += size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/**
 * Combines per-chunk verdicts into one verdict per label. Each candidate's
 * confidence is summed across chunks; the best total wins and keeps the
 * strongest single-chunk confidence and evidence. A close runner-up marks the
 * verdict as contested and caps the confidence.
 */
export function mergeChunkIdentifications(
    chunkResults: ChunkIdentification[][],
    labels: string[],
    knownSpeakers: KnownSpeaker[] = []
): SpeakerIdentification[] {
    const knownByLabel = new Map(knownSpeakers.map(k => [k.speakerLabel, k.personId]));

    return labels.map((speakerLabel): SpeakerIdentification => {
        const knownPersonId = knownByLabel.get(speakerLabel);
        if (knownPersonId) {
            return { speakerLabel, personId: knownPersonId, confidence: 100, evidence: "known before identification", alternatives: [], known: true };
        }

        const candidates = new Map<string, { total: number; max: number; evidence: string }>();
        for (const chunk of chunkResults) {
            for (const verdict of chunk) {
                if (verdict.speakerLabel !== speakerLabel || !verdict.personId || verdict.confidence <= 0) continue;
                const existing = candidates.get(verdict.personId) ?? { total: 0, max: 0, evidence: "" };
                existing.total += verdict.confidence;
                if (verdict.confidence > existing.max) {
                    existing.max = verdict.confidence;
                    existing.evidence = verdict.evidence;
                }
                candidates.set(verdict.personId, existing);
            }
        }

        const ranked = [...candidates.entries()].sort((a, b) => b[1].total - a[1].total);
        if (ranked.length === 0) {
            return { speakerLabel, personId: null, confidence: 0, evidence: "", alternatives: [], known: false };
        }

        const [bestId, best] = ranked[0];
        const alternatives = ranked.slice(1).map(([personId, c]) => ({ personId, confidence: c.max }));
        const contested = ranked.length > 1 && ranked[1][1].total >= CONTESTED_RATIO * best.total;
        const confidence = contested ? Math.min(best.max, CONTESTED_CONFIDENCE_CAP) : best.max;

        return { speakerLabel, personId: bestId, confidence, evidence: best.evidence, alternatives, known: false };
    });
}

/** Lower-case, accent-free, punctuation-free form of a name, for comparison. */
export function normalizeName(name: string): string {
    return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Same person name, allowing one side to omit tokens ("Κωνστανταράκης" vs "Βασίλειος Κωνστανταράκης"). */
export function sameName(a: string, b: string): boolean {
    const ta = normalizeName(a).split(" ").filter(Boolean);
    const tb = normalizeName(b).split(" ").filter(Boolean);
    if (ta.length === 0 || tb.length === 0) return false;
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return short.every(t => long.includes(t));
}

/**
 * Resolves a verdict's key and name to a roster person. They must agree. When
 * they don't, the name wins if it matches exactly one roster person — the
 * model reads names reliably and mis-copies keys — and otherwise the verdict
 * is dropped, since an omission is harmless and a wrong name is not.
 *
 * No key means the model could not place the speaker. A name beside it is then
 * only what it heard ("Κώστας"), and must not be matched to whoever on the
 * roster happens to carry it.
 */
function resolvePerson(verdict: ModelVerdict, roster: RosterPerson[]): string | null {
    const name = verdict.personName?.trim() || null;
    if (!verdict.person?.trim()) return null;
    const keyMatch = verdict.person?.trim().match(/^P(\d+)$/i);
    const byKey = keyMatch ? roster[parseInt(keyMatch[1], 10) - 1] : undefined;

    if (byKey && (!name || sameName(byKey.name, name))) return byKey.id;

    const byName = name ? roster.filter(p => sameName(p.name, name)) : [];
    if (byName.length === 1) {
        console.warn(`Speaker identification: ${verdict.speakerLabel} was given key ${verdict.person} (${byKey?.name ?? "not on the roster"}) with the name "${name}"; using ${byName[0].name}`);
        return byName[0].id;
    }
    console.warn(`Speaker identification: ${verdict.speakerLabel} was given key ${verdict.person} with the name "${name}", which do not identify one roster person; treating as unresolved`);
    return null;
}

/**
 * Drops verdicts the model was not entitled to give: labels absent from the
 * chunk, repeated labels, and people that key and name don't pin down.
 */
export function sanitizeChunkVerdicts(
    verdicts: ModelVerdict[],
    chunkLabels: Set<string>,
    roster: RosterPerson[]
): ChunkIdentification[] {
    const seen = new Set<string>();
    const kept: ChunkIdentification[] = [];

    for (const verdict of verdicts) {
        if (!chunkLabels.has(verdict.speakerLabel) || seen.has(verdict.speakerLabel)) continue;
        seen.add(verdict.speakerLabel);

        const personId = resolvePerson(verdict, roster);
        const confidence = Math.max(0, Math.min(100, Math.round(verdict.confidence)));
        kept.push({ speakerLabel: verdict.speakerLabel, personId, confidence: personId ? confidence : 0, evidence: verdict.evidence ?? "" });
    }
    return kept;
}

type ChunkResponse = { identifications: ModelVerdict[] };

const CHUNK_OUTPUT_FORMAT = {
    type: "json_schema" as const,
    schema: {
        type: "object",
        properties: {
            identifications: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        speakerLabel: { type: "string" },
                        person: { type: ["string", "null"] },
                        personName: { type: ["string", "null"] },
                        confidence: { type: "integer" },
                        evidence: { type: "string" }
                    },
                    required: ["speakerLabel", "person", "personName", "confidence", "evidence"],
                    additionalProperties: false
                }
            }
        },
        required: ["identifications"],
        additionalProperties: false
    }
};

export function labelsInOrder(segments: SpeakerSegmentInput[]): string[] {
    return [...new Set(segments.map(s => s.speakerLabel))];
}

export async function identifySpeakers(args: IdentifySpeakersArgs): Promise<ResultWithUsage<SpeakerIdentification[]>> {
    const {
        cityName, language, meetingDate, roster, segments,
        administrativeBodyName = null,
        knownSpeakers = [],
        model = DEFAULT_IDENTIFICATION_MODEL,
        chunkChars = DEFAULT_CHUNK_CHARS,
        concurrency = DEFAULT_CONCURRENCY,
        onChunkDone,
    } = args;

    const labels = labelsInOrder(segments);
    const chunks = chunkSegments(segments, chunkChars);
    const systemPrompt = buildSystemPrompt(language);
    const knownLabels = new Set(knownSpeakers.map(k => k.speakerLabel));
    console.log(`Identifying ${labels.length} speakers (${knownSpeakers.length} known) across ${chunks.length} chunk(s) with ${model}`);

    let usage = NO_USAGE;
    let done = 0;
    const chunkResults: ChunkIdentification[][] = new Array(chunks.length);

    const runChunk = async (chunk: SpeakerSegmentInput[], index: number) => {
        const userPrompt = buildUserPrompt({ cityName, administrativeBodyName, meetingDate, roster, knownSpeakers, chunkIndex: index, chunkCount: chunks.length, segments: chunk });
        const result = await aiChat<ChunkResponse>({
            model,
            label: `speaker-identification:${index + 1}/${chunks.length}`,
            systemPrompt,
            userPrompt,
            cacheSystemPrompt: true,
            maxTokens: 16000,
            outputFormat: CHUNK_OUTPUT_FORMAT,
        });
        usage = addUsage(usage, result.usage);
        const chunkLabels = new Set(labelsInOrder(chunk).filter(l => !knownLabels.has(l)));
        chunkResults[index] = sanitizeChunkVerdicts(result.result.identifications ?? [], chunkLabels, roster);
        done++;
        onChunkDone?.(done, chunks.length);
    };

    for (let i = 0; i < chunks.length; i += concurrency) {
        await Promise.all(chunks.slice(i, i + concurrency).map((chunk, j) => runChunk(chunk, i + j)));
    }

    return { result: mergeChunkIdentifications(chunkResults, labels, knownSpeakers), usage };
}
