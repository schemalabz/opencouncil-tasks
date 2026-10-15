import fs from 'fs';
import os from 'os';
import path from 'path';

// Tests must never reach a real archive or platform. The code loads the repo .env (which holds
// production Langfuse keys) and a dev shell may export an archive or PostHog token; dotenv never
// overrides a variable that is already set, so blanking them here wins. A test that needs a sink
// sets its own.
for (const name of ['TELEMETRY_SINKS', 'ARCHIVE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'POSTHOG_PROJECT_TOKEN', 'POSTHOG_PERSONAL_API_KEY', 'DISCORD_ALERT_WEBHOOK']) {
    process.env[name] = '';
}

// aiChat appends its errors to ai.log there; unset, the suite writes into the checkout.
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-logs-'));
