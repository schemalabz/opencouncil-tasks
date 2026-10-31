import { describe, expect, it } from "vitest";
import { getBatchProcessingSystemPrompt } from "./prompts.js";

describe("summary output language", () => {
    const metadata = { cityName: "Sarajevo", date: "2026-10-28", topicLabels: [], administrativeBodyName: "Gradsko vijeće" };

    it("requests a translated issues heading for a language without custom wording", () => {
        const prompt = getBatchProcessingSystemPrompt({ ...metadata, cityLanguage: "bs" });
        expect(prompt).toContain("Bosnian");
        expect(prompt).toContain('localized heading meaning "Main issues"');
        expect(prompt).not.toContain("undefined");
        expect(prompt).not.toContain("«undefined»");
    });

    it("preserves the existing exact Greek heading", () => {
        const prompt = getBatchProcessingSystemPrompt({ ...metadata, cityLanguage: "el" });
        expect(prompt).toContain("«Κύρια ζητήματα»");
        expect(prompt).not.toContain('localized heading meaning "Main issues"');
    });
});
