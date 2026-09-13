/**
 * `oc-fusion-in/1` on stdin, `oc-fusion/1` on stdout. The TypeScript engine's
 * entry point, matching `fusion/fuse.py`'s command line exactly.
 *
 * It keeps the process boundary on purpose. The alignment is straight-line
 * cubic work, and running it inside the server would hold the event loop long
 * enough that the deadlines the fusion depends on would not fire. Keeping the
 * boundary also means the existing spawn path keeps its abort handling, its
 * output cap and its stderr tail: only the command changes.
 *
 * Exit codes match the Python: 0 success, 2 malformed input with a one-line
 * JSON error on stderr. Diagnostics never go to stdout.
 */
import path from "path";
import { fileURLToPath } from "url";
import { fuse, InputError, LlmNotSupportedError } from "./fuse.js";
import { loadPolicy, PolicyError } from "./policy.js";
import { pyJsonDumps } from "./pyjson.js";

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (c: Buffer) => chunks.push(c));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
    });
}

function fail(error: string, detail: string, limit: number): number {
    process.stderr.write(pyJsonDumps({ error, detail: detail.slice(0, limit) }, false) + "\n");
    return 2;
}

export async function main(engineDir?: string): Promise<number> {
    const raw = await readStdin();

    let payload: unknown;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        return fail("invalid JSON on stdin", String((e as Error).message), 200);
    }

    // `fusion/` holds `policy.json`, which stays byte-identical to the research
    // freeze and is hash-checked on load, so the TypeScript engine reads the
    // same file rather than keeping a second copy that could drift.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = engineDir ?? process.env.FUSION_ENGINE_DIR
        ?? path.resolve(here, "../../../../fusion");

    let out;
    try {
        out = fuse(payload, loadPolicy(dir));
    } catch (e) {
        if (e instanceof InputError) {
            return fail("malformed oc-fusion-in/1", (e as Error).message, 400);
        }
        if (e instanceof LlmNotSupportedError || e instanceof PolicyError) {
            return fail("engine cannot serve this request", (e as Error).message, 400);
        }
        throw e;
    }

    // Python writes this with `json.dump`, whose separators carry a space.
    // Matching them byte for byte costs nothing and makes the two engines
    // interchangeable for anything that hashes the raw output.
    process.stdout.write(pyJsonDumps(out, false) + "\n");
    return 0;
}

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    main().then((code) => { process.exitCode = code; }, (e) => {
        process.stderr.write(pyJsonDumps({ error: "engine crashed", detail: String(e).slice(0, 400) }, false) + "\n");
        process.exitCode = 1;
    });
}
