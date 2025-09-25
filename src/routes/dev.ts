import express from 'express';
import fs from 'fs';
import path from 'path';
import { uploadToSpaces } from '../tasks/uploadToSpaces.js';
import { DevPayloadManager } from '../tasks/utils/devPayloadManager.js';
import { createTestPayload, parseOverrides } from '../lib/parameterOverride.js';
import aws from 'aws-sdk';
const S3 = aws.S3;

/*
 * Development-specific types for dev endpoints
 * These are kept separate from the main types.ts file since they're only used in development
 */

export interface DevTestTaskSuccessResponse {
    success: true;
    message: string;
    taskType: string;
    testName: string;
    result: any; // The actual task result
    payload: any; // The payload used for testing
    overrides?: Record<string, any>; // Applied parameter overrides
}

export interface DevTestTaskErrorResponse {
    success: false;
    message: string;
    taskType?: string;
    testName?: string;
    error: string;
    payload?: any;
    overrides?: Record<string, any>;
    errors?: string[]; // For parameter override errors
    availableIndices?: number[]; // For payload index errors
    totalPayloads?: number;
}

const router = express.Router();

// Development endpoint for testing file uploads
router.post('/test-upload', async (req: express.Request, res: express.Response) => {
    try {
        console.log('🧪 Testing file upload through real pipeline...');
        
        // Create a test file
        const testDir = path.join(process.env.DATA_DIR || './data', 'test');
        await fs.promises.mkdir(testDir, { recursive: true });
        
        const testFilePath = path.join(testDir, 'test-upload.txt');
        const testContent = `Test file created at ${new Date().toISOString()}\nThis tests the real uploadToSpaces task with your configured storage backend.`;
        
        await fs.promises.writeFile(testFilePath, testContent);
        console.log(`📝 Created test file: ${testFilePath}`);
        
        // Test upload using the real uploadToSpaces task
        const result = await uploadToSpaces({
            files: [testFilePath],
            spacesPath: 'dev-test'
        }, (stage, progress) => {
            console.log(`📤 Upload progress: ${stage} - ${progress}%`);
        });
        
        console.log('✅ Upload successful!');
        console.log(`📁 Files uploaded: ${result.join(', ')}`);
        
        // Clean up test file
        await fs.promises.unlink(testFilePath);
        console.log('🧹 Test file cleaned up');
        
        res.json({
            success: true,
            message: 'File upload test completed successfully',
            uploadedUrls: result,
            testFile: testFilePath,
            content: testContent,
            note: 'Copy the URL above and paste it in your browser to test file access'
        });
        
    } catch (error) {
        console.error('❌ File upload test failed:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'File upload test failed'
        });
    }
});

// MinIO file serving for development
// This route handles: /dev/files/opencouncil-dev/audio/file.mp3
// Files are served from MinIO storage through our Express app
router.get('/files/:bucket/*', async (req: express.Request, res: express.Response) => {
    try {
        const { bucket } = req.params;
        const filePath = req.params[0]; // This captures everything after /files/bucket/
        
        console.log(`📁 Serving file from MinIO: bucket=${bucket}, path=${filePath}`);
        
        // Create S3 client for MinIO
        const s3Client = new S3({
            endpoint: process.env.DO_SPACES_ENDPOINT,
            accessKeyId: process.env.DO_SPACES_KEY,
            secretAccessKey: process.env.DO_SPACES_SECRET,
            s3ForcePathStyle: true,
            signatureVersion: 'v4'
        });
        
        // Get file from MinIO
        const result = await s3Client.getObject({
            Bucket: bucket,
            Key: filePath
        }).promise();
        
        // Set appropriate headers
        res.set('Content-Type', result.ContentType || 'application/octet-stream');
        res.set('Content-Length', result.ContentLength?.toString() || '0');
        
        // Stream the file
        if (result.Body) {
            // Handle different Body types from AWS SDK
            if (typeof result.Body === 'string') {
                res.send(result.Body);
            } else if (result.Body instanceof Buffer) {
                res.send(result.Body);
            } else if (result.Body && typeof result.Body === 'object' && 'pipe' in result.Body) {
                (result.Body as any).pipe(res);
            } else {
                res.send(result.Body);
            }
        } else {
            res.status(404).send('File not found');
        }
        
    } catch (error) {
        console.error('❌ Error serving file from MinIO:', error);
        res.status(500).send('Error serving file');
    }
});

/**
 * @swagger
 * /dev/test-task/{taskType}:
 *   post:
 *     summary: Test task with captured payload and parameter overrides
 *     description: |
 *       Execute a task using captured payloads with optional parameter overrides.
 *       This endpoint supports multiple testing scenarios:
 *       
 *       1. **Use captured payloads** - Test with real data captured during development
 *       2. **Parameter overrides** - Modify specific parameters without creating variations
 *       3. **Custom payloads** - Provide completely custom payload in request body
 *       
 *       ## Parameter Override Examples:
 *       - `render.aspectRatio:social-9x16` - Change aspect ratio
 *       - `render.includeCaptions:true` - Enable captions
 *       - `render.socialOptions.zoomFactor:0.8` - Set zoom factor
 *       - `render.socialOptions.backgroundColor:#ffffff` - Set background color
 *       
 *       Multiple overrides can be combined with commas.
 *     parameters:
 *       - name: taskType
 *         in: path
 *         required: true
 *         description: Type of task to test
 *         schema:
 *           type: string
 *           enum: [generateHighlight, transcribe, summarize, diarize, generatePodcastSpec, processAgenda, generateVoiceprint, syncElasticsearch]
 *           example: generateHighlight
 *       - name: payload
 *         in: query
 *         description: Index of captured payload to use (0 = latest, 1 = second latest, etc.)
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *           example: 0
 *       - name: overrides
 *         in: query
 *         description: |
 *           Parameter overrides in dot-notation format.
 *           Format: `path:value,path2:value2`
 *           
 *           Examples:
 *           - `render.aspectRatio:social-9x16`
 *           - `render.includeCaptions:true,render.socialOptions.zoomFactor:0.8`
 *         schema:
 *           type: string
 *           example: "render.aspectRatio:social-9x16,render.includeCaptions:true"
 *     requestBody:
 *       description: Custom payload (overrides captured payload if provided)
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - $ref: '#/components/schemas/GenerateHighlightRequest'
 *               - $ref: '#/components/schemas/TranscribeRequest'
 *               - $ref: '#/components/schemas/SummarizeRequest'
 *               - $ref: '#/components/schemas/DiarizeRequest'
 *               - $ref: '#/components/schemas/ProcessAgendaRequest'
 *               - $ref: '#/components/schemas/FixTranscriptRequest'
 *               - $ref: '#/components/schemas/GeneratePodcastSpecRequest'
 *               - $ref: '#/components/schemas/SplitMediaFileRequest'
 *               - $ref: '#/components/schemas/GenerateVoiceprintRequest'
 *               - $ref: '#/components/schemas/SyncElasticsearchRequest'
 *           examples:
 *             generateHighlight:
 *               summary: Generate Highlight Request
 *               value:
 *                 media:
 *                   type: video
 *                   videoUrl: "https://example.com/video.mp4"
 *                 parts:
 *                   - id: "highlight-1"
 *                     utterances:
 *                       - utteranceId: "utterance-1"
 *                         startTimestamp: 10.5
 *                         endTimestamp: 25.3
 *                         text: "This is an important point"
 *                         speaker:
 *                           name: "John Doe"
 *                 render:
 *                   aspectRatio: "default"
 *                   includeCaptions: false
 *     responses:
 *       200:
 *         description: Task execution results
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/DevTestTaskSuccessResponse'
 *                 - $ref: '#/components/schemas/DevTestTaskErrorResponse'
 *       400:
 *         description: Parameter override failed or invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DevTestTaskErrorResponse'
 *       404:
 *         description: No captured payloads found or task not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DevTestTaskErrorResponse'
 *       500:
 *         description: Task execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DevTestTaskErrorResponse'
 */
// Generic development endpoint for testing any task type with parameter overrides
router.post('/test-task/:taskType', async (req: express.Request, res: express.Response) => {
    try {
        const { taskType } = req.params;
        console.log(`🧪 Testing task: ${taskType}`);
        
        const { payload: payloadIndex, overrides: overrideString } = req.query;
        const hasBodyPayload = req.body && Object.keys(req.body).length > 0;
        
        let testPayload: any;
        let testName = 'test';
        
        // Handle different scenarios
        if (hasBodyPayload) {
            // Scenario 1: Custom payload provided in body
            testPayload = { ...req.body, callbackUrl: 'dev-test', skipCapture: true };
            testName = 'custom';
            
        } else {
            // Scenario 2: Use captured payloads
            const capturedPayloads = await DevPayloadManager.getCapturedPayloads(taskType);
            
            if (capturedPayloads.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'No captured payloads found',
                    message: `Enable payload capture with CAPTURE_PAYLOADS=true and make a ${taskType} call first, or provide a custom payload in the request body`
                });
            }
            
            // Select payload (by index or latest)
            const selectedIndex = payloadIndex ? parseInt(payloadIndex as string) : 0;
            const selectedPayload = capturedPayloads[selectedIndex];
            
            if (!selectedPayload) {
                return res.status(404).json({
                    success: false,
                    error: `Payload index ${selectedIndex} not found`,
                    availableIndices: capturedPayloads.map((_, i) => i),
                    totalPayloads: capturedPayloads.length
                });
            }
            
            console.log(`📋 Using captured payload ${selectedIndex} from ${selectedPayload.timestamp}`);
            testPayload = { ...selectedPayload.payload, skipCapture: true };
            testName = `payload-${selectedIndex}`;
        }
        
        // Apply parameter overrides if provided
        if (overrideString && typeof overrideString === 'string') {
            console.log(`🔧 Applying parameter overrides: ${overrideString}`);
            
            const overrideResult = createTestPayload(testPayload, overrideString, true);
            
            if (!overrideResult.success) {
                return res.status(400).json({
                    success: false,
                    error: 'Parameter override failed',
                    message: 'Failed to apply parameter overrides',
                    errors: overrideResult.errors,
                    overrides: overrideString
                });
            }
            
            testPayload = overrideResult.payload;
            testName = `${testName}-with-overrides`;
        }
        
        console.log(`🎬 Testing ${testName}...`);
        
        // Execute test - import task dynamically
        let taskFunction;
        try {
            const taskModule = await import(`../tasks/${taskType}.js`);
            taskFunction = taskModule[taskType];
            
            if (!taskFunction) {
                throw new Error(`Task function '${taskType}' not found in module`);
            }
        } catch (error) {
            return res.status(404).json({
                success: false,
                error: `Task '${taskType}' not found or not importable`,
                message: error instanceof Error ? error.message : String(error)
            });
        }
        
        let result: any;
        let success = false;
        let error: string | undefined;
        
        try {
            result = await taskFunction(testPayload, (stage: string, progress: number) => {
                console.log(`🎬 ${testName} progress: ${stage} - ${progress}%`);
            });
            success = true;
            console.log(`✅ ${testName} successful!`);
            
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            console.error(`❌ ${testName} failed:`, err);
        }
        
        res.json({
            success,
            message: success ? 'Task test completed successfully' : 'Task test failed',
            taskType,
            testName,
            result: success ? result : undefined,
            error,
            payload: testPayload,
            overrides: overrideString ? parseOverrides(overrideString as string) : undefined
        });
        
    } catch (error) {
        console.error(`❌ Task test failed:`, error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Task test failed'
        });
    }
});


// Development endpoint for managing captured payloads (optionally filtered by task type)
router.get('/captured-payloads/:taskType?', async (req: express.Request, res: express.Response) => {
    try {
        const { taskType } = req.params;
        console.log(`📋 Fetching captured payloads${taskType ? ` for ${taskType}` : ''}...`);
        
        if (taskType) {
            // Get payloads for specific task type
            const payloads = await DevPayloadManager.getCapturedPayloads(taskType);
            const stats = await DevPayloadManager.getPayloadStats(taskType);
            
            res.json({
                success: true,
                message: `Found ${payloads.length} captured payloads for ${taskType}`,
                taskType,
                stats,
                payloads: payloads.map((p, index) => ({
                    index,
                    timestamp: p.timestamp,
                    note: p.note,
                    taskType: p.taskType
                }))
            });
        } else {
            // Get payloads for all task types
            const availableTaskTypes = await DevPayloadManager.getAvailableTaskTypes();
            const allPayloads: Record<string, any> = {};
            
            for (const type of availableTaskTypes) {
                const payloads = await DevPayloadManager.getCapturedPayloads(type);
                const stats = await DevPayloadManager.getPayloadStats(type);
                
                allPayloads[type] = {
                    count: payloads.length,
                    stats,
                    latestPayloads: payloads.slice(0, 5).map((p, index) => ({
                        index,
                        timestamp: p.timestamp,
                        note: p.note,
                        taskType: p.taskType
                    }))
                };
            }
            
            res.json({
                success: true,
                message: `Found payloads for ${availableTaskTypes.length} task types`,
                taskTypes: availableTaskTypes,
                payloadsByTask: allPayloads
            });
        }
        
    } catch (error) {
        console.error('❌ Failed to fetch captured payloads:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Failed to fetch captured payloads'
        });
    }
});



// Development endpoint for clearing captured payloads (optionally filtered by task type)
router.delete('/captured-payloads/:taskType?', async (req: express.Request, res: express.Response) => {
    try {
        const { taskType } = req.params;
        console.log(`🧹 Clearing captured payloads${taskType ? ` for ${taskType}` : ''}...`);
        
        await DevPayloadManager.clearPayloads(taskType);
        
        res.json({
            success: true,
            message: taskType 
                ? `All captured payloads cleared successfully for ${taskType}`
                : 'All captured payloads cleared successfully for all tasks'
        });
        
    } catch (error) {
        console.error('❌ Failed to clear captured payloads:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Failed to clear captured payloads'
        });
    }
});


export default router; 