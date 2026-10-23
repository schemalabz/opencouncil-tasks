import { callCheck, fail, pass } from './check.js';

export default callCheck('output_truncated', ['*'], call => {
    const { stopReason } = call.response;
    if (stopReason === 'model_context_window_exceeded') return fail(stopReason);
    if (stopReason !== 'max_tokens') return pass();
    // aiChat continues a free-text answer that hit max_tokens in a follow-up call; a structured
    // output it cannot continue, so that one reached the caller cut off (or as an error).
    return call.request.output_config?.format ? fail('structured output hit max_tokens') : pass('free text hit max_tokens; aiChat continued it');
});
