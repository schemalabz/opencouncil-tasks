import { describe, it, expect } from "vitest";
import { getLanguageConfig, DEFAULT_LANGUAGE, LANGUAGES, CITY_LANGUAGES, cityLanguageForScribeCode, isCityLanguage } from "./language.js";

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

    it("returns the Serbian config for 'sr'", () => {
        const sr = getLanguageConfig("sr");
        expect(sr.scribeCode).toBe("srp");
        expect(sr.promptName).toBe("Serbian");
        expect(sr.outputDirective).not.toBe("");
        expect(sr.defaultAdministrativeBodyName).toBe("Скупштина града");
    });

    it.each([
        ["de", "deu", "German", "Gemeinderat"],
        ["nl", "nld", "Dutch", "Gemeenteraad"],
        ["it", "ita", "Italian", "Consiglio comunale"],
        ["pl", "pol", "Polish", "Rada Gminy"],
        ["pt", "por", "Portuguese", "Assembleia Municipal"],
        ["es", "spa", "Spanish", "Pleno del Ayuntamiento"],
        ["fi", "fin", "Finnish", "Valtuusto"],
        ["ca", "cat", "Catalan", "Ple de l'Ajuntament"],
        ["sv", "swe", "Swedish", "Fullmäktige"],
        ["gl", "glg", "Galician", "Pleno do Concello"],
    ] as const)("returns the %s config with its own directive and correction notes", (language, scribeCode, promptName, body) => {
        const config = getLanguageConfig(language);
        expect(config.scribeCode).toBe(scribeCode);
        expect(config.promptName).toBe(promptName);
        expect(config.defaultAdministrativeBodyName).toBe(body);
        expect(config.outputDirective).not.toBe("");
        expect(config.fixTranscriptNotes).toContain(`Spoken ${promptName} in the record`);
    });

    it("gives every language a distinct Scribe code and directive", () => {
        const configs = CITY_LANGUAGES.map((language) => LANGUAGES[language]);
        expect(new Set(configs.map((c) => c.scribeCode)).size).toBe(configs.length);
        expect(new Set(configs.map((c) => c.outputDirective)).size).toBe(configs.length);
    });

    it("accepts exactly the registered languages", () => {
        for (const language of CITY_LANGUAGES) expect(isCityLanguage(language)).toBe(true);
        expect(isCityLanguage("xx")).toBe(false);
        expect(isCityLanguage("toString")).toBe(false);
    });

    it("maps each Scribe code back to its language", () => {
        for (const language of CITY_LANGUAGES) {
            expect(cityLanguageForScribeCode(LANGUAGES[language].scribeCode)).toBe(language);
        }
        expect(cityLanguageForScribeCode("eus")).toBe("eus");
    });

    it("defaults to Greek when the language is undefined (older clients)", () => {
        expect(getLanguageConfig(undefined)).toBe(LANGUAGES[DEFAULT_LANGUAGE]);
        expect(getLanguageConfig(undefined).scribeCode).toBe("ell");
    });
});
