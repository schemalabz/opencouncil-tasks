import { describe, it, expect } from "vitest";
import { loadFusionConfig, FusionConfigError } from "./config.js";

const base = (overrides: Partial<Record<string, string>> = {}) => loadFusionConfig({ ...overrides }, "/repo");

describe("loadFusionConfig", () => {
    it("defaults every capability to off when nothing is set", () => {
        const config = base();
        expect(config.mode).toBe("off");
        expect(config.llm).toBe("off");
        expect(config.openaiRoute).toBe("off");
        expect(config.canaryPercent).toBe(0);
        expect(config.deadlineMs).toBe(240_000);
        expect(config.pythonBin).toBe("python3");
    });

    it("throws on an invalid FUSION_MODE instead of silently meaning off", () => {
        expect(() => base({ FUSION_MODE: "shadowy" })).toThrow(FusionConfigError);
    });

    it("throws on a canary percentage outside 0..100", () => {
        expect(() => base({ FUSION_CANARY_PERCENT: "150" })).toThrow(FusionConfigError);
        expect(() => base({ FUSION_CANARY_PERCENT: "5.5" })).toThrow(FusionConfigError);
    });

    it("reads the enabled combination", () => {
        const config = base({ FUSION_MODE: "on", FUSION_LLM: "on", FUSION_OPENAI_ROUTE: "on", FUSION_CANARY_PERCENT: "10" });
        expect(config).toMatchObject({ mode: "on", llm: "on", openaiRoute: "on", canaryPercent: 10 });
    });
});
