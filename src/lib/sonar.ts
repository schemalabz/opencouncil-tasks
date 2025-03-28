import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';
import { SubjectContext, Subject } from '../types.js';

dotenv.config();

// --- Add logging function ---
const logFilePath = path.join(process.cwd(), 'sonar.log');
async function logToFile(message: string, data?: any) {
    const timestamp = new Date().toISOString();
    let logEntry = `${timestamp} - ${message}`;
    if (data) {
        // Handle potential circular structures in data
        try {
            logEntry += `:\n${JSON.stringify(data, null, 2)}`;
        } catch (e) {
            logEntry += `:\n<Error: Could not stringify data - ${e instanceof Error ? e.message : String(e)}>`;
        }
    }
    logEntry += '\n---\n'; // Separator for readability
    try {
        await fs.appendFile(logFilePath, logEntry);
    } catch (err) {
        console.error('Failed to write to sonar log file:', err);
    }
}
// --- End logging function ---

// Interface for the Perplexity Sonar API request
interface SonarApiRequest {
    model: string;
    messages: SonarMessage[];
}

// Interface for messages sent to the Sonar API
interface SonarMessage {
    role: 'system' | 'user';
    content: string;
}


// Interface for the Perplexity Sonar API response
interface SonarApiResponse {
    id: string;
    model: string;
    choices: {
        index: number;
        message: {
            role: string;
            content: string;
        };
    }[];
    citations: string[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

/**
 * Get context information about a subject using the Perplexity Sonar API
 * @param subjectName The name of the subject to get context for
 * @param subjectDescription Additional description for the subject
 * @param cityName The name of the city where the council meeting took place
 * @param date The date of the council meeting
 * @returns A Promise resolving to a SubjectContext object
 */
export async function getSubjectContext({ subjectName, subjectDescription, cityName, date }: { subjectName: string, subjectDescription: string, cityName: string, date: string }): Promise<SubjectContext> {
    const apiKey = process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
        throw new Error('Perplexity API key not found in environment variables');
    }

    // Construct the query for the Sonar API
    const query = `Την ημερομοηνία ${date} συζητήθηκε στο δημοτικό συμβούλιο της Αθήνας το θέμα "${subjectName}". 
  Περιγραφή θέματος: ${subjectDescription}.`;

    // Prepare the request to the Sonar API
    const request: SonarApiRequest = {
        model: 'sonar-pro',
        messages: [
            {
                role: 'system',
                content: 'You are a system providing useful context from the web for subjects extracted from the transcript of a council meeting. Be precise and concise. Do not use information from opencouncil.gr. Do not include information about what happened in the meeting, but rather provide context that can help the user understand the subject, related entities, and surrounding context and events. Format your answers in markdown.'
            },
            {
                role: 'user',
                content: query
            }
        ]
    };

    try {
        // Call the Perplexity Sonar API
        await logToFile("Sonar Request", request);

        const response = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Perplexity API error: ${response.status} - ${errorText}`);
        }

        const data: SonarApiResponse = await response.json();
        await logToFile("Sonar Response", data);

        if (!data.choices || data.choices.length === 0) {
            throw new Error('No response from Perplexity Sonar API');
        }

        if (!data.citations || data.citations.length === 0) {
            throw new Error('No citations from Perplexity Sonar API');
        }

        // Extract the content from the response
        const content = data.choices[0].message.content;

        return {
            text: content,
            citationUrls: data.citations
        };
    } catch (error) {
        console.error('Error querying Perplexity Sonar API:', error);
        await logToFile("Error querying Perplexity Sonar API", error);
        throw error;
    }
}

/**
 * Enhances a subject with context information from the Perplexity Sonar API
 
 * @returns A Promise resolving to the enhanced subject
 */
export async function enhanceSubjectWithContext({ subject, cityName, date }: { subject: Subject, cityName: string, date: string }) {
    try {
        const context = await getSubjectContext({ subjectName: subject.name, subjectDescription: subject.description, cityName, date });
        return {
            ...subject,
            context
        };
    } catch (error) {
        console.error(`Failed to enhance subject "${subject.name}" with context:`, error);
        return {
            ...subject,
            context: null
        };

    }
}
