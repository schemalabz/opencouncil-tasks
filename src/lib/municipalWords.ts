import { IMPORTANCE_GUIDELINES } from "./importanceGuidelines.js";

// Test support: the tests of the region prompts read a prompt with these.

/**
 * The words of a municipality. A whole word for «δήμος» and for "city", because
 * «δημόσιος», «ΔΗΜΟΣΙΕΥΣΗ» and "capacity" are not about a municipality.
 */
const MUNICIPAL_WORDS = /(?<!\p{L})δ[ηή]μ(ος|ου|ο|οι|ων|ους)(?!\p{L})|δημοτικ|δ[ηή]μ[αά]ρχ|municipal|mayor|(?<!\p{L})city(?!\p{L})/giu;

/**
 * The text that stays municipal on purpose (schemalabz/opencouncil-tasks#124):
 * - the importance guidelines, which are the notification work of the main app;
 * - `municipality`, the name of a field that opencouncil reads;
 * - «δημοτικά σχολεία», which are primary schools.
 */
export function municipalWordsIn(prompt: string): string[] {
    const checked = prompt
        .replace(IMPORTANCE_GUIDELINES, "")
        .replace(/^municipality:/gm, "")
        .replace(/δημοτικά σχολεία/g, "");
    return [...checked.matchAll(MUNICIPAL_WORDS)].map(match => checked.slice(Math.max(0, match.index - 40), match.index + 40));
}
