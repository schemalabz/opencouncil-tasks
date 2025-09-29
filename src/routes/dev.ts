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

export interface DevTestTaskBatchResponse {
    success: boolean;
    message: string;
    taskType: string;
    videoLinks: string[]; // Top-level array for easy access to generated videos
    results: Array<{
        combination: string;
        success: boolean;
        result?: any;
        error?: string;
        errors?: string[];
        payloadIndex: number;
        overrideString: string;
    }>;
    summary: {
        total: number;
        successful: number;
        failed: number;
    };
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
 *     summary: Test task with captured payloads and parameter overrides (supports batch testing)
 *     description: |
 *       Execute a task using captured payloads with optional parameter overrides.
 *       This endpoint supports batch testing with Cartesian product combinations:
 *       
 *       1. **Use captured payloads** - Test with real data captured during development
 *       2. **Parameter overrides** - Modify specific parameters without creating variations
 *       3. **Custom payloads** - Provide completely custom payload in request body
 *       4. **Batch testing** - Test multiple payloads × multiple override combinations
 *       
 *       ## Batch Testing Examples:
 *       - `payload=0,1&overrides=render.aspectRatio:social-9x16;render.aspectRatio:default`
 *         Tests: payload-0+social, payload-0+default, payload-1+social, payload-1+default
 *       - `payload=0&overrides=render.aspectRatio:social-9x16;render.includeCaptions:true;render.includeSpeakerOverlay:true`
 *         Tests: payload-0+social, payload-0+captions, payload-0+speaker
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
 *         description: |
 *           Index(es) of captured payload(s) to use. Can be single value or comma-separated array.
 *           Examples: `0`, `0,1,2`, `1,3`
 *           Default: 0
 *         schema:
 *           oneOf:
 *             - type: integer
 *               minimum: 0
 *               example: 0
 *             - type: string
 *               pattern: '^[0-9]+(,[0-9]+)*$'
 *               example: "0,1,2"
 *       - name: overrides
 *         in: query
 *         description: |
 *           Parameter overrides in dot-notation format. Use semicolon (;) to separate different override sets.
 *           Each override set will be combined with each payload.
 *           
 *           Within each override set, use commas to combine multiple parameters:
 *           - `render.aspectRatio:social-9x16,render.includeCaptions:true` (single execution with both overrides)
 *           
 *           Use semicolons to create separate executions:
 *           - `render.aspectRatio:social-9x16;render.aspectRatio:default` (two separate executions)
 *           
 *           Examples:
 *           - `render.aspectRatio:social-9x16` (single override)
 *           - `render.aspectRatio:social-9x16;render.aspectRatio:default` (two separate executions)
 *           - `render.aspectRatio:social-9x16,render.includeCaptions:true;render.includeSpeakerOverlay:true` (two executions)
 *         schema:
 *           oneOf:
 *             - type: string
 *               example: "render.aspectRatio:social-9x16"
 *             - type: string
 *               example: "render.aspectRatio:social-9x16;render.aspectRatio:default"
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
 *         description: Task execution results (single or batch)
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/DevTestTaskSuccessResponse'
 *                 - $ref: '#/components/schemas/DevTestTaskBatchResponse'
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
        
        const { payload: payloadParam, overrides: overridesParam } = req.query;
        const hasBodyPayload = req.body && Object.keys(req.body).length > 0;
        
        // Parse overrides as arrays
        const overrideStrings = Array.isArray(overridesParam)
            ? overridesParam as string[]
            : overridesParam
                ? [(overridesParam as string)]
                : [''];
        
        // Split each override string by semicolon to get individual override sets
        // This preserves comma-separated overrides within each set
        const allOverrideSets: string[] = [];
        for (const overrideString of overrideStrings) {
            if (overrideString && overrideString.trim() !== '') {
                // Split by semicolon to get individual override sets
                const sets = overrideString.split(';').map(s => s.trim()).filter(s => s !== '');
                allOverrideSets.push(...sets);
            }
        }
        
        // If no semicolons found, treat the whole string as one override set
        const validOverrides = allOverrideSets.length > 0 ? allOverrideSets : [''];
        
        // Determine payload indices based on whether custom payload is provided
        let payloadIndices: number[];
        let capturedPayloads: any[] = [];
        
        if (hasBodyPayload) {
            // When custom payload is provided, ignore payload query param
            payloadIndices = [0]; // Single index for custom payload
            console.log(`📋 Using custom payload from request body`);
        } else {
            // Parse payload indices from query param
            payloadIndices = Array.isArray(payloadParam) 
                ? payloadParam.map(p => parseInt(p as string))
                : payloadParam 
                    ? (payloadParam as string).split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p))
                    : [0];
            
            // Get captured payloads
            capturedPayloads = await DevPayloadManager.getCapturedPayloads(taskType);
            
            if (capturedPayloads.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'No captured payloads found',
                    message: `Enable payload capture with CAPTURE_PAYLOADS=true and make a ${taskType} call first, or provide a custom payload in the request body`
                });
            }
            
            // Validate payload indices BEFORE generating combinations
            const invalidIndices = payloadIndices.filter(idx => idx < 0 || idx >= capturedPayloads.length);
            if (invalidIndices.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid payload indices: ${invalidIndices.join(', ')}`,
                    message: `Payload indices must be between 0 and ${capturedPayloads.length - 1}`,
                    availableIndices: Array.from({ length: capturedPayloads.length }, (_, i) => i),
                    totalPayloads: capturedPayloads.length
                });
            }
            
            console.log(`📋 Payload indices: [${payloadIndices.join(', ')}]`);
        }
        
        console.log(`🔧 Override sets: [${validOverrides.map(o => `"${o}"`).join(', ')}]`);
        
        // Import task function once
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
        
        // Generate all combinations (Cartesian product)
        // Note: payloadIndices are already validated, so no need for bounds checking
        const combinations: Array<{payloadIndex: number, overrideString: string, testName: string}> = [];
        
        for (const payloadIndex of payloadIndices) {
            for (const overrideString of validOverrides) {
                const baseTestName = hasBodyPayload ? 'custom' : `payload-${payloadIndex}`;
                const testName = overrideString ? `${baseTestName}-with-overrides` : baseTestName;
                
                combinations.push({ payloadIndex, overrideString, testName });
            }
        }
        
        console.log(`🎬 Executing ${combinations.length} combination${combinations.length === 1 ? '' : 's'}...`);
        
        // Execute all combinations sequentially
        const results: any[] = [];
        const videoLinks: string[] = [];
        
        for (let i = 0; i < combinations.length; i++) {
            const { payloadIndex, overrideString, testName } = combinations[i];
            console.log(`🎬 [${i + 1}/${combinations.length}] Testing ${testName}...`);
            
            try {
                // Prepare payload
                let testPayload: any;
                if (hasBodyPayload) {
                    testPayload = { ...req.body, callbackUrl: 'dev-test', skipCapture: true };
                } else {
                    const selectedPayload = capturedPayloads[payloadIndex];
                    testPayload = { ...selectedPayload.payload, skipCapture: true };
                }
                
                // Apply overrides
                if (overrideString) {
                    const overrideResult = createTestPayload(testPayload, overrideString, true);
                    
                    if (!overrideResult.success) {
                        results.push({
                            combination: `${testName} (${overrideString})`,
                            success: false,
                            error: 'Parameter override failed',
                            errors: overrideResult.errors,
                            payloadIndex,
                            overrideString
                        });
                        continue;
                    }
                    
                    testPayload = overrideResult.payload;
                }
                
                // Execute task
                const result = await taskFunction(testPayload, (stage: string, progress: number) => {
                    console.log(`🎬 ${testName} progress: ${stage} - ${progress}%`);
                });
                
                console.log(`✅ ${testName} successful!`);
                
                // Extract video links for easy access
                if (result && result.parts && Array.isArray(result.parts)) {
                    result.parts.forEach((part: any) => {
                        if (part.url) {
                            videoLinks.push(part.url);
                        }
                    });
                }
                
                results.push({
                    combination: `${testName} (${overrideString || 'no overrides'})`,
                    success: true,
                    result,
                    payloadIndex,
                    overrideString
                });
                
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                console.error(`❌ ${testName} failed:`, err);
                
                results.push({
                    combination: `${testName} (${overrideString || 'no overrides'})`,
                    success: false,
                    error,
                    payloadIndex,
                    overrideString
                });
            }
        }
        
        const successCount = results.filter(r => r.success).length;
        const totalCount = results.length;
        
        console.log(`🎬 Batch test completed: ${successCount}/${totalCount} successful`);
        
        res.json({
            success: successCount > 0,
            message: `Batch test completed: ${successCount}/${totalCount} combinations successful`,
            taskType,
            videoLinks, // Top-level array for easy access
            results, // Detailed results
            summary: {
                total: totalCount,
                successful: successCount,
                failed: totalCount - successCount
            }
        });
        
    } catch (error) {
        console.error(`❌ Batch test failed:`, error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Batch test failed'
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