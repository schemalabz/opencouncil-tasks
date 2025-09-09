import express from 'express';
import fs from 'fs';
import path from 'path';
import { uploadToSpaces } from '../tasks/uploadToSpaces.js';
import aws from 'aws-sdk';
const S3 = aws.S3;

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

export default router; 