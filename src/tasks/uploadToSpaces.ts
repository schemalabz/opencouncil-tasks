import { S3 } from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Task } from './pipeline';
let mime: any;
dotenv.config();

interface UploadFilesArgs {
    files: string | string[];
    spacesPath: string;
}

export const uploadToSpaces: Task<UploadFilesArgs, string[]> = async ({ files, spacesPath }, onProgress) => {
    const spacesEndpoint = new S3({
        endpoint: process.env.DO_SPACES_ENDPOINT,
        accessKeyId: process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET,
        region: "fra1"
    });

    const bucketName = process.env.DO_SPACES_BUCKET;

    if (!bucketName) {
        throw new Error('SPACES_BUCKET environment variable is not set');
    }

    const filesToUpload = Array.isArray(files) ? files : [files];
    const uploadedUrls: string[] = [];


    await spacesEndpoint.putObject({
        Bucket: bucketName,
        Key: `${spacesPath}/`,
        Body: '',
        ACL: 'public-read'
    }).promise();

    for (let i = 0; i < filesToUpload.length; i++) {
        const file = filesToUpload[i];
        const fileName = path.basename(file);
        const fileContent = fs.readFileSync(file);

        if (!mime) {
            mime = await import('mime/lite');
        }

        const contentType = mime.lookup(file);
        if (!contentType) {
            throw new Error(`Content type for file ${file} not found`);
        }

        const params = {
            Bucket: bucketName,
            Key: `${spacesPath}/${fileName}`,
            Body: fileContent,
            ContentType: contentType,
            ACL: 'public-read',
        };

        try {
            const result = await spacesEndpoint.upload(params).promise();
            uploadedUrls.push(`${process.env.CDN_BASE_URL}/${spacesPath}/${fileName}`);
            onProgress("uploading", ((i + 1) / filesToUpload.length) * 100);
        } catch (error) {
            console.error(`Error uploading file ${fileName}:`, error);
            throw error;
        }
    }

    return uploadedUrls;
};
