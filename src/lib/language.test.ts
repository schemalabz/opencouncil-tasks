import { describe, it, expect } from "vitest";
import { getLanguageConfig, DEFAULT_LANGUAGE, LANGUAGES, CUSTOMIZED_LANGUAGES, cityLanguageForScribeCode, isCityLanguage } from "./language.js";

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
        const configs = CUSTOMIZED_LANGUAGES.map((language) => LANGUAGES[language]);
        expect(new Set(configs.map((c) => c.scribeCode)).size).toBe(configs.length);
        expect(new Set(configs.map((c) => c.outputDirective)).size).toBe(configs.length);
    });

    it("accepts the existing customized languages and rejects invalid identifiers", () => {
        for (const language of CUSTOMIZED_LANGUAGES) expect(isCityLanguage(language)).toBe(true);
        expect(isCityLanguage("xx")).toBe(false);
        expect(isCityLanguage("toString")).toBe(false);
    });

    it("maps each Scribe code back to its language", () => {
        for (const language of CUSTOMIZED_LANGUAGES) {
            expect(cityLanguageForScribeCode(LANGUAGES[language].scribeCode)).toBe(language);
        }
        expect(cityLanguageForScribeCode("eus")).toBe("eu");
        expect(cityLanguageForScribeCode("zzz")).toBe("zzz");
    });

    it("defaults to Greek when the language is undefined (older clients)", () => {
        expect(getLanguageConfig(undefined)).toBe(LANGUAGES[DEFAULT_LANGUAGE]);
        expect(getLanguageConfig(undefined).scribeCode).toBe("ell");
    });
});


describe("languages without custom configuration", () => {
    it.each([
        ["bs", "Bosnian"], ["hr", "Croatian"], ["uk", "Ukrainian"],
        ["ar", "Arabic"], ["ja", "Japanese"], ["eu", "Basque"],
        ["cy", "Welsh"], ["sq", "Albanian"],
    ])("configures %s without adding a registry entry", (code, name) => {
        expect(LANGUAGES).not.toHaveProperty(code);
        expect(isCityLanguage(code)).toBe(true);
        const config = getLanguageConfig(code);
        expect(config.promptName).toBe(name);
        expect(config.scribeCode).toBe(code);
        expect(config.outputDirective).toContain(name);
        expect(config.fixTranscriptNotes).toContain(`Spoken ${name} in the record`);
        expect(config.fixTranscriptNotes).toContain("never transliterate");
        expect(config.mainIssuesHeading).toBeUndefined();
    });

    it("normalizes ISO language aliases without custom lookup tables", () => {
        expect(getLanguageConfig("bos")).toEqual(getLanguageConfig("bs"));
        expect(getLanguageConfig("fra")).toBe(LANGUAGES.fr);
        expect(cityLanguageForScribeCode("bos")).toBe("bs");
        expect(cityLanguageForScribeCode("ukr")).toBe("uk");
    });

    it("retains region and script in the output language while using a base ASR code", () => {
        const brazil = getLanguageConfig("pt-BR");
        expect(brazil.scribeCode).toBe("pt");
        expect(brazil.promptName).toContain("Brazil");
        expect(getLanguageConfig("sr-Latn").promptName).toContain("Latin");
    });

    it.each(["xx", "qaa", "not-a-language", "toString", "constructor", "und", ""])("rejects %s instead of falling back to Greek", (code) => {
        expect(isCityLanguage(code)).toBe(false);
        expect(() => getLanguageConfig(code)).toThrow();
    });
});
