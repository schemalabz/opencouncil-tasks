import { enableLogPersistence } from './lib/logPersistence.js';
enableLogPersistence();

import express from 'express';
import dotenv from 'dotenv';
import { pipeline } from './tasks/pipeline.js';
import cors from 'cors';
import { taskManager } from './lib/TaskManager.js';
import { getExpressAppWithCallbacks } from './utils.js';
import { HealthResponse } from './types.js';
import { authMiddleware, verifyBearerToken } from './lib/auth.js';
import { logObservabilityStatus } from './lib/observability.js';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { summarize } from './tasks/summarize.js';
import { splitMediaFile } from './tasks/splitMediaFile.js';
import { fixTranscript } from './tasks/fixTranscript.js';
import { processAgenda } from './tasks/processAgenda.js';
import { generateVoiceprint } from './tasks/generateVoiceprint.js';
import { generateHighlight } from './tasks/generateHighlight.js';
import { pollDecisions } from './tasks/pollDecisions.js';
import { devSlowTask } from './tasks/devSlowTask.js';
import { loadFusionConfig } from './lib/fusion/config.js';
import devRouter from './routes/dev.js';
import uploadRouter from './routes/upload.js';
import swaggerUi from 'swagger-ui-express';
// Swagger will be imported after routes are defined

dotenv.config();


const app = getExpressAppWithCallbacks();


const corsOptions = {
    origin: process.env.CORS_ORIGINS_ALLOWED?.split(',') || "https://opencouncil.gr",
    methods: ['GET', 'POST'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Log incoming requests
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const level = status >= 400 ? '⚠' : '→';
        console.log(`${level} ${req.method} ${req.path} ${status} ${duration}ms`);
    });
    next();
});

// Apply authentication middleware
app.use(authMiddleware);

// ============================================================================
// PUBLIC ENDPOINTS (No Authentication Required)
// ============================================================================

app.get('/health', async (req: express.Request, res: express.Response<HealthResponse>) => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const services: { [key: string]: any } = {};
    const ytdlpBin = process.env.YTDLP_BIN_PATH || 'yt-dlp';
    
    // Check yt-dlp availability/version
    try {
        const result = spawnSync(ytdlpBin, ['--version'], { encoding: 'utf8', timeout: 3000 });
        if (result.error) {
            services.ytdlp = { status: 'unhealthy' as const, error: result.error.message };
        } else if (result.status === 0) {
            services.ytdlp = { status: 'healthy' as const, version: (result.stdout || '').trim() };
        } else {
            services.ytdlp = { status: 'unhealthy' as const, error: `exit ${result.status}`, stdout: result.stdout, stderr: result.stderr };
        }
    } catch (error) {
        services.ytdlp = { status: 'unhealthy' as const, error: error instanceof Error ? error.message : 'Unknown' };
    }

    
    // If a Bearer token was provided, report whether it's valid.
    // Omitted entirely when no token is sent (plain health check).
    const hasAuthHeader = req.headers.authorization?.startsWith('Bearer ');
    const authenticated = hasAuthHeader ? verifyBearerToken(req) : undefined;

    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
        version: fs.existsSync('VERSION') ? fs.readFileSync('VERSION', 'utf8').trim() : packageJson.version,
        name: packageJson.name,
        ...(authenticated !== undefined && { authenticated }),
        services
    });
});

// ============================================================================
// TASK CONTROL ENDPOINTS (Authentication Required)
// ============================================================================

// List all running and queued tasks with their current state
app.get('/tasks', (req, res) => {
    res.json({
        running: taskManager.getTaskUpdates(),
        queued: taskManager.getQueuedTaskSummaries(),
        maxParallelTasks: taskManager.getMaxParallelTasks(),
    });
});

// Cancel a running or queued task (cooperative: running tasks finish at the next checkpoint)
app.post('/tasks/:taskId/cancel', (req, res) => {
    const outcome = taskManager.cancelTask(req.params.taskId);
    if (!outcome) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    res.json({ taskId: req.params.taskId, status: outcome });
});

// Switch a running task's LLM calls from the Batch API to streaming
app.post('/tasks/:taskId/promote', (req, res) => {
    const outcome = taskManager.promoteTask(req.params.taskId);
    if (outcome === null) {
        res.status(404).json({ error: 'Task not found' });
        return;
    }
    if (outcome === 'queued') {
        res.status(409).json({ error: 'Task is queued, not running — nothing to promote yet' });
        return;
    }
    res.json({ taskId: req.params.taskId, llmMode: 'streaming' });
});

// ============================================================================
// TASK ENDPOINTS (Authentication Required)
// ============================================================================
// All task endpoints are defined here with their metadata for automatic Swagger generation

app.post('/transcribe', taskManager.registerTask(pipeline, {
    summary: 'Transcribe audio/video content',
    description: 'Convert audio or video content to text using speech recognition',
    // v3: speaker attribution uses pyannote's exclusive (non-overlapping) timeline,
    // and utterances without a covering diarization segment are assigned to the
    // nearest segment instead of being dropped
    // v4: utterances carry minWordConfidence and totalConfidence alongside the
    // existing mean confidence, all derived from Scribe's per-word logprobs
    version: 4,
}));

app.post('/summarize', taskManager.registerTask(summarize, {
    summary: 'Summarize transcript content',
    description: 'Generate a summary of transcript content with subject extraction',
    // v6: subject location coordinates are emitted as GeoJSON [lng, lat] (were [lat, lng])
    version: 6,
  }));

app.post('/splitMediaFile', taskManager.registerTask(splitMediaFile, {
  summary: 'Split media file into segments',
  description: 'Split audio or video files into smaller segments based on specified time ranges'
}));

app.post('/fixTranscript', taskManager.registerTask(fixTranscript, {
  summary: 'Fix transcript formatting',
  description: 'Cleans and corrects transcription output for improved accuracy',
  version: 2,
}));

app.post('/processAgenda', taskManager.registerTask(processAgenda, {
  summary: 'Process meeting agenda',
  description: 'Extracts and structures agenda information from documents',
  // v4: subject location coordinates are emitted as GeoJSON [lng, lat] (were [lat, lng])
  // v5: agendaItemTitle, the item as written on the agenda (schemalabz/opencouncil#616)
  version: 5,
}));

app.post('/generateVoiceprint', taskManager.registerTask(generateVoiceprint, {
  summary: 'Generate voiceprint',
  description: 'Creates unique speaker voice fingerprints for identification'
}));

app.post('/generateHighlight', taskManager.registerTask(generateHighlight, {
  summary: 'Generate video highlight',
  description: 'Create video highlights from source media with visual enhancements',
  // v2: word-timed animated ASS captions (forced alignment), restyled speaker chip
  version: 2,
}));

app.post('/pollDecisions', taskManager.registerTask(pollDecisions, {
  summary: 'Poll and extract decisions from Diavgeia',
  description: 'Fetch decisions from the Greek Government Transparency portal, match them to meeting subjects, and extract structured data (excerpt, attendance, votes) from matched PDFs',
  version: 3,
}));

// Matches the gate on the other dev routes below: NODE_ENV is unset in the
// deployed environments, so anything but an explicit === 'development' would
// register this in production too.
if (process.env.NODE_ENV === 'development') {
    app.post('/dev/slowTask', taskManager.registerTask(devSlowTask, {
        summary: 'Dev-only slow task for testing cancellation and batch promotion',
        description: 'Sleeps cooperatively for iterations×sleepMs, optionally makes one tiny batch-first LLM call.',
        tags: ['Development'],
    }));
}

// Resolve task paths from Express routes, then load API Documentation
taskManager.resolvePathsFromApp(app);
import('./lib/swaggerConfig.js').then(({ swaggerSpec }) => {
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
        explorer: true,
        customCss: '.swagger-ui .topbar { display: none }',
        customSiteTitle: 'OpenCouncil Tasks API',
        swaggerOptions: {
            persistAuthorization: true,
            displayRequestDuration: true,
            showExtensions: true,
            showCommonExtensions: true,
        }
    }));
    console.log('📚 API Documentation available at /docs');
});

// ============================================================================
// FILE UPLOAD ENDPOINT
// ============================================================================

app.use('/upload-video', uploadRouter);

// ============================================================================
// FUSION PROVIDER (openai-compatible route)
// ============================================================================
// Validated here, at startup, so an invalid FUSION_* value stops the process
// instead of quietly meaning "off" — which is indistinguishable from an outage.
const fusionConfig = loadFusionConfig();
// And the engine itself is probed here, before app.listen: with fusion enabled
// but no Python in the image, every segment bills ElevenLabs, Soniox and RunPod,
// discards two of the three, and returns a Scribe transcript that looks normal.
// Failing to start is the cheap failure.
const { assertFusionRuntimeUsable } = await import('./lib/fusion/preflight.js');
await assertFusionRuntimeUsable(fusionConfig);
if (fusionConfig.openaiRoute === 'on') {
    const { mountOpenAiCompatRoute } = await import('./routes/openaiCompat.js');
    mountOpenAiCompatRoute(app);
    console.log(`🔀 Fusion openai-compatible route mounted at /v1/audio/transcriptions (mode=${fusionConfig.mode}, engine=${fusionConfig.engine})`);
} else if (fusionConfig.mode !== 'off') {
    console.log(`🔀 Fusion enabled (mode=${fusionConfig.mode}, canary=${fusionConfig.canaryPercent}%), openai-compatible route disabled`);
}

// ============================================================================
// DEVELOPMENT ROUTES
// ============================================================================

// Development routes (only in development mode)
if (process.env.NODE_ENV === 'development') {
    app.use('/dev', devRouter);
    console.log('🔧 Development routes mounted at /dev');
}
        

// ============================================================================
// SERVER SETUP
// ============================================================================

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Shutting down gracefully...');

    // Stop the server from accepting new connections
    server.close(() => {
        console.log('Server closed. No longer accepting connections.');
    });

    try {
        // Wait for all running tasks to finish
        console.log('Waiting for all tasks to complete...');
        await taskManager.finish();
        console.log('All tasks completed.');
    } catch (error) {
        console.error('Error during graceful shutdown:', error);
    } finally {
        // Exit the process
        console.log('Exiting process.');
        process.exit(0);
    }
});

// A fused segment is a long request by design and the caller is expected to
// wait for it. Node is not: it cuts every request at five minutes, and the
// runbook already recommends raising FUSION_DEADLINE_MS when our own endpoint
// is cold. The HTTP layer would then kill a segment mid-fusion, after all three
// providers had been paid, and the caller would see a dropped connection rather
// than the failure matrix's exact Scribe fallback.
const HTTP_SLACK_MS = 120_000;

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    logObservabilityStatus();

    console.log('\nAvailable Endpoints:');
    (app as any)._router.stack.forEach((middleware: any) => {
        if (middleware.route) { // routes registered directly on the app
            const methods = Object.keys(middleware.route.methods).map(method => method.toUpperCase()).join(', ');
            console.log(`  ${methods.padEnd(8)} ${middleware.route.path}`);
        }
    });
    console.log();
});

server.requestTimeout = fusionConfig.deadlineMs + HTTP_SLACK_MS;
server.setTimeout(0);

if (process.argv.includes('--console')) {
    setInterval(() => taskManager.printTaskUpdates(), 5000);
} else {
    let lastTaskCount = 0;
    setInterval(() => {
        const taskUpdates = taskManager.getTaskUpdates();
        const tasksRunning = taskUpdates.length;
        const tasksQueued = taskManager.getQueuedTasksCount();

        // Only log if there are tasks or if the count changed
        if (tasksRunning === 0 && tasksQueued === 0 && lastTaskCount === 0) {
            return;
        }
        lastTaskCount = tasksRunning + tasksQueued;

        let longestRunningTaskDuration = 0;
        if (tasksRunning > 0) {
            const oldestTask = taskUpdates.reduce((oldest, current) =>
                oldest.createdAt < current.createdAt ? oldest : current
            );
            const durationSeconds = Math.floor((Date.now() - new Date(oldestTask.createdAt).getTime()) / 1000);
            longestRunningTaskDuration = durationSeconds;
        }

        // Pretty formatted output
        const runningEmoji = tasksRunning > 0 ? '🔄' : '✓';
        const queuedEmoji = tasksQueued > 0 ? '⏳' : '';
        const durationStr = longestRunningTaskDuration > 0
            ? ` (longest: ${longestRunningTaskDuration}s)`
            : '';

        console.log(`${runningEmoji} Tasks: ${tasksRunning} running${durationStr}${queuedEmoji ? ` ${queuedEmoji} ${tasksQueued} queued` : ''}`);
    }, 30000);
}