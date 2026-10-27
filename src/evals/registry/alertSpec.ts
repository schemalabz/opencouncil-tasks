/**
 * The structured part of a failure mode's `alert:` text. The text stays the source of
 * truth for people; what the grammar below recognises becomes platform objects, and every
 * clause it does not recognise is kept verbatim as a manual step.
 */
export type AlertSpec = {
    text: string;
    /** `rate`: the fail rate against a baseline. `any`: a single fail is enough. */
    kind?: 'rate' | 'any';
    /** "> 2× its 30-day baseline" */
    factor?: number;
    baselineDays?: number;
    /** "over 7 days", "per week" */
    windowDays?: number;
    /** "min 50 subject-context-search calls" */
    minVolume?: { count: number; unit: string };
    breakdown?: 'city' | 'label';
    /** How soon a person hears: "Discord immediately", "daily digest". */
    cadence?: 'immediate' | 'daily';
    channel?: 'discord';
    /** Clauses the grammar did not recognise, verbatim. */
    manual: string[];
};

type Rule = { re: RegExp; apply(spec: AlertSpec, m: RegExpExecArray): void };

const RULES: Rule[] = [
    { re: /\bfail rate\b/i, apply: s => { s.kind = 'rate'; } },
    { re: /\bany (?:run with a )?fail\b/i, apply: s => { s.kind = 'any'; } },
    { re: />\s*(\d+(?:\.\d+)?)\s*[×x]\s*its (\d+)-day baseline/i, apply: (s, m) => { s.factor = Number(m[1]); s.baselineDays = Number(m[2]); } },
    { re: /\bover (\d+) days?\b/i, apply: (s, m) => { s.windowDays = Number(m[1]); } },
    { re: /\bper week\b/i, apply: s => { s.windowDays = 7; } },
    { re: /\bper day\b/i, apply: s => { s.windowDays = 1; } },
    { re: /\bmin(?:imum)? (\d+) ([\w:*-]+ (?:calls|runs))\b/i, apply: (s, m) => { s.minVolume = { count: Number(m[1]), unit: m[2] }; } },
    { re: /\bper[- ]city(?: breakdown(?: in the alert)?)?/i, apply: s => { s.breakdown = 'city'; } },
    { re: /\bgrouped by label\b/i, apply: s => { s.breakdown = 'label'; } },
    { re: /\bdaily digest\b/i, apply: s => { s.cadence = 'daily'; } },
    { re: /\bDiscord immediately\b/i, apply: s => { s.cadence = 'immediate'; s.channel = 'discord'; } },
];

/** Leftovers that carry no meaning of their own once the recognised fragments are gone. */
const FILLER = /^(?:and|with|the|a|in|on|of|to|its)$/i;

export function parseAlert(text: string): AlertSpec {
    const spec: AlertSpec = { text, manual: [] };
    for (const clause of text.split(/[;:,]/).map(c => c.trim()).filter(Boolean)) {
        let rest = clause;
        for (const rule of RULES) {
            const m = rule.re.exec(rest);
            if (!m) continue;
            rule.apply(spec, m);
            rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
        }
        const words = rest.split(/\s+/).filter(w => w && !FILLER.test(w));
        if (words.length) spec.manual.push(clause);
    }
    return spec;
}
