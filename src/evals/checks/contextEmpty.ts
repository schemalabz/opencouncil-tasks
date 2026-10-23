import type { Subject } from '../../types.js';
import { fail, pass, taskCheck, unknown } from './check.js';

// Both tasks enrich every subject they return, so an empty context is a swallowed error.
export default taskCheck('context_empty_after_error', ['summarize', 'processAgenda'], ({ result }) => {
    const subjects = (result as { subjects?: Subject[] } | null)?.subjects;
    if (!Array.isArray(subjects)) return unknown('the result has no subjects');
    const empty = subjects.filter(s => !s.context?.text?.trim());
    if (empty.length === 0) return pass();
    return fail(`${empty.length}/${subjects.length} subjects without context: ${empty.map(s => `«${s.name}»`).join(', ')}`);
});
