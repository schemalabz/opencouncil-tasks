import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { DETECTOR_CASE_KINDS, MONITORED_STATUSES, type DetectorCase, type FailureMode } from './schema.js';

/** The checkout this module lives in, so source and compiled code resolve the same files. */
export function repoRoot(): string {
    return fileURLToPath(new URL('../../../', import.meta.url));
}

export function modesDir(root = repoRoot()): string {
    return path.join(root, 'evals', 'failure-modes');
}

/** "FM-0001" + "context_disclaimer_preamble" → "FM-0001-context-disclaimer-preamble" */
export function modeStem(mode: Pick<FailureMode, 'id' | 'slug'>): string {
    return `${mode.id}-${mode.slug.replace(/_/g, '-')}`;
}

export function modeFiles(root?: string): string[] {
    const dir = modesDir(root);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort().map(f => path.join(dir, f));
}

export function readModeFile(file: string): unknown {
    return YAML.parse(fs.readFileSync(file, 'utf8'));
}

/** Entries as written; `lintRegistry` is what validates them. */
export function loadModes(root?: string): FailureMode[] {
    return modeFiles(root).map(file => ({ ...(readModeFile(file) as FailureMode), file }));
}

export const isMonitored = (mode: Pick<FailureMode, 'status'>): boolean => MONITORED_STATUSES.includes(mode.status);

/** The modes whose checks run after every production task. */
export function monitoredModes(root?: string): FailureMode[] {
    return loadModes(root).filter(isMonitored);
}

export function detectorCasesDir(mode: Pick<FailureMode, 'id' | 'slug'>, root?: string): string {
    return path.join(modesDir(root), modeStem(mode), 'detector-cases');
}

export function detectorCaseFiles(mode: Pick<FailureMode, 'id' | 'slug'>, root?: string): string[] {
    const dir = detectorCasesDir(mode, root);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f));
}

export function readDetectorCase(file: string): DetectorCase {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not a JSON object');
    if (!DETECTOR_CASE_KINDS.includes(raw.kind)) throw new Error(`kind must be one of ${DETECTOR_CASE_KINDS.join('|')}, got ${JSON.stringify(raw.kind)}`);
    if (raw.input === undefined) throw new Error('input is required');
    if (raw.note !== undefined && typeof raw.note !== 'string') throw new Error('note must be a string');
    return { ...raw, file };
}

export function loadDetectorCases(mode: Pick<FailureMode, 'id' | 'slug'>, root?: string): DetectorCase[] {
    return detectorCaseFiles(mode, root).map(readDetectorCase);
}

export function modeSuites(mode: Pick<FailureMode, 'suite'>): string[] {
    return Array.isArray(mode.suite) ? mode.suite : [mode.suite];
}

export function modeAppliesTo(mode: Pick<FailureMode, 'suite'>, suite: string): boolean {
    return modeSuites(mode).some(s => s === suite || s === '*');
}

export function modesForSuite(suite: string, root?: string): FailureMode[] {
    return loadModes(root).filter(m => modeAppliesTo(m, suite));
}

export function modeBySlug(slug: string, root?: string): FailureMode | undefined {
    return loadModes(root).find(m => m.slug === slug);
}
