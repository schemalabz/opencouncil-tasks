import { describe, it, expect } from "vitest";
import { getLanguageConfig, DEFAULT_LANGUAGE, LANGUAGES } from "./language.js";

describe("getLanguageConfig", () => {
    it("returns the Greek config for 'el'", () => {
        expect(getLanguageConfig("el").scribeCode).toBe("ell");
        expect(getLanguageConfig("el").outputDirective).toBe("");
    });

    it("returns the French config for 'fr'", () => {
        const fr = getLanguageConfig("fr");
        expect(fr.scribeCode).toBe("fra");
        expect(fr.promptName).toBe("French");
        expect(fr.outputDirective).not.toBe("");
        expect(fr.defaultAdministrativeBodyName).toBe("Conseil Municipal");
    });

    it("defaults to Greek when the language is undefined (older clients)", () => {
        expect(getLanguageConfig(undefined)).toBe(LANGUAGES[DEFAULT_LANGUAGE]);
        expect(getLanguageConfig(undefined).scribeCode).toBe("ell");
    });
});
