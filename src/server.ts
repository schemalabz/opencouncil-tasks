// Initialize OpenTelemetry instrumentation FIRST (before other imports)
import './instrumentation.js';

import express from 'express';
import dotenv from 'dotenv';
import { pipeline } from './tasks/pipeline.js';
import cors from 'cors';
import { taskManager } from './lib/TaskManager.js';
import path from 'path';
import { getExpressAppWithCallbacks, getFromEnvOrFile, validateUrl, validateYoutubeUrl } from './utils.js';
import { Diarization, TranscribeRequest, DiarizeResult, HealthResponse } from './types.js';
import { authMiddleware } from './lib/auth.js';
import fs from 'fs';
import { uploadToSpaces } from './tasks/uploadToSpaces.js';
import { diarize } from './tasks/diarize.js';
import { splitAudioDiarization } from './tasks/splitAudioDiarization.js';
import { summarize } from './tasks/summarize.js';
import { generatePodcastSpec } from './tasks/generatePodcastSpec.js';
import { splitMediaFile } from './tasks/splitMediaFile.js';
import { fixTranscript } from './tasks/fixTranscript.js';
import { processAgenda } from './tasks/processAgenda.js';
import { generateVoiceprint } from './tasks/generateVoiceprint.js';
import { generateHighlight } from './tasks/generateHighlight.js';
import devRouter from './routes/dev.js';
import swaggerUi from 'swagger-ui-express';
import { DevPayloadManager } from './tasks/utils/devPayloadManager.js';
// Swagger will be imported after routes are defined

dotenv.config();


const app = getExpressAppWithCallbacks();


const corsOptions = {
    origin: process.env.CORS_ORIGINS_ALLOWED?.split(',') || "https://opencouncil.gr",
    methods: ['GET', 'POST'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Apply authentication middleware
app.use(authMiddleware);

// ============================================================================
// PUBLIC ENDPOINTS (No Authentication Required)
// ============================================================================

// Health check endpoint with version information
app.get('/health', (req: express.Request, res: express.Response<HealthResponse>) => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
        version: packageJson.version,
        name: packageJson.name
    });
});

// ============================================================================
// TASK ENDPOINTS (Authentication Required)
// ============================================================================
// All task endpoints are defined here with their metadata for automatic Swagger generation

app.post('/transcribe', (
    req: express.Request<{}, {}, TranscribeRequest & { callbackUrl: string }>,
    res: express.Response,
    next: express.NextFunction
) => {
    const { youtubeUrl, callbackUrl } = req.body;

    /*
    if (!validateUrl(youtubeUrl)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }*/

    if (!validateUrl(callbackUrl)) {
        return res.status(400).json({ error: 'Invalid callback URL' });
    }

    next();
}, taskManager.registerTask(pipeline, {
    summary: 'Transcribe audio/video content',
    description: 'Convert audio or video content to text using speech recognition'
}));

app.post('/summarize', taskManager.registerTask(summarize, {
    summary: 'Summarize transcript content',
    description: 'Generate a summary of transcript content with subject extraction',
  }));

app.post('/splitMediaFile', taskManager.registerTask(splitMediaFile, {
  summary: 'Split media file into segments',
  description: 'Split audio or video files into smaller segments based on specified time ranges'
}));

app.post('/generatePodcastSpec', taskManager.registerTask(generatePodcastSpec, {
  summary: 'Generate podcast specification',
  description: 'Create a podcast specification from transcript and subjects'
}));

app.post('/fixTranscript', taskManager.registerTask(fixTranscript, {
  summary: 'Fix transcript formatting',
  description: 'Cleans and corrects transcription output for improved accuracy'
}));

app.post('/processAgenda', taskManager.registerTask(processAgenda, {
  summary: 'Process meeting agenda',
  description: 'Extracts and structures agenda information from documents'
}));

app.post('/generateVoiceprint', taskManager.registerTask(generateVoiceprint, {
  summary: 'Generate voiceprint',
  description: 'Creates unique speaker voice fingerprints for identification'
}));

app.post('/generateHighlight', taskManager.registerTask(generateHighlight, {
  summary: 'Generate video highlight',
  description: 'Create video highlights from source media with visual enhancements'
}));

// Resolve task paths from Express routes, then load API Documentation
taskManager.resolvePathsFromApp(app);

// Initialize DevPayloadManager with valid task types for validation
const registeredTasks = taskManager.getAllRegisteredTasks();
const validTaskTypes = registeredTasks.map(({ metadata }) => metadata.path?.substring(1)).filter((path): path is string => Boolean(path));
DevPayloadManager.initialize(validTaskTypes);
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
// DEVELOPMENT ROUTES
// ============================================================================

// Development routes (only in development mode)
if (process.env.NODE_ENV === 'development') {
    app.use('/dev', devRouter);
    console.log('🔧 Development routes mounted at /dev');
}
        

// ============================================================================
// TEST ENDPOINTS
// ============================================================================

const testVideo = "https://www.youtube.com/watch?v=3ugZUq9nm4Y";

app.post('/test', async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {

    const resultPromise = pipeline({ youtubeUrl: testVideo }, () => { });
    res.status(200).json(await resultPromise);
});

app.post('/test-split', async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    let { audioFile, audioUrl, diarizationFile, voiceprints } = req.body;

    if (!audioFile) {
        return res.status(400).json({ error: 'No audio file or URL provided' });
    }

    if (!audioUrl) {
        const filePath = path.join(process.env.DATA_DIR || './data', audioFile);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        res.status(200).send({ "message": "ok" });
        console.log('Uploading to spaces...');
        const result = await uploadToSpaces({
            files: [filePath],
            spacesPath: 'test'
        }, console.log);
        console.log(`Uploaded to ${result[0]}`);
        audioUrl = result[0];
    } else {
        res.status(200).send({ "message": "ok" });
    }

    let diarization: Diarization;
    if (!diarizationFile) {
        console.log('Diarizing...');
        diarization = (await diarize({ audioUrl: audioFile, voiceprints }, console.log)).diarization;
        console.log(`Got diarization of ${diarization.length} segments`);
        console.log('Writing diarization to file...');

        const diarFilePath = path.join(process.env.DATA_DIR || './data', 'temp', 'diar.json');
        await fs.promises.mkdir(path.dirname(diarFilePath), { recursive: true });
        await fs.promises.writeFile(diarFilePath, JSON.stringify(diarization, null, 2));
        console.log(`Diarization written to ${diarFilePath}`);
    } else {
        console.log('Reading diarization from file...');
        const diarFilePath = path.join(process.env.DATA_DIR || './data', diarizationFile);
        diarization = (JSON.parse(await fs.promises.readFile(diarFilePath, 'utf8')) as DiarizeResult).diarization;
        console.log(`Diarization read from ${diarFilePath}, contains ${diarization.length} segments`);
    }

    console.log('Splitting...');
    const splits = await splitAudioDiarization({
        diarization,
        file: path.join(process.env.DATA_DIR || './data', audioFile),
        maxDuration: 60 * 60
    }, console.log);

    console.log(`Got ${splits.length} splits`);
});

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

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);

    // Log payload capture configuration
    const payloadConfig = DevPayloadManager.getConfig();
    if (payloadConfig.enabled) {
        const taskTypes = payloadConfig.taskTypes === 'all' ? 'all task types' : payloadConfig.taskTypes.join(', ');
        console.log(`📝 Payload capture: ENABLED for ${taskTypes}`);
        console.log(`📁 Storage: ${payloadConfig.storage.baseDirectory} (max ${payloadConfig.storage.maxFilesPerTask} files/task)`);
    } else {
        console.log('📝 Payload capture: DISABLED');
    }

    console.log('\nAvailable Endpoints:');
    (app as any)._router.stack.forEach((middleware: any) => {
        if (middleware.route) { // routes registered directly on the app
            const methods = Object.keys(middleware.route.methods).map(method => method.toUpperCase()).join(', ');
            console.log(`  ${methods.padEnd(8)} ${middleware.route.path}`);
        }
    });
    console.log();
});

if (process.argv.includes('--console')) {
    setInterval(() => taskManager.printTaskUpdates(), 5000);
} else {
    setInterval(() => {
        const taskUpdates = taskManager.getTaskUpdates();
        const tasksRunning = taskUpdates.length;
        const tasksQueued = taskManager.getQueuedTasksCount();

        let longestRunningTaskDuration = 0;
        if (tasksRunning > 0) {
            const oldestTask = taskUpdates.reduce((oldest, current) =>
                oldest.createdAt < current.createdAt ? oldest : current
            );
            const durationSeconds = Math.floor((Date.now() - new Date(oldestTask.createdAt).getTime()) / 1000);
            longestRunningTaskDuration = durationSeconds;
        }

        console.log(JSON.stringify({
            type: 'task-updates',
            tasksRunning,
            tasksQueued,
            longestRunningTaskDuration
        }));
    }, 5000);
}