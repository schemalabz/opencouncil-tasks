import { addUsage, aiChat, NO_USAGE, ResultWithUsage } from "../ai.js";
import { isCancellation } from "../taskControl.js";
import { foldLine, foldedWithOffsets } from "./text.js";
import { labelKey, type Boundary, type SectionText } from "./turns.js";

/**
 * The model check of the parser's turns.
 *
 * The label grammar is a guess from five documents. A cheap model reads the
 * section with the parser's turn starts marked and answers two questions:
 * which marked labels are not a speaker, and which turn starts the parser
 * missed. It names each by the label and the first words of the turn, never
 * by an offset; the code locates them in the text and drops what it cannot
 * find. The model never returns speech, so the text stays as printed.
 */

export const DEFAULT_CHECK_MODEL = "claude-haiku-5-5";
/** Characters of section text per model call. Greek runs at about 0.7 tokens per character, so this is 20–30K tokens. */
export const CHECK_CHUNK_CHARS = 35_000;
/** Characters of the previous chunk repeated at the start of the next, so a turn cut by the chunk edge is seen whole once. */
export const CHECK_OVERLAP_CHARS = 1_000;
const CHECK_MAX_TOKENS = 8_000;
const CHECK_CONCURRENCY = 3;
const TURN_MARK = "⟦T⟧ ";

export type CheckAnswer = { label: string; firstWords: string };
export type CheckResponse = { notSpeakers: CheckAnswer[]; missedTurns: CheckAnswer[] };

const CHECK_SCHEMA = {
    type: "object" as const,
    properties: {
        notSpeakers: {
            type: "array",
            items: { type: "object", properties: { label: { type: "string" }, firstWords: { type: "string" } }, required: ["label", "firstWords"], additionalProperties: false },
        },
        missedTurns: {
            type: "array",
            items: { type: "object", properties: { label: { type: "string" }, firstWords: { type: "string" } }, required: ["label", "firstWords"], additionalProperties: false },
        },
    },
    required: ["notSpeakers", "missedTurns"],
    additionalProperties: false,
};

export const CHECK_SYSTEM_PROMPT = `You check how a program cut the verbatim minutes (πρακτικά) of a Greek municipal council meeting into speaker turns.

The minutes print each turn as a label and a colon at the start of a line, then the speech: "ΠΡΟΕΔΡΟΣ: ...", "Κ. ΤΟΜΠΟΥΛΟΓΛΟΥ: ...", "κα Κανατσίδη: ...", "ΔΑΡΔΑΜΑΝΕΛΗΣ Θ. (ΑΝΤΙΔΗΜΑΡΧΟΣ): ...". The program marked every line where it starts a turn with "${TURN_MARK.trim()}" in front of the label. You receive one chunk of the minutes with these marks.

Answer two questions:
1. notSpeakers: marked labels that are NOT a speaker of the meeting. Examples: "ΘΕΜΑ 3ο", "ΜΕΙΟΝ", "ΣΥΝΟΛΟ", "Παρόντες", "Ειδικότερα", a heading of a pasted decision, a field of a form, a table row. A role word ("ΠΡΟΕΔΡΟΣ", "ΔΗΜΑΡΧΟΣ", "ΓΡΑΜΜΑΤΕΑΣ", "ΣΥΜΒΟΥΛΟΣ") or a person's name is a speaker, also on a cover page.
2. missedTurns: lines where a new speaker starts to speak with a label and a colon, and the program did NOT mark it. Do not report a line without a label, and do not report a label the program already marked.

For each item give "label" exactly as printed before the colon (without the colon) and "firstWords": the first five words printed after the colon, exactly as printed. Return nothing else: no speech, no offsets, no corrections. When there is nothing to report, return empty lists.`;

export function buildCheckUserPrompt(chunkText: string, chunkIndex: number, chunkCount: number): string {
    return `Chunk ${chunkIndex + 1} of ${chunkCount} of the minutes, with the program's turn starts marked:\n\n${chunkText}`;
}

export type Chunk = { start: number; end: number };

/** Chunks of the section text, cut at line ends, each starting a little before the previous one ended. */
export function chunkSection(text: string, chunkChars = CHECK_CHUNK_CHARS, overlapChars = CHECK_OVERLAP_CHARS): Chunk[] {
    const chunks: Chunk[] = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(text.length, start + chunkChars);
        if (end < text.length) {
            const newline = text.lastIndexOf("\n", end);
            if (newline > start + chunkChars / 2) end = newline + 1;
        }
        chunks.push({ start, end });
        if (end >= text.length) break;
        const back = text.lastIndexOf("\n", Math.max(start, end - overlapChars));
        start = back > start ? back + 1 : end;
    }
    return chunks;
}

/** The chunk's text with the parser's turn starts marked for the model. */
export function markChunk(text: string, chunk: Chunk, boundaries: Boundary[]): string {
    const inside = boundaries.filter(b => b.offset >= chunk.start && b.offset < chunk.end).sort((a, b) => a.offset - b.offset);
    let out = "";
    let cursor = chunk.start;
    for (const b of inside) {
        out += text.slice(cursor, b.offset) + TURN_MARK;
        cursor = b.offset;
    }
    return out + text.slice(cursor, chunk.end);
}

/** The first words of a text in comparison form: folded, punctuation removed. The model's copy of them drops a comma or a full stop. */
const firstWordsKey = (text: string, count = 3): string =>
    foldLine(text).replace(/[^\p{L}\p{N}\s]+/gu, "").split(/\s+/).filter(Boolean).slice(0, count).join(" ");

/**
 * The boundary the model means by a label and the first words of its turn,
 * among the parser's boundaries in the chunk; null when none fits. The first
 * words disambiguate a label that recurs («ΠΡΟΕΔΡΟΣ»): the first three must agree.
 */
export function locateBoundary(text: string, chunk: Chunk, boundaries: Boundary[], answer: CheckAnswer): Boundary | null {
    const label = answer.label.replace(/:\s*$/, "");
    const wanted = firstWordsKey(answer.firstWords);
    for (const b of boundaries) {
        if (b.offset < chunk.start || b.offset >= chunk.end) continue;
        if (b.key !== labelKey(label) && foldLine(b.label) !== foldLine(label)) continue;
        const spoken = firstWordsKey(text.slice(b.labelEnd, b.labelEnd + 200));
        if (wanted === "" || spoken.startsWith(wanted) || wanted.startsWith(spoken)) return b;
    }
    return null;
}

/**
 * Where in the chunk a missed turn starts: the label at the start of a line,
 * an optional colon, then the first words. Returns the new boundary, or null
 * when the text holds no such line.
 */
export function locateMissedTurn(text: string, chunk: Chunk, answer: CheckAnswer): Boundary | null {
    const label = answer.label.replace(/:\s*$/, "").trim();
    if (!label || label.length > 80) return null;
    const { folded, offsets } = foldedWithOffsets(text.slice(chunk.start, chunk.end));
    const needle = foldLine(label);
    const words = firstWordsKey(answer.firstWords);
    let from = 0;
    while (from <= folded.length) {
        const at = folded.indexOf(needle, from);
        if (at < 0) return null;
        from = at + 1;
        if (at > 0 && folded[at - 1] !== "\n") continue;
        const afterLabel = at + needle.length;
        const rest = folded.slice(afterLabel, afterLabel + 240);
        const colon = /^\s*:?\s*/.exec(rest)![0];
        const speech = firstWordsKey(rest.slice(colon.length), 40);
        if (words && !speech.startsWith(words)) continue;
        const offset = chunk.start + offsets[at];
        const labelEnd = chunk.start + (offsets[afterLabel + colon.length] ?? offsets[offsets.length - 1] + 1);
        return { offset, labelEnd, label, key: labelKey(label) };
    }
    return null;
}

export type CheckOutcome = {
    boundaries: Boundary[];
    added: number;
    removed: number;
    dropped: number;
    failedChunks: number;
};

export type CheckOptions = {
    model?: string;
    chunkChars?: number;
    concurrency?: number;
    onChunkDone?: (done: number, total: number) => void;
};

/** Applies the model's answers to the parser's boundaries. Exported for the tests; checkTurns calls the model. */
export function applyCheckAnswers(section: SectionText, boundaries: Boundary[], chunks: Chunk[], answers: (CheckResponse | null)[]): CheckOutcome {
    const removedOffsets = new Set<number>();
    const added = new Map<number, Boundary>();
    let dropped = 0;
    let failedChunks = 0;
    const existing = new Set(boundaries.map(b => b.offset));

    chunks.forEach((chunk, i) => {
        const answer = answers[i];
        if (!answer) {
            failedChunks++;
            return;
        }
        for (const item of answer.notSpeakers ?? []) {
            const found = locateBoundary(section.text, chunk, boundaries, item);
            if (found) removedOffsets.add(found.offset);
            else dropped++;
        }
        for (const item of answer.missedTurns ?? []) {
            const found = locateMissedTurn(section.text, chunk, item);
            if (!found) dropped++;
            else if (!existing.has(found.offset) && !added.has(found.offset)) added.set(found.offset, found);
        }
    });

    const kept = boundaries.filter(b => !removedOffsets.has(b.offset));
    return {
        boundaries: [...kept, ...added.values()].sort((a, b) => a.offset - b.offset),
        added: added.size,
        removed: removedOffsets.size,
        dropped,
        failedChunks,
    };
}

/**
 * Runs the check. A chunk whose call fails changes nothing in its range and is
 * counted; the parser's boundaries stand there. A cancelled task stops.
 */
export async function checkTurns(section: SectionText, boundaries: Boundary[], options: CheckOptions = {}): Promise<ResultWithUsage<CheckOutcome>> {
    const model = options.model ?? DEFAULT_CHECK_MODEL;
    const chunks = chunkSection(section.text, options.chunkChars ?? CHECK_CHUNK_CHARS);
    const answers: (CheckResponse | null)[] = new Array(chunks.length).fill(null);
    let usage = NO_USAGE;
    let done = 0;

    const run = async (i: number) => {
        const userPrompt = buildCheckUserPrompt(markChunk(section.text, chunks[i], boundaries), i, chunks.length);
        try {
            const result = await aiChat<CheckResponse>({
                model,
                label: `minutes-turn-check:${i + 1}/${chunks.length}`,
                systemPrompt: CHECK_SYSTEM_PROMPT,
                userPrompt,
                cacheSystemPrompt: true,
                maxTokens: CHECK_MAX_TOKENS,
                outputFormat: { type: "json_schema", schema: CHECK_SCHEMA },
            });
            usage = addUsage(usage, result.usage);
            answers[i] = result.result;
        } catch (error) {
            if (isCancellation(error)) throw error;
            console.error(`Minutes turn check: chunk ${i + 1}/${chunks.length} failed; the parser's turns stand there: ${error instanceof Error ? error.message : String(error)}`);
        }
        done++;
        options.onChunkDone?.(done, chunks.length);
    };

    const concurrency = options.concurrency ?? CHECK_CONCURRENCY;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
        while (next < chunks.length) await run(next++);
    }));

    return { result: applyCheckAnswers(section, boundaries, chunks, answers), usage };
}
