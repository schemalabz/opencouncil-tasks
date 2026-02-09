#!/usr/bin/env npx tsx
/**
 * Utility script to look up municipality Diavgeia UIDs by name.
 *
 * Usage:
 *   npx tsx scripts/diavgeia-lookup.ts <query>                            # Search by name
 *   npx tsx scripts/diavgeia-lookup.ts <query> --json                     # JSON output
 *   npx tsx scripts/diavgeia-lookup.ts <query> --profile                  # All units ranked by decision count
 *   npx tsx scripts/diavgeia-lookup.ts <query> --profile --json           # Same, pipeable
 *   npx tsx scripts/diavgeia-lookup.ts <query> --profile=exclude-empty    # Drop 0-decision units
 *   npx tsx scripts/diavgeia-lookup.ts all                                # All municipalities (fast)
 *   npx tsx scripts/diavgeia-lookup.ts all --json                         # JSON output
 *   npx tsx scripts/diavgeia-lookup.ts all --profile --json               # All municipalities, all units ranked
 *   npx tsx scripts/diavgeia-lookup.ts all --profile=exclude-empty --json # Same, no 0-decision units
 */

import { Command } from 'commander';

const DIAVGEIA_API = 'https://diavgeia.gov.gr/luminapi/opendata';
const DIAVGEIA_SEARCH_API = 'https://diavgeia.gov.gr/opendata';

// Unit patterns relevant for council meetings (some municipalities use abbreviations)
const RELEVANT_UNIT_PATTERNS = [
    /ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ/i,
    /^Δ\.?Σ\.?\s+ΔΗΜΟΥ/i,  // "ΔΣ ΔΗΜΟΥ" or "Δ.Σ. ΔΗΜΟΥ" - abbreviated council at start
    /ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ/i,
    /ΟΙΚΟΝΟΜΙΚΗ ΕΠΙΤΡΟΠΗ/i,
    /ΕΠΙΤΡΟΠΗ ΠΟΙΟΤΗΤΑΣ ΖΩΗΣ/i,
    /(?<!ΑΝΤΙ)ΔΗΜΑΡΧΟ[ΣΥ]/i,  // ΔΗΜΑΡΧΟΣ, ΔΗΜΑΡΧΟΥ but not ΑΝΤΙΔΗΜΑΡΧΟΥ
];

interface Organization {
    uid: string;
    label: string;
    latinName: string;
    status: string;
}

interface Unit {
    uid: string;
    label: string;
    category: string;
    active: boolean;
}

interface MunicipalityResult {
    uid: string;
    label: string;
    latinName: string;
    units: Array<{ uid: string; label: string; category: string }>;
}

// Normalize Greek text for searching (remove accents, lowercase)
const normalizeGreek = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const isMunicipality = (org: Organization): boolean => {
    const label = org.label.toUpperCase();
    return label.startsWith('ΔΗΜΟΣ ') || label.startsWith('ΔΗΜΟΣ-');
};

const fetchOrganizations = async (): Promise<Organization[]> => {
    const response = await fetch(`${DIAVGEIA_API}/organizations.json`);
    if (!response.ok) throw new Error(`Failed to fetch organizations: ${response.status}`);
    const data = await response.json();
    return data.organizations;
};

const fetchUnits = async (orgUid: string): Promise<Unit[]> => {
    const response = await fetch(`${DIAVGEIA_API}/organizations/${orgUid}/units.json`);
    if (!response.ok) throw new Error(`Failed to fetch units: ${response.status}`);
    const data = await response.json();
    return data.units;
};

const isPatternMatch = (label: string) =>
    RELEVANT_UNIT_PATTERNS.some(pattern => pattern.test(label));

const getRelevantUnits = (units: Unit[]) =>
    units
        .filter(u => u.active && isPatternMatch(u.label))
        .map(u => ({ uid: u.uid, label: u.label, category: u.category }));

const fetchDecisionCount = async (orgUid: string, unitUid: string, fromDate: string, toDate: string): Promise<number> => {
    const params = new URLSearchParams({
        org: orgUid,
        unit: unitUid,
        from_issue_date: fromDate,
        to_issue_date: toDate,
        status: 'PUBLISHED',
        size: '1',
    });
    const response = await fetch(`${DIAVGEIA_SEARCH_API}/search?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Search API error: ${response.status}`);
    const data = await response.json();
    return data.info.total;
};

const formatResult = (m: MunicipalityResult): string => {
    const lines = [
        m.label,
        `  Organization UID: ${m.uid}`,
        `  Latin name: ${m.latinName}`,
    ];
    if (m.units.length > 0) {
        lines.push('  Units:');
        for (const u of m.units) {
            lines.push(`    - ${u.label}: ${u.uid}`);
        }
    } else {
        lines.push('  Units: (none found)');
    }
    return lines.join('\n');
};

const program = new Command();

program
    .name('diavgeia-lookup')
    .description('Look up municipality Diavgeia UIDs by name (fetches from API)')
    .argument('[query]', 'Municipality name to search for (use "all" for bulk export)')
    .option('--json', 'Output raw JSON instead of formatted text')
    .option('--profile [filter]', 'Profile unit activity by decision count (optional: exclude-empty)')
    .option('--from <date>', 'Profile start date (YYYY-MM-DD, default: 3 months ago)')
    .option('--to <date>', 'Profile end date (YYYY-MM-DD, default: today)')
    .action(async (query: string | undefined, options: { json?: boolean; profile?: boolean | string; from?: string; to?: string }) => {
        try {
            if (!query) {
                console.error('Error: Provide a municipality name to search, or use "all" for bulk export');
                process.exitCode = 1;
                return;
            }

            const isAll = normalizeGreek(query) === 'all';
            const excludeEmpty = options.profile === 'exclude-empty';

            console.error('Fetching organizations from Diavgeia...');
            const organizations = await fetchOrganizations();
            const municipalities = organizations.filter(isMunicipality);
            console.error(`Found ${municipalities.length} municipalities`);

            // Resolve target municipalities
            let targets: Organization[];
            if (isAll) {
                targets = municipalities;
            } else {
                const queryNorm = normalizeGreek(query);
                targets = municipalities.filter(m =>
                    normalizeGreek(m.label).includes(queryNorm) ||
                    m.latinName.toLowerCase().includes(queryNorm)
                );
                if (targets.length === 0) {
                    console.error(`No municipalities found matching "${query}"`);
                    process.exitCode = 1;
                    return;
                }
                console.error(`Found ${targets.length} matching municipalit${targets.length === 1 ? 'y' : 'ies'}`);
            }

            if (options.profile) {
                // Profile mode: rank all units by decision count
                const toDate = options.to || new Date().toISOString().split('T')[0];
                const fromDate = options.from || (() => {
                    const d = new Date();
                    d.setMonth(d.getMonth() - 3);
                    return d.toISOString().split('T')[0];
                })();

                const profileResults: Array<{
                    uid: string;
                    label: string;
                    latinName: string;
                    dateRange: { from: string; to: string };
                    units: Array<{ uid: string; label: string; count: number; patternMatch: boolean }>;
                }> = [];

                for (let mi = 0; mi < targets.length; mi++) {
                    const org = targets[mi];
                    if (isAll) {
                        process.stderr.write(`\r[${mi + 1}/${targets.length}] Profiling ${org.label}...`.padEnd(80));
                    } else {
                        console.error(`Fetching units for ${org.label}...`);
                    }

                    let units: Unit[];
                    try {
                        units = await fetchUnits(org.uid);
                    } catch (err) {
                        console.error(`\nError fetching units for ${org.label}: ${err}`);
                        continue;
                    }
                    const activeUnits = units.filter(u => u.active);

                    const unitCounts: Array<{ uid: string; label: string; count: number; patternMatch: boolean }> = [];
                    for (let i = 0; i < activeUnits.length; i++) {
                        const u = activeUnits[i];
                        if (isAll) {
                            process.stderr.write(`\r[${mi + 1}/${targets.length}] Profiling ${org.label}... [${i + 1}/${activeUnits.length}]`.padEnd(80));
                        } else {
                            process.stderr.write(`\r  [${i + 1}/${activeUnits.length}] Counting decisions for ${u.label}...`.padEnd(90));
                        }
                        try {
                            const count = await fetchDecisionCount(org.uid, u.uid, fromDate, toDate);
                            unitCounts.push({ uid: u.uid, label: u.label, count, patternMatch: isPatternMatch(u.label) });
                        } catch {
                            unitCounts.push({ uid: u.uid, label: u.label, count: -1, patternMatch: isPatternMatch(u.label) });
                        }
                        await new Promise(r => setTimeout(r, 50));
                    }

                    unitCounts.sort((a, b) => b.count - a.count);
                    const filtered = excludeEmpty ? unitCounts.filter(u => u.count > 0) : unitCounts;

                    profileResults.push({
                        uid: org.uid,
                        label: org.label,
                        latinName: org.latinName,
                        dateRange: { from: fromDate, to: toDate },
                        units: filtered,
                    });

                    // For single-query text output, print inline
                    if (!isAll && !options.json) {
                        process.stderr.write('\r'.padEnd(90) + '\r');
                        console.log('');
                        console.log(`${org.label} (${org.uid})`);
                        console.log(`  Latin name: ${org.latinName}`);

                        const matched = activeUnits.filter(u => isPatternMatch(u.label));
                        if (matched.length > 0) {
                            console.log('');
                            console.log('  Known units (matched by name):');
                            for (const u of matched) {
                                console.log(`    ${u.label}: ${u.uid}`);
                            }
                        }

                        console.log('');
                        console.log(`  All active units by decision count (${fromDate} to ${toDate}):`);

                        const displayUnits = filtered;
                        if (displayUnits.length > 0) {
                            const maxCount = Math.max(...displayUnits.map(u => u.count));
                            const countWidth = Math.max(String(maxCount).length, 3);
                            for (const u of displayUnits) {
                                const countStr = u.count === -1 ? 'err' : String(u.count);
                                const marker = u.patternMatch ? '  *' : '';
                                console.log(`    ${countStr.padStart(countWidth)}  ${u.label} (${u.uid})${marker}`);
                            }
                        }
                        console.log('');
                        console.log('  * = matched by name pattern');
                        console.log('');
                    }
                }

                if (isAll) {
                    process.stderr.write('\n');
                }

                // JSON output for profile mode
                if (options.json) {
                    profileResults.sort((a, b) => a.label.localeCompare(b.label, 'el'));
                    console.log(JSON.stringify(isAll ? profileResults : profileResults.length === 1 ? profileResults[0] : profileResults, null, 2));
                }

                if (isAll) {
                    console.error(`Done! Profiled ${profileResults.length} municipalities`);
                }
            } else {
                // Standard mode: show pattern-matched units only
                const results: MunicipalityResult[] = [];
                for (let i = 0; i < targets.length; i++) {
                    const org = targets[i];
                    if (isAll) {
                        process.stderr.write(`\r[${i + 1}/${targets.length}] Fetching ${org.label}...`.padEnd(80));
                    } else {
                        console.error(`Fetching units for ${org.label}...`);
                    }
                    try {
                        const units = await fetchUnits(org.uid);
                        results.push({
                            uid: org.uid,
                            label: org.label,
                            latinName: org.latinName,
                            units: getRelevantUnits(units),
                        });
                        await new Promise(r => setTimeout(r, 50));
                    } catch (err) {
                        console.error(`\nError fetching ${org.label}: ${err}`);
                    }
                }
                if (isAll) {
                    process.stderr.write('\n');
                }

                results.sort((a, b) => a.label.localeCompare(b.label, 'el'));

                if (options.json) {
                    console.log(JSON.stringify(results, null, 2));
                } else {
                    console.log('');
                    for (const m of results) {
                        console.log(formatResult(m));
                        console.log('');
                    }
                }

                if (isAll) {
                    console.error(`Done! Fetched ${results.length} municipalities`);
                }
            }
        } catch (error) {
            console.error('Error:', error instanceof Error ? error.message : error);
            process.exitCode = 1;
        }
    });

program.parse();
