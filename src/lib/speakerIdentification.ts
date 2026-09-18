import { aiChat, addUsage, NO_USAGE, ResultWithUsage } from "./ai.js";
import { getLanguageConfig } from "./language.js";
import { CityLanguage, RosterPerson, SpeakerEvidenceKind } from "../types.js";
import { formatTime } from "../utils.js";
import { isCancellation } from "./taskControl.js";

export type { RosterPerson, SpeakerEvidenceKind };

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
 *
 * The pass also decides whether it would act on each identification
 * (isActionable): by the kind of evidence, and by a floor on the model's
 * confidence. The number travels along for a reviewer to read; nothing
 * downstream thresholds it.
 */

/** Evidence kinds, strongest first. The order ranks a speaker's evidence across chunks. */
export const SPEAKER_EVIDENCE_KINDS: readonly SpeakerEvidenceKind[] = ["named", "rollCall", "selfIntroduced", "addressed", "roleBehaviour"];

/**
 * The evidence the pass acts on by itself. Role behaviour alone names nobody:
 * whoever chairs may be a stand-in, and whoever answers as the executive may be
 * a deputy.
 *
 * This is the bar a caller used to set with a confidence threshold. It lives
 * here, next to the prompt that defines the kinds, so a prompt or model change
 * is calibrated in one place: the backtest's evidence table shows the
 * wrong-name rate of each kind (docs/speaker-identification-backtest.md).
 */
export const ACTIONABLE_EVIDENCE_KINDS: ReadonlySet<SpeakerEvidenceKind> = new Set<SpeakerEvidenceKind>(["named", "rollCall", "selfIntroduced", "addressed"]);

/**
 * The lowest confidence the pass acts on, on top of the kind of evidence.
 *
 * The kind says which cue the model found. The number says how sure it is that
 * the cue points at this person. When it doubts, over a surname two people
 * share or a reply that may have come from someone else, it keeps the kind,
 * lowers the number, and says so in its note. Acting on the kind alone
 * published those names.
 *
 * 75 was chosen on the 53 meetings of the backtest, where it holds back 7 of
 * the 25 wrong names and 14 of the 616 right ones. A bar picked on the meetings
 * it is measured on looks better than it is, and the number belongs to this
 * prompt and this model: read the backtest's threshold table again when either
 * changes.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 75;

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
    /** The strongest kind of evidence any chunk gave for the person. */
    evidenceKind: SpeakerEvidenceKind | null;
    /** A rival candidate came close across chunks. The pass does not act on a contested label. */
    contested: boolean;
    /** The pass would act on this identification by itself (see isActionable). */
    actionable: boolean;
    /** 0–100, the model's number on the verdict the evidence comes from. 0 when no chunk offered a candidate. */
    confidence: number;
    /** The quote of the verdict with the strongest kind of evidence: the cue evidenceKind names. */
    evidence: string;
    /** Competing candidates seen in other chunks, strongest first. */
    alternatives: { personId: string; confidence: number }[];
    /** Passed through from knownSpeakers instead of being asked of the model. */
    known: boolean;
};

export type ChunkIdentification = {
    speakerLabel: string;
    personId: string | null;
    evidenceKind: SpeakerEvidenceKind | null;
    confidence: number;
    evidence: string;
};

/** One verdict as the model writes it: a roster key, and the name it believes that key holds. */
export type ModelVerdict = {
    speakerLabel: string;
    person: string | null;
    personName: string | null;
    evidenceKind?: string | null;
    confidence: number;
    evidence: string;
};

export type IdentificationEffort = "low" | "medium" | "high" | "xhigh" | "max";

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
    /** How much the model thinks before answering. */
    effort?: IdentificationEffort;
    /** Max characters of transcript per model call. */
    chunkChars?: number;
    /** Parallel model calls. */
    concurrency?: number;
    onChunkDone?: (done: number, total: number) => void;
};

export const DEFAULT_IDENTIFICATION_MODEL = "claude-sonnet-5-5";
// Sonnet 5.5 thinks by default and its effort levels are its own, so the level
// is set here and not inherited. The backtest takes --effort to compare levels;
// change this only with its table in hand.
export const DEFAULT_IDENTIFICATION_EFFORT: IdentificationEffort = "medium";
// Thinking counts toward the output cap, and a structured-output call that hits
// the cap fails outright, so the cap leaves room for both.
const IDENTIFICATION_MAX_TOKENS = 32_000;
// Greek and Serbian Cyrillic tokenize at roughly 2–3 characters per token, so
// 60k characters stays well inside the context window with the roster on top.
export const DEFAULT_CHUNK_CHARS = 60_000;
const DEFAULT_CONCURRENCY = 3;

// A rival candidate whose summed confidence reaches this share of the winner's
// makes the verdict contested, and the pass does not act on it.
const CONTESTED_RATIO = 0.6;

const isEvidenceKind = (value: unknown): value is SpeakerEvidenceKind =>
    typeof value === "string" && (SPEAKER_EVIDENCE_KINDS as readonly string[]).includes(value);

/**
 * The pass would act on this identification by itself: a person, uncontested,
 * on evidence that names them, at a confidence that reaches the floor.
 */
export function isActionable({ personId, evidenceKind, contested, confidence }: Pick<SpeakerIdentification, "personId" | "evidenceKind" | "contested" | "confidence">): boolean {
    return personId !== null && !contested && evidenceKind !== null && ACTIONABLE_EVIDENCE_KINDS.has(evidenceKind)
        && confidence >= MIN_ACTIONABLE_CONFIDENCE;
}

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
- evidenceKind: the strongest kind of evidence you used for the person. "named": this label is given the floor by name right before it speaks. "rollCall": a name is read out and this label answers. "selfIntroduced": the speaker states their own name or role. "addressed": others address the speaker by name or role title in the lines around it. "roleBehaviour": only what the speaker does; no name or title is spoken. null when person is null.
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
        // A party head is marked: "the head of the party" is a common way to give the floor.
        const party = p.party && p.partyHead ? `${p.party} (head)` : p.party;
        const details = [p.role, party].filter(Boolean).join(", ");
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
 * confidence is summed across chunks and the best total wins. The winner
 * reports its strongest single verdict whole: the strongest kind of evidence
 * any chunk gave, with that verdict's own quote and number, so the quote a
 * reviewer reads is the cue the pass went by. A close runner-up marks the
 * verdict as contested.
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
            // An anchor is an established identity, not a finding of this pass.
            return { speakerLabel, personId: knownPersonId, evidenceKind: null, contested: false, actionable: true, confidence: 100, evidence: "known before identification", alternatives: [], known: true };
        }

        // strongest: the candidate's verdict with the strongest kind of evidence, the more confident one on a tie.
        const candidates = new Map<string, { total: number; max: number; strongest: { kindRank: number; confidence: number; evidence: string } }>();
        for (const chunk of chunkResults) {
            for (const verdict of chunk) {
                if (verdict.speakerLabel !== speakerLabel || !verdict.personId || verdict.confidence <= 0) continue;
                const existing = candidates.get(verdict.personId)
                    ?? { total: 0, max: 0, strongest: { kindRank: Infinity, confidence: 0, evidence: "" } };
                existing.total += verdict.confidence;
                existing.max = Math.max(existing.max, verdict.confidence);
                const kindRank = verdict.evidenceKind ? SPEAKER_EVIDENCE_KINDS.indexOf(verdict.evidenceKind) : SPEAKER_EVIDENCE_KINDS.length;
                const { strongest } = existing;
                if (kindRank < strongest.kindRank || (kindRank === strongest.kindRank && verdict.confidence > strongest.confidence)) {
                    existing.strongest = { kindRank, confidence: verdict.confidence, evidence: verdict.evidence };
                }
                candidates.set(verdict.personId, existing);
            }
        }

        const ranked = [...candidates.entries()].sort((a, b) => b[1].total - a[1].total);
        if (ranked.length === 0) {
            return { speakerLabel, personId: null, evidenceKind: null, contested: false, actionable: false, confidence: 0, evidence: "", alternatives: [], known: false };
        }

        const [bestId, best] = ranked[0];
        const alternatives = ranked.slice(1).map(([personId, c]) => ({ personId, confidence: c.max }));
        const contested = ranked.length > 1 && ranked[1][1].total >= CONTESTED_RATIO * best.total;
        const evidenceKind = SPEAKER_EVIDENCE_KINDS[best.strongest.kindRank] ?? null;

        return {
            speakerLabel, personId: bestId, evidenceKind, contested,
            actionable: isActionable({ personId: bestId, evidenceKind, contested, confidence: best.strongest.confidence }),
            confidence: best.strongest.confidence, evidence: best.strongest.evidence, alternatives, known: false,
        };
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
 * they don't, the name wins if it is a full name, of two words or more, that
 * matches exactly one roster person — the model reads names reliably and
 * mis-copies keys — and otherwise the verdict is dropped, since an omission is
 * harmless and a wrong name is not.
 *
 * A single word is only what the model heard ("Κώστας"), and must not be
 * matched to whoever on the roster happens to carry it: not against a key that
 * says someone else, and not without a key, which means the model could not
 * place the speaker.
 */
function resolvePerson(verdict: ModelVerdict, roster: RosterPerson[]): string | null {
    const name = verdict.personName?.trim() || null;
    if (!verdict.person?.trim()) return null;
    const keyMatch = verdict.person?.trim().match(/^P(\d+)$/i);
    const byKey = keyMatch ? roster[parseInt(keyMatch[1], 10) - 1] : undefined;

    if (byKey && (!name || sameName(byKey.name, name))) return byKey.id;

    const isFullName = name !== null && normalizeName(name).split(" ").filter(Boolean).length >= 2;
    const byName = name !== null && isFullName ? roster.filter(p => sameName(p.name, name)) : [];
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
        kept.push({
            speakerLabel: verdict.speakerLabel,
            personId,
            // A kind the model made up counts as no kind: the pass then does not act on the name.
            evidenceKind: personId && isEvidenceKind(verdict.evidenceKind) ? verdict.evidenceKind : null,
            confidence: personId ? confidence : 0,
            evidence: verdict.evidence ?? "",
        });
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
                        evidenceKind: { anyOf: [{ type: "string", enum: [...SPEAKER_EVIDENCE_KINDS] }, { type: "null" }] },
                        confidence: { type: "integer" },
                        evidence: { type: "string" }
                    },
                    required: ["speakerLabel", "person", "personName", "evidenceKind", "confidence", "evidence"],
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

/** A chunk the model gave no answer for, counted from 1, and why. */
export type ChunkFailure = { chunk: number; reason: string };

export type IdentifySpeakersResult = ResultWithUsage<SpeakerIdentification[]> & {
    /** Chunks that failed. Their speakers got no name from them; the result holds what the other chunks said. */
    failedChunks: ChunkFailure[];
};

/**
 * Identifies the speakers of a transcript, chunk by chunk.
 *
 * A chunk that fails costs its own names only: a refusal is never retried, and
 * one such chunk must not leave a whole meeting without names. The failure is
 * logged with its reason and returned in failedChunks. Only when every chunk
 * fails does the call itself fail.
 */
export async function identifySpeakers(args: IdentifySpeakersArgs): Promise<IdentifySpeakersResult> {
    const {
        cityName, language, meetingDate, roster, segments,
        administrativeBodyName = null,
        knownSpeakers = [],
        model = DEFAULT_IDENTIFICATION_MODEL,
        effort = DEFAULT_IDENTIFICATION_EFFORT,
        chunkChars = DEFAULT_CHUNK_CHARS,
        concurrency = DEFAULT_CONCURRENCY,
        onChunkDone,
    } = args;

    const labels = labelsInOrder(segments);
    const chunks = chunkSegments(segments, chunkChars);
    const systemPrompt = buildSystemPrompt(language);
    const knownLabels = new Set(knownSpeakers.map(k => k.speakerLabel));
    console.log(`Identifying ${labels.length} speakers (${knownSpeakers.length} known) across ${chunks.length} chunk(s) with ${model} at ${effort} effort`);

    let usage = NO_USAGE;
    let done = 0;
    const chunkResults: ChunkIdentification[][] = new Array(chunks.length);
    const failedChunks: ChunkFailure[] = [];

    const identifyChunk = async (chunk: SpeakerSegmentInput[], index: number): Promise<ChunkIdentification[]> => {
        const userPrompt = buildUserPrompt({ cityName, administrativeBodyName, meetingDate, roster, knownSpeakers, chunkIndex: index, chunkCount: chunks.length, segments: chunk });
        const result = await aiChat<ChunkResponse>({
            model,
            label: `speaker-identification:${index + 1}/${chunks.length}`,
            systemPrompt,
            userPrompt,
            cacheSystemPrompt: true,
            maxTokens: IDENTIFICATION_MAX_TOKENS,
            effort,
            outputFormat: CHUNK_OUTPUT_FORMAT,
        });
        usage = addUsage(usage, result.usage);
        const chunkLabels = new Set(labelsInOrder(chunk).filter(l => !knownLabels.has(l)));
        return sanitizeChunkVerdicts(result.result.identifications ?? [], chunkLabels, roster);
    };

    const runChunk = async (chunk: SpeakerSegmentInput[], index: number) => {
        try {
            chunkResults[index] = await identifyChunk(chunk, index);
        } catch (error) {
            // A cancelled task stops. Any other failure costs this chunk's names only.
            if (isCancellation(error)) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`Speaker identification: chunk ${index + 1}/${chunks.length} failed, and its speakers get no name from it: ${reason}`);
            failedChunks.push({ chunk: index + 1, reason });
            chunkResults[index] = [];
        }
        done++;
        onChunkDone?.(done, chunks.length);
    };

    for (let i = 0; i < chunks.length; i += concurrency) {
        await Promise.all(chunks.slice(i, i + concurrency).map((chunk, j) => runChunk(chunk, i + j)));
    }

    if (chunks.length > 0 && failedChunks.length === chunks.length) {
        throw new Error(`Speaker identification failed on every chunk: ${failedChunks[0].reason}`);
    }
    failedChunks.sort((a, b) => a.chunk - b.chunk);

    return { result: mergeChunkIdentifications(chunkResults, labels, knownSpeakers), usage, failedChunks };
}
