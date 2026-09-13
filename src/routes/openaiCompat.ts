import express from "express";
import multer from "multer";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { artifactFromFile, getFusionRuntime, type FusionRuntime } from "../lib/fusion/index.js";
import { FUSION_MODELS, isPolicyModel, type FusionModel } from "../lib/fusion/FusionTranscriber.js";
import { MAX_AUDIO_BYTES } from "../lib/fusion/audio.js";
import { FusionEngineError, ScribeUnavailableError } from "../lib/fusion/types.js";

/**
 * OpenAI-compatible `POST /v1/audio/transcriptions`.
 *
 * It exists because the benchmark harness speaks this protocol, and it is a
 * deliberately thin adapter over `FusionTranscriber` — the same implementation
 * `transcribe.ts` uses. Two surfaces over one implementation; never two
 * implementations that agree today.
 *
 * The route is mounted only when FUSION_OPENAI_ROUTE=on, and it inherits the
 * app-wide bearer auth middleware; it adds no auth of its own.
 */

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
            fsp.mkdtemp(path.join(os.tmpdir(), "oc-fusion-upload-"))
                .then((dir) => cb(null, dir))
                .catch((error) => cb(error, ""));
        },
        filename: (_req, file, cb) => cb(null, `audio${path.extname(file.originalname) || ".bin"}`),
    }),
    limits: { fileSize: MAX_AUDIO_BYTES },
});

export function createOpenAiCompatRouter(rt: FusionRuntime = getFusionRuntime()): express.Router {
    const router = express.Router();

    router.post("/audio/transcriptions", upload.single("file"), async (req, res) => {
        const requestId = crypto.randomUUID();
        const filePath = req.file?.path;

        const cleanup = async () => {
            if (!filePath) return;
            await fsp.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => { });
        };

        try {
            if (!filePath) {
                return res.status(400).json({ error: { message: "file is required", type: "invalid_request_error" } });
            }

            const model = String(req.body.model ?? "");
            if (!FUSION_MODELS.includes(model as FusionModel)) {
                return res.status(400).json({
                    error: { message: `model must be one of ${FUSION_MODELS.join(", ")}`, type: "invalid_request_error", param: "model" },
                });
            }
            if (isPolicyModel(model as FusionModel) && rt.config.llm !== "on") {
                // A stable, non-retryable refusal: the LLM chooser is off in
                // production by decision 13, and a request cannot switch it on.
                return res.status(400).json({
                    error: { message: `model ${model} is unavailable: the LLM chooser is disabled (FUSION_LLM=off)`, type: "model_disabled", param: "model" },
                });
            }

            const language = req.body.language === undefined ? "el" : String(req.body.language);
            if (language !== "el") {
                return res.status(400).json({
                    error: { message: "only language=el is supported", type: "invalid_request_error", param: "language" },
                });
            }

            const responseFormat = req.body.response_format;
            if (responseFormat !== undefined && responseFormat !== "json") {
                return res.status(400).json({
                    error: { message: "only response_format=json is supported", type: "invalid_request_error", param: "response_format" },
                });
            }

            // A client that hangs up must take its providers down with it —
            // three recognisers billing for an abandoned request is the exact
            // double-charge the failure contract forbids.
            const controller = new AbortController();
            req.on("aborted", () => controller.abort(new Error("client disconnected")));

            const audio = await artifactFromFile(filePath);
            res.setHeader("x-oc-audio-sha256", audio.sha256);
            res.setHeader("x-oc-request-id", requestId);

            const result = await rt.transcriberFor("el").fuseSegment({
                audio,
                model: model as FusionModel,
                language: "el",
                label: `openai-compat ${audio.sha256.slice(0, 12)}`,
                requestId,
                signal: controller.signal,
            });

            return res.json({ text: result.transcript.transcription.full_transcript });
        } catch (error) {
            if (error instanceof ScribeUnavailableError) {
                // Spec §4.5: the bench route has no fallback when Scribe fails.
                return res.status(502).json({ error: { message: error.message, type: "provider_error", code: error.reason } });
            }
            if (error instanceof FusionEngineError) {
                return res.status(500).json({ error: { message: error.message, type: "fusion_error", code: error.reason } });
            }
            console.error(`[fusion] ${requestId}: request failed`, error);
            return res.status(500).json({ error: { message: error instanceof Error ? error.message : "transcription failed", type: "server_error" } });
        } finally {
            await cleanup();
        }
    });

    return router;
}

/**
 * The mount rule lives here, not in server.ts: a benchmark-only surface that
 * could be switched on from two places would eventually be on in one of them.
 * Returns whether it mounted.
 */
export function mountOpenAiCompatRoute(app: express.Application, rt: FusionRuntime = getFusionRuntime()): boolean {
    if (rt.config.openaiRoute !== "on") return false;
    app.use("/v1", createOpenAiCompatRouter(rt));
    return true;
}

export default createOpenAiCompatRouter;
