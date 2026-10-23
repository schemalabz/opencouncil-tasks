import { normalizeExtraction } from '../../tasks/utils/decisionPdfExtraction.js';
import { validateProcessedDecision, validateRawExtraction, type DecisionWarningCode } from '../../tasks/utils/decisionValidation.js';
import { callCheck, fail, pass, responseJson, unknown, type Check } from './check.js';

/**
 * The pipeline's own extraction warnings as checks, one per code. Only the whole-document
 * read qualifies: partial, continuation and closing reads leave fields empty by instruction.
 * NO_VOTE_DETAILS runs on the named votes as read, before name matching.
 */
export function codeCheck(code: DecisionWarningCode): Check {
    return callCheck(code.toLowerCase(), ['decision-extraction'], call => {
        const raw = responseJson(call);
        if (typeof raw !== 'object' || raw === null) return unknown('the response is not a JSON extraction');
        const extraction = normalizeExtraction(raw as Parameters<typeof normalizeExtraction>[0]);
        const warnings = [
            ...validateRawExtraction(extraction),
            ...validateProcessedDecision({ voteResult: extraction.voteResult, voteDetails: extraction.voteDetails ?? [] }),
        ];
        const hit = warnings.find(w => w.code === code);
        return hit ? fail(hit.message) : pass();
    });
}

export const EXTRACTION_INCOMPLETE = codeCheck('EXTRACTION_INCOMPLETE');
export const EMPTY_EXCERPT = codeCheck('EMPTY_EXCERPT');
export const MISSING_DECISION_NUMBER = codeCheck('MISSING_DECISION_NUMBER');
export const NO_ATTENDANCE = codeCheck('NO_ATTENDANCE');
export const MISSING_VOTE_RESULT = codeCheck('MISSING_VOTE_RESULT');
export const NO_VOTE_DETAILS = codeCheck('NO_VOTE_DETAILS');
