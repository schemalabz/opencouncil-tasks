import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { RawTranscriptLog, type RawTranscriptAttempt } from "./rawLog.js";
import type { NormalizedWord, ProviderId } from "./types.js";

/**
 * The raw log is the only place the three per-system word streams survive, and
 * the one place in this codebase whose whole content is transcript text. So the
 * tests are about two things: that a record is complete enough to be worth
 * keeping, and that nothing about it can leak or explode.
 *
 * Every word below is synthetic. Real council speech never enters a fixture.
 */

const words = (...raws: string[]): NormalizedWord[] =>
    raws.map((raw, i) => ({ raw, start: i * 0.5, end: i * 0.5 + 0.4, conf: 0.9 }));

const stream = (id: ProviderId, raws: string[]) => ({
    providerId: id,
    status: "ok" as const,
    model: `${id}-model`,
    paramsSha: `${id}-params`,
    schemaRev: `${id}/1`,
    rawSha256: `${id}-raw-sha`,
    words: words(...raws),
});

const attempt = (overrides: Partial<RawTranscriptAttempt> = {}): RawTranscriptAttempt => ({
    attemptId: "11111111-2222-3333-4444-555555555555",
    audioSha256: "a".repeat(64),
    label: "segment 3/12 @ 00:12:34",
    mode: "on",
    arm: "rules",
    engineRev: "abcdef0123456789",
    configSha: "0123456789abcdef",
    outcome: "fused",
    systems: [
        stream("scribe", ["Ζορμπαλάς", "μιλάει"]),
        stream("soniox", ["Ζορμπαλας", "μιλάει"]),
        stream("ours", ["Ζορμπαλάς", "μιλά"]),
    ],
    ...overrides,
});

let dir: string;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-rawlog-test-"));
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function readOnly(logDir: string): unknown[] {
    if (!fs.existsSync(logDir)) return [];
    return fs.readdirSync(logDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(logDir, name), "utf8")));
}

describe("RawTranscriptLog when it is not configured", () => {
    it("writes nothing and creates no directory", async () => {
        const logDir = path.join(dir, "never");
        const log = new RawTranscriptLog(undefined);

        expect(log.enabled).toBe(false);
        expect(await log.write(attempt())).toBe(false);
        expect(fs.existsSync(logDir)).toBe(false);
    });

    it("treats an empty string as unconfigured, not as the current directory", async () => {
        const log = new RawTranscriptLog("");
        expect(log.enabled).toBe(false);
        expect(await log.write(attempt())).toBe(false);
    });
});

describe("RawTranscriptLog record", () => {
    it("keeps every provider's word stream, verbatim and in order", async () => {
        const log = new RawTranscriptLog(dir);
        expect(await log.write(attempt())).toBe(true);

        const records = readOnly(dir) as any[];
        expect(records).toHaveLength(1);
        const record = records[0];

        expect(record.schema).toBe("oc-fusion-raw/1");
        expect(record.attemptId).toBe("11111111-2222-3333-4444-555555555555");
        expect(record.audioSha256).toBe("a".repeat(64));
        expect(record.outcome).toBe("fused");
        expect(record.arm).toBe("rules");
        expect(record.mode).toBe("on");
        expect(record.engineRev).toBe("abcdef0123456789");
        expect(record.label).toBe("segment 3/12 @ 00:12:34");
        expect(typeof record.createdAt).toBe("string");
        expect(record.wordTimebase).toBe("segment-relative");

        expect(record.systems.map((s: any) => s.providerId)).toEqual(["scribe", "soniox", "ours"]);
        expect(record.systems[0].words).toEqual(words("Ζορμπαλάς", "μιλάει"));
        expect(record.systems[0].wordCount).toBe(2);
        expect(record.systems[2].words[1].raw).toBe("μιλά");
    });

    it("names the file after the audio hash and the attempt id, never after any word", async () => {
        const log = new RawTranscriptLog(dir);
        await log.write(attempt());

        const [name] = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
        expect(name).toBe(`${"a".repeat(64)}.11111111-2222-3333-4444-555555555555.json`);
        // No temp file survives a successful write.
        expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
    });

    it("records a provider that produced nothing without discarding the ones that did", async () => {
        const log = new RawTranscriptLog(dir);
        await log.write(attempt({
            outcome: "scribe-fallback",
            systems: [
                stream("scribe", ["Ζορμπαλάς", "μιλάει"]),
                { providerId: "soniox", status: "failed" },
                { providerId: "ours", status: "empty", model: "ours-model", paramsSha: "ours-params", schemaRev: "ours/1", rawSha256: "ours-raw-sha", words: [] },
            ],
        }));

        const [record] = readOnly(dir) as any[];
        expect(record.outcome).toBe("scribe-fallback");
        expect(record.systems[0].words).toHaveLength(2);
        expect(record.systems[1]).toEqual({ providerId: "soniox", status: "failed", wordCount: 0 });
        expect(record.systems[2].status).toBe("empty");
        expect(record.systems[2].wordCount).toBe(0);
    });

    it("carries no provider error text and no raw provider response", async () => {
        const log = new RawTranscriptLog(dir);
        await log.write(attempt({
            outcome: "failed",
            systems: [
                // A caller handing over extra fields must not be able to widen
                // the record: a vendor error can carry a signed URL or a key.
                {
                    ...stream("scribe", ["Ζορμπαλάς"]),
                    ...({ error: "401 from https://vendor/x?token=SECRET", raw: { text: "Ζορμπαλάς μιλάει" } } as any),
                },
            ],
        }));

        const serialized = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
        expect(serialized).not.toContain("SECRET");
        expect(serialized).not.toContain("token=");
        expect(serialized).not.toContain("\"error\"");
        // The joined form only exists inside the provider's raw response, so
        // its absence is what proves the raw response was not copied through.
        expect(serialized).not.toContain("Ζορμπαλάς μιλάει");
        // The word stream itself is of course still there — that is the point.
        expect(JSON.parse(serialized).systems[0].words[0].raw).toBe("Ζορμπαλάς");
    });
});

describe("RawTranscriptLog under load and failure", () => {
    it("writes one complete file per concurrent attempt", async () => {
        const log = new RawTranscriptLog(dir);
        const attempts = Array.from({ length: 12 }, (_v, i) => attempt({
            attemptId: `attempt-${i}`,
            audioSha256: String(i).padStart(64, "b"),
            systems: [stream("scribe", [`λέξη${i}`, `δεύτερη${i}`])],
        }));

        const outcomes = await Promise.all(attempts.map((a) => log.write(a)));
        expect(outcomes.every(Boolean)).toBe(true);

        const records = readOnly(dir) as any[];
        expect(records).toHaveLength(12);
        // Every file parsed, so none was half-written or interleaved.
        expect(new Set(records.map((r) => r.attemptId)).size).toBe(12);
        for (const record of records) {
            expect(record.systems[0].words).toHaveLength(2);
        }
    });

    it("returns false and does not throw when the directory cannot be written", async () => {
        // A file where the directory should be: mkdir fails, the write fails,
        // and the transcription that triggered it must not notice.
        const blocked = path.join(dir, "blocked");
        await fsp.writeFile(blocked, "not a directory", "utf8");

        const log = new RawTranscriptLog(path.join(blocked, "raw"));
        await expect(log.write(attempt())).resolves.toBe(false);
    });

    it("warns without quoting the payload when a write fails", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const blocked = path.join(dir, "blocked2");
        await fsp.writeFile(blocked, "not a directory", "utf8");

        await new RawTranscriptLog(path.join(blocked, "raw")).write(attempt());

        expect(warn).toHaveBeenCalled();
        const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
        expect(message).not.toContain("Ζορμπαλάς");
        expect(message).not.toContain("μιλάει");
    });

    it("marks an oversized record instead of silently shortening it", async () => {
        const log = new RawTranscriptLog(dir, { maxBytes: 2_000 });
        const long = Array.from({ length: 500 }, (_v, i) => `λέξη${i}`);
        expect(await log.write(attempt({ systems: [stream("scribe", long)] }))).toBe(true);

        const [record] = readOnly(dir) as any[];
        expect(record.omitted).toBe("record_too_large");
        expect(record.systems[0].words).toBeUndefined();
        // The counts survive even when the words do not, so the loss is visible.
        expect(record.systems[0].wordCount).toBe(500);
        expect(record.systems[0].rawSha256).toBe("scribe-raw-sha");
    });

    it("keeps a normal-sized record whole", async () => {
        const log = new RawTranscriptLog(dir, { maxBytes: 32 * 1024 * 1024 });
        await log.write(attempt());
        const [record] = readOnly(dir) as any[];
        expect(record.omitted).toBeUndefined();
        expect(record.systems[0].words).toHaveLength(2);
    });
});
