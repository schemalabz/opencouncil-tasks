import { callCheck, fail, pass, responseJson, unknown } from './check.js';

const stated = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export default callCheck('not_a_decision_with_number', ['decision-reading'], call => {
    const reading = responseJson(call) as { notADecision?: unknown; decisionNumber?: unknown; meetingDate?: unknown } | undefined;
    if (typeof reading !== 'object' || reading === null) return unknown('the response is not a JSON reading');
    if (reading.notADecision !== true) return pass();
    const carried = (['decisionNumber', 'meetingDate'] as const).filter(k => stated(reading[k]));
    return carried.length ? fail(`notADecision with ${carried.map(k => `${k}=${JSON.stringify(reading[k])}`).join(', ')}`) : pass();
});
