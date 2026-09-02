/**
 * Parsing of `AdministrativeBody.diavgeiaUnitIds` entries (issue #330).
 *
 * Some municipalities publish several administrative bodies under one Diavgeia
 * unit — Athens publishes all 7 Δημοτικές Κοινότητες under unit `84655`. The unit
 * alone cannot separate them, but the signer can: each community's decisions
 * carry that community president's signer UID.
 *
 * An entry is therefore `unit[:signer]`. A bare `"81689"` keeps its old meaning
 * and filters by unit only. Each entry is one independent Diavgeia query, and
 * the caller unions the results by ADA — so a body may mix bare and scoped
 * entries freely, on the same unit or on different ones.
 */

export interface DiavgeiaUnitScope {
    unit?: string;
    signer?: string;
}

/**
 * Parse configured entries into the queries they describe. An empty
 * configuration yields a single unscoped query, which searches the whole
 * organization.
 */
export function parseDiavgeiaUnitScopes(entries?: string[]): DiavgeiaUnitScope[] {
    const scopes: DiavgeiaUnitScope[] = [];
    for (const entry of entries ?? []) {
        if (!entry.trim()) continue;
        const parts = entry.split(':').map(part => part.trim());
        // A malformed entry must fail loudly. Skipping it would narrow the
        // poll silently — or worse, fall back to an org-wide query when it
        // was the only entry. Truncating it would turn a typo into a
        // valid-looking narrower scope.
        if (parts.length > 2 || !parts[0]) {
            throw new Error(`Malformed diavgeiaUnitIds entry "${entry}" — expected unit or unit:signer`);
        }
        const [unit, signer] = parts;
        scopes.push(signer ? { unit, signer } : { unit });
    }
    return scopes.length > 0 ? scopes : [{}];
}

/** One-line rendering of a scope, for logs and stored result metadata. */
export function formatDiavgeiaUnitScope(scope: DiavgeiaUnitScope): string {
    if (!scope.unit) return 'org-wide';
    return scope.signer ? `${scope.unit}:${scope.signer}` : scope.unit;
}
