/**
 * Central registry for content-language-dependent behavior.
 *
 * `cityLanguage` (sent by the frontend on task requests) selects one of these
 * configs, which is the single home for every value that differs between
 * languages: the ASR language code, and the language-specific snippets injected
 * into otherwise-shared LLM prompts.
 *
 * Strategy: prompt bodies stay in their original language (Greek, or English for
 * fixTranscript). For non-Greek cities we keep that structural body and inject
 * `outputDirective` to force the output language; only genuinely
 * language-specific values (ASR code, default body name, fallback strings, the
 * fixTranscript correction examples) are swapped wholesale.
 */
import { CityLanguage } from "../types.js";

export const DEFAULT_LANGUAGE: CityLanguage = 'el';

export interface LanguageConfig {
    /** ISO-639-3 code sent to ElevenLabs Scribe (e.g. 'ell', 'fra'). */
    scribeCode: string;
    /** Human name of the language, used inline in prompt prose ("Greek", "French"). */
    promptName: string;
    /**
     * Directive appended to Greek-bodied LLM system prompts to force the output
     * language. Empty for Greek (the prompt body is already Greek); a strong
     * instruction for other languages.
     */
    outputDirective: string;
    /** Fallback administrative-body name when the request omits one. */
    defaultAdministrativeBodyName: string;
    /** Localized fallback shown when a speaker-contribution summary fails. */
    summaryErrorText: string;
    /**
     * Language-specific "WHAT TO FIX / WHAT NOT TO TOUCH" block for the
     * fixTranscript system prompt. The correction examples are inherently
     * orthography-specific, so this whole block is swapped per language.
     */
    fixTranscriptNotes: string;
}

const EL_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

1. NAMES — the most common error. The speech-to-text often misspells names phonetically (e.g. «Ρημάκης» for «Δημάκης», «Ξυδαροπούλου» for «Ξηνταροπούλου»). Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.

2. HOMOPHONE MISSPELLINGS — same sound, wrong letters: «απόν»→«απών», «πολεδομία»→«πολεοδομία», «κλιματολόγιο»→«κτηματολόγιο» (context: land registry), «ονομάδων»→«ονομάτων», ο/ω, η/ι/υ, αι/ε confusions. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «τριακοστή πέμπτη συνεδρίαση»→«35η συνεδρίαση», «πέντε Δεκεμβρίου του 2025»→«05/12/2025» for full dates, «άρθρο εβδομήντα πέντε»→«άρθρο 75». Money and percentages also as digits («2,5 εκατομμύρια ευρώ», «15%»).

4. Greek punctuation and accents: «;» for questions (never «?»), proper τόνοι («Μαρια;»→«Μαρία;»), capitalize proper nouns normally («ΖΕΜΕΝΟ»→«Ζεμενό»).

WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices («γραφούν» stays «γραφούν», not «εγγραφούν»). Spoken Greek in the record stays spoken Greek, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers («ναι ναι», «το γράψατε;») — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

const FR_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

1. NAMES — the most common error. The speech-to-text often misspells names phonetically. Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.

2. HOMOPHONE MISSPELLINGS — same sound, wrong letters; French has many: «a»/«à», «ou»/«où», «ces»/«ses»/«c'est», «et»/«est», «on»/«ont», «son»/«sont», «-er»/«-é»/«-ez» verb endings, «quel»/«quelle»/«qu'elle». Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trente-cinquième séance»→«35e séance», «cinq décembre deux mille vingt-cinq»→«05/12/2025» for full dates, «article soixante-quinze»→«article 75». Money and percentages also as digits («2,5 millions d'euros», «15 %»).

4. French punctuation and accents: restore accents (é/è/ê/à/ù/ç), use apostrophes for elision («l'ordre», «d'urbanisme», «qu'il»), French quotation marks « … » with non-breaking spaces, and a space before « ; : ? ! ». Capitalize proper nouns normally.

WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices. Spoken French in the record stays spoken French, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers («oui oui», «vous l'avez noté ?») — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

const FR_OUTPUT_DIRECTIVE = `**LANGUE DE SORTIE — RÉDIGE EN FRANÇAIS.** Tout le texte que tu génères (noms et descriptions des sujets, résumés, contributions, tout texte libre) DOIT être rédigé en français, même si les instructions ci-dessus sont en grec. Suis les conventions françaises : utilise « M./Mme » devant les noms de famille (jamais « κ./κα. »), les guillemets français « … » et la ponctuation française. Ne produis aucun texte en grec.`;

export const LANGUAGES: Record<CityLanguage, LanguageConfig> = {
    el: {
        scribeCode: 'ell',
        promptName: 'Greek',
        outputDirective: '',
        defaultAdministrativeBodyName: 'Δημοτικό Συμβούλιο',
        summaryErrorText: 'Σφάλμα κατά τη δημιουργία περίληψης.',
        fixTranscriptNotes: EL_FIX_TRANSCRIPT_NOTES,
    },
    fr: {
        scribeCode: 'fra',
        promptName: 'French',
        outputDirective: FR_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Conseil Municipal',
        summaryErrorText: 'Erreur lors de la génération du résumé.',
        fixTranscriptNotes: FR_FIX_TRANSCRIPT_NOTES,
    },
};

/**
 * Resolve a language's config, defaulting to Greek when the field is missing —
 * a defensive fallback for older clients that omit `cityLanguage`.
 */
export function getLanguageConfig(language: CityLanguage | undefined): LanguageConfig {
    return LANGUAGES[language ?? DEFAULT_LANGUAGE] ?? LANGUAGES[DEFAULT_LANGUAGE];
}

/**
 * The output-language directive formatted for appending to the end of a prompt:
 * a leading blank line plus the directive, or an empty string for the default
 * language (which needs no directive). Keeps the `\n\n` convention in one place.
 */
export function languageDirectiveSuffix(language: CityLanguage | undefined): string {
    const { outputDirective } = getLanguageConfig(language);
    return outputDirective ? `\n\n${outputDirective}` : '';
}
