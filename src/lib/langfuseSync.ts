/**
 * Langfuse trace syncing functionality
 * 
 * This module provides utilities to sync traces from Langfuse cloud to local JSON files.
 * Used for development-time caching and offline iteration on AI workflows.
 */

import { langfuse } from './aiClient.js';
import type { ApiTrace, ApiObservation } from 'langfuse';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Custom result type for sync operations
 * (Langfuse SDK doesn't provide this)
 */
export interface SyncTraceResult {
  success: boolean;
  filepath?: string;
  observationCount?: number;
  totalTokens?: number;
  error?: string;
}

/**
 * Sync a trace from Langfuse cloud to a local JSON file
 * 
 * @param sessionId - The Langfuse sessionId to fetch
 * @param taskType - Task type for organizing files
 * @param timestamp - Timestamp for filename matching with payload
 * @returns Result with filepath and stats
 */
export async function syncTraceFromLangfuse(
  sessionId: string,
  taskType: string,
  timestamp: string
): Promise<SyncTraceResult> {
  if (!langfuse) {
    return {
      success: false,
      error: 'Langfuse not configured - set LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY'
    };
  }

  try {
    // Fetch trace from Langfuse using sessionId
    console.log(`📡 Fetching trace from Langfuse (sessionId: ${sessionId})...`);
    
    // Use Langfuse client to fetch traces by sessionId
    const traces = await langfuse.fetchTraces({
      sessionId: sessionId,
      limit: 1
    });

    if (!traces.data || traces.data.length === 0) {
      return {
        success: false,
        error: `No traces found for sessionId: ${sessionId}`
      };
    }

    const trace = traces.data[0];
    
    // Fetch full trace details including observations
    const fullTrace = await langfuse.fetchTrace(trace.id);
    
    if (!fullTrace) {
      return {
        success: false,
        error: `Failed to fetch full trace details for: ${trace.id}`
      };
    }

    // Extract observations from the trace data
    // The Langfuse SDK returns trace data with observations embedded
    const traceData = fullTrace.data || fullTrace;
    const observations = (traceData as any).observations || [];
    const totalTokens = observations.reduce((sum: number, obs: any) => {
      const usage = obs.usage;
      if (usage && typeof usage.total === 'number') {
        return sum + usage.total;
      }
      return sum;
    }, 0);

    // Save to local file
    const payloadsDir = path.join(process.env.DATA_DIR || './data', 'dev-payloads');
    await fs.promises.mkdir(payloadsDir, { recursive: true });

    const timestampFormatted = timestamp.replace(/[:.]/g, '-');
    const filename = `${taskType}-trace-${timestampFormatted}.json`;
    const filepath = path.join(payloadsDir, filename);

    // Write trace data (raw Langfuse format)
    // Store the .data property if it exists, otherwise the whole object
    const dataToStore = fullTrace.data || fullTrace;
    await fs.promises.writeFile(
      filepath,
      JSON.stringify(dataToStore, null, 2)
    );

    console.log(`✅ Trace synced to: ${filename}`);
    console.log(`   Observations: ${observations.length}, Tokens: ${totalTokens}`);

    return {
      success: true,
      filepath,
      observationCount: observations.length,
      totalTokens
    };

  } catch (error: any) {
    console.error('Failed to sync trace from Langfuse:', error);
    return {
      success: false,
      error: error.message || 'Unknown error'
    };
  }
}

/**
 * Check if a trace file already exists for a given payload
 * 
 * @param taskType - Task type
 * @param timestamp - ISO timestamp from payload
 * @returns True if trace file exists
 */
export async function traceFileExists(taskType: string, timestamp: string): Promise<boolean> {
  try {
    const payloadsDir = path.join(process.env.DATA_DIR || './data', 'dev-payloads');
    const timestampFormatted = timestamp.replace(/[:.]/g, '-');
    const filename = `${taskType}-trace-${timestampFormatted}.json`;
    const filepath = path.join(payloadsDir, filename);
    
    return fs.existsSync(filepath);
  } catch {
    return false;
  }
}

/**
 * Load a local trace file
 * 
 * @param taskType - Task type
 * @param timestamp - ISO timestamp from payload
 * @returns Trace data (with observations) or null if not found
 */
export async function loadLocalTrace(
  taskType: string,
  timestamp: string
): Promise<(ApiTrace & { observations?: ApiObservation[] }) | null> {
  try {
    const payloadsDir = path.join(process.env.DATA_DIR || './data', 'dev-payloads');
    const timestampFormatted = timestamp.replace(/[:.]/g, '-');
    const filename = `${taskType}-trace-${timestampFormatted}.json`;
    const filepath = path.join(payloadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return null;
    }

    const content = await fs.promises.readFile(filepath, 'utf8');
    return JSON.parse(content) as ApiTrace & { observations?: ApiObservation[] };
  } catch (error) {
    console.error('Failed to load local trace:', error);
    return null;
  }
}

/**
 * Get list of all synced trace files
 * 
 * @param taskType - Optional filter by task type
 * @returns Array of trace filenames
 */
export async function listSyncedTraces(taskType?: string): Promise<string[]> {
  try {
    const payloadsDir = path.join(process.env.DATA_DIR || './data', 'dev-payloads');
    
    if (!fs.existsSync(payloadsDir)) {
      return [];
    }

    const files = await fs.promises.readdir(payloadsDir);
    
    let traceFiles = files.filter(file => file.includes('-trace-') && file.endsWith('.json'));
    
    if (taskType) {
      traceFiles = traceFiles.filter(file => file.startsWith(`${taskType}-trace-`));
    }
    
    return traceFiles.sort();
  } catch (error) {
    console.error('Failed to list synced traces:', error);
    return [];
  }
}

