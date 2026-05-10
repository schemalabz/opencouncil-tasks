import { RawExtractedDecision, VoteValue } from './decisionPdfExtraction.js';

// --- Warning types ---

/**
 * Per-decision warning codes produced during extraction and validation.
 *
 * Raw-level (before name matching):
 * - EXTRACTION_INCOMPLETE (error)  — Document appears physically truncated, decision section not found
 * - EMPTY_EXCERPT         (warning) — Decision excerpt is empty or whitespace-only
 * - MISSING_DECISION_NUMBER (info)  — Decision number (Αριθμός Απόφασης) not found in document
 * - NO_ATTENDANCE         (warning) — Both present and absent member lists are empty
 * - MISSING_VOTE_RESULT   (warning) — Excerpt contains "ΑΠΟΦΑΣΙΖΕΙ" but no vote phrase was extracted
 *
 * Post-matching (after name matching and vote inference):
 * - NO_VOTE_DETAILS       (warning) — Vote result says majority but no AGAINST/ABSTAIN voters found
 */
export type DecisionWarningCode =
    | 'MISSING_VOTE_RESULT'
    | 'EMPTY_EXCERPT'
    | 'MISSING_DECISION_NUMBER'
    | 'NO_ATTENDANCE'
    | 'EXTRACTION_INCOMPLETE'
    | 'NO_VOTE_DETAILS';

export interface DecisionWarning {
    code: DecisionWarningCode;
    severity: 'info' | 'warning' | 'error';
    message: string;
}

// --- Raw-level validation ---

/**
 * Validate a raw Claude extraction result before name matching.
 * Catches structural issues with the extracted data.
 */
export function validateRawExtraction(raw: RawExtractedDecision): DecisionWarning[] {
    const warnings: DecisionWarning[] = [];

    if (raw.incomplete) {
        warnings.push({
            code: 'EXTRACTION_INCOMPLETE',
            severity: 'error',
            message: 'Document appears truncated — decision text may be missing or cut off',
        });
    }

    if (!raw.decisionExcerpt || !raw.decisionExcerpt.trim()) {
        warnings.push({
            code: 'EMPTY_EXCERPT',
            severity: 'warning',
            message: 'Decision excerpt is empty',
        });
    }

    if (!raw.decisionNumber) {
        warnings.push({
            code: 'MISSING_DECISION_NUMBER',
            severity: 'info',
            message: 'Decision number (Αριθμός Απόφασης) not found in document',
        });
    }

    if (
        (!raw.presentMembers || raw.presentMembers.length === 0) &&
        (!raw.absentMembers || raw.absentMembers.length === 0)
    ) {
        warnings.push({
            code: 'NO_ATTENDANCE',
            severity: 'warning',
            message: 'No present or absent members found in document',
        });
    }

    // Check for missing vote result when the excerpt contains ΑΠΟΦΑΣΙΖΕΙ
    // (the decision section exists but no vote phrase was extracted)
    if (
        raw.voteResult == null &&
        raw.decisionExcerpt &&
        /ΑΠΟΦΑΣΙΖΕΙ/i.test(raw.decisionExcerpt)
    ) {
        warnings.push({
            code: 'MISSING_VOTE_RESULT',
            severity: 'warning',
            message: 'Decision contains "ΑΠΟΦΑΣΙΖΕΙ" but no vote result phrase (e.g. "Ομόφωνα", "Κατά πλειοψηφία") was found',
        });
    }

    return warnings;
}

// --- Post-matching validation ---

export interface ProcessedDecisionContext {
    voteResult: string | null;
    voteDetails: { vote: VoteValue }[];
}

/**
 * Validate a decision after name matching and vote inference.
 * Catches data quality issues that emerge during processing.
 */
export function validateProcessedDecision(ctx: ProcessedDecisionContext): DecisionWarning[] {
    const warnings: DecisionWarning[] = [];

    // Majority vote but no non-FOR votes or declarations listed
    const isMajority = ctx.voteResult && /κατ[άα]\s+πλειοψηφ[ίι]/i.test(ctx.voteResult);
    if (isMajority) {
        const hasNonForVotes = ctx.voteDetails.some(v =>
            v.vote === 'AGAINST' || v.vote === 'ABSTAIN' || v.vote === 'PRESENT' || v.vote === 'DID_NOT_VOTE'
        );
        if (!hasNonForVotes) {
            warnings.push({
                code: 'NO_VOTE_DETAILS',
                severity: 'warning',
                message: 'Vote result indicates majority but no AGAINST, ABSTAIN, PRESENT or DID_NOT_VOTE voters were found',
            });
        }
    }

    return warnings;
}
