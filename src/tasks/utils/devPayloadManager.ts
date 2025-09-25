import fs from 'fs';
import path from 'path';
import { TaskRequest } from '../../types.js';

export interface CaptureConfig {
  enabled: boolean;
  taskTypes: string[] | 'all';
  storage: {
    baseDirectory: string;
    keepLatest: boolean;
    maxFilesPerTask: number;
  };
  sanitization: {
    removeCallbackUrls: boolean;
    customSanitizers: Record<string, (payload: any) => any>;
  };
}

export interface CapturedPayload<T extends TaskRequest = any> {
  timestamp: string;
  note: string;
  taskType: string;
  payload: T;
}

export class DevPayloadManager {
  private static config: CaptureConfig;

  static initialize(validTaskTypes?: string[]): void {
    let requestedTaskTypes: string[] | 'all' = process.env.CAPTURE_TASK_TYPES?.split(',') || 'all';
    
    // Validate task types if validTaskTypes is provided
    if (validTaskTypes && requestedTaskTypes !== 'all') {
      const invalidTaskTypes = requestedTaskTypes.filter(taskType => 
        !validTaskTypes.includes(taskType.trim())
      );
      
      if (invalidTaskTypes.length > 0) {
        console.warn(`⚠️  Invalid task types in CAPTURE_TASK_TYPES: ${invalidTaskTypes.join(', ')}`);
        console.warn(`📋 Valid task types: ${validTaskTypes.join(', ')}`);
        console.warn(`🔧 Falling back to capturing all task types`);
        requestedTaskTypes = 'all';
      }
    }

    this.config = {
      enabled: process.env.CAPTURE_PAYLOADS === 'true',
      taskTypes: requestedTaskTypes,
      storage: {
        baseDirectory: path.join(process.env.DATA_DIR || './data', 'dev-payloads'),
        keepLatest: true,
        maxFilesPerTask: parseInt(process.env.PAYLOAD_MAX_FILES_PER_TASK || '10', 10)
      },
      sanitization: {
        removeCallbackUrls: true,
        customSanitizers: {}
      }
    };
  }

  static getConfig(): CaptureConfig {
    if (!this.config) {
      this.initialize();
    }
    return this.config;
  }

  static shouldCapture<T extends TaskRequest>(taskType: string, payload: T): boolean {
    const config = this.getConfig();
    
    if (!config.enabled) {
      return false;
    }

    // Skip capture if explicitly disabled for this request
    if ((payload as any).skipCapture === true) {
      return false;
    }

    // Check if task type is enabled
    if (config.taskTypes === 'all') {
      return true;
    }

    return config.taskTypes.includes(taskType);
  }

  static async capture<T extends TaskRequest>(taskType: string, payload: T): Promise<void> {
    if (!this.shouldCapture(taskType, payload)) {
      return;
    }

    try {
      const config = this.getConfig();
      const sanitizedPayload = this.sanitizePayload(taskType, payload);
      
      // Add metadata
      const capturedPayload: CapturedPayload<T> = {
        taskType,
        timestamp: new Date().toISOString(),
        note: 'Captured from API call',
        payload: sanitizedPayload
      };

      await this.storePayload(taskType, capturedPayload);
      
      console.log(`📝 Payload captured for task: ${taskType}`);
      
    } catch (error) {
      console.error(`Failed to capture payload for ${taskType}:`, error);
    }
  }

  private static sanitizePayload<T extends TaskRequest>(taskType: string, payload: T): T {
    const config = this.getConfig();
    let sanitized = { ...payload };

    // Remove callback URLs if configured
    if (config.sanitization.removeCallbackUrls) {
      sanitized.callbackUrl = 'dev-test';
    }

    // Apply custom sanitizers
    const customSanitizer = config.sanitization.customSanitizers[taskType];
    if (customSanitizer) {
      sanitized = customSanitizer(sanitized);
    }

    return sanitized;
  }

  private static async storePayload<T extends TaskRequest>(taskType: string, payload: CapturedPayload<T>): Promise<void> {
    const config = this.getConfig();
    const payloadsDir = config.storage.baseDirectory;
    
    // Ensure directory exists
    await fs.promises.mkdir(payloadsDir, { recursive: true });
    
    // Generate filename with timestamp
    const timestamp = payload.timestamp.replace(/[:.]/g, '-');
    const filename = `${taskType}-payload-${timestamp}.json`;
    const filepath = path.join(payloadsDir, filename);
    
    // Write timestamped file
    await fs.promises.writeFile(
      filepath, 
      JSON.stringify(payload, null, 2)
    );
    
    // Update latest file if configured
    if (config.storage.keepLatest) {
      const latestPath = path.join(payloadsDir, `${taskType}-latest.json`);
      await fs.promises.writeFile(
        latestPath,
        JSON.stringify(payload, null, 2)
      );
    }

    // Clean up old files if needed
    await this.cleanupOldFiles(payloadsDir, taskType, config.storage.maxFilesPerTask);
  }

  private static async cleanupOldFiles(directory: string, taskType: string, maxFiles: number): Promise<void> {
    try {
      const files = await fs.promises.readdir(directory);
      const payloadFiles = files
        .filter(file => file.startsWith(`${taskType}-payload-`) && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(directory, file),
          stats: fs.statSync(path.join(directory, file))
        }))
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

      // Remove excess files
      if (payloadFiles.length > maxFiles) {
        const filesToDelete = payloadFiles.slice(maxFiles);
        
        for (const file of filesToDelete) {
          await fs.promises.unlink(file.path);
        }
        
        console.log(`🧹 Cleaned up ${filesToDelete.length} old payload files for ${taskType}`);
      }
    } catch (error) {
      console.error('Failed to cleanup old files:', error);
    }
  }

  /**
   * Get payloads directory
   */
  private static getPayloadsDir(): string {
    const config = this.getConfig();
    return config.storage.baseDirectory;
  }

  /**
   * Get all captured payloads for a task type
   */
  static async getCapturedPayloads<T extends TaskRequest = any>(taskType?: string): Promise<CapturedPayload<T>[]> {
    try {
      const payloadsDir = this.getPayloadsDir();
      
      if (!fs.existsSync(payloadsDir)) {
        return [];
      }

      const files = await fs.promises.readdir(payloadsDir);
      let payloadFiles: string[];

      if (taskType) {
        // Filter for specific task type
        payloadFiles = files.filter(file => 
          file.startsWith(`${taskType}-payload-`) && file.endsWith('.json')
        );
      } else {
        // Get all payload files (excluding latest files)
        payloadFiles = files.filter(file => 
          file.includes('-payload-') && file.endsWith('.json')
        );
      }

      const payloads: CapturedPayload<T>[] = [];
      
      for (const file of payloadFiles) {
        try {
          const filePath = path.join(payloadsDir, file);
          const content = await fs.promises.readFile(filePath, 'utf8');
          const payload = JSON.parse(content) as CapturedPayload<T>;
          
          // Filter by task type if specified and the payload doesn't match
          if (taskType && payload.taskType !== taskType) {
            continue;
          }
          
          payloads.push(payload);
        } catch (error) {
          console.error(`Failed to read payload file ${file}:`, error);
        }
      }

      // Sort by timestamp (newest first)
      return payloads.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

    } catch (error) {
      console.error('Failed to get captured payloads:', error);
      return [];
    }
  }

  /**
   * Get the latest captured payload for a task type
   */
  static async getLatestPayload<T extends TaskRequest = any>(taskType: string): Promise<CapturedPayload<T> | null> {
    try {
      const latestPath = path.join(this.getPayloadsDir(), `${taskType}-latest.json`);
      
      if (!fs.existsSync(latestPath)) {
        return null;
      }

      const content = await fs.promises.readFile(latestPath, 'utf8');
      return JSON.parse(content) as CapturedPayload<T>;
    } catch (error) {
      console.error('Failed to get latest payload:', error);
      return null;
    }
  }

  /**
   * Get payload by timestamp for a task type
   */
  static async getPayloadByTimestamp<T extends TaskRequest = any>(
    taskType: string, 
    timestamp: string
  ): Promise<CapturedPayload<T> | null> {
    try {
      const payloads = await this.getCapturedPayloads<T>(taskType);
      return payloads.find(p => p.timestamp === timestamp) || null;
    } catch (error) {
      console.error('Failed to get payload by timestamp:', error);
      return null;
    }
  }


  /**
   * Get statistics about captured payloads for a task type
   */
  static async getPayloadStats(taskType?: string): Promise<{
    total: number;
    latest: string | null;
  }> {
    try {
      const payloads = await this.getCapturedPayloads(taskType);

      return {
        total: payloads.length,
        latest: payloads.length > 0 ? payloads[0].timestamp : null
      };
    } catch (error) {
      console.error('Failed to get payload stats:', error);
      return {
        total: 0,
        latest: null
      };
    }
  }

  /**
   * Clear all captured payloads for a task type (or all if no task type specified)
   */
  static async clearPayloads(taskType?: string): Promise<void> {
    try {
      const payloadsDir = this.getPayloadsDir();
      
      if (!fs.existsSync(payloadsDir)) {
        return;
      }

      const files = await fs.promises.readdir(payloadsDir);
      
      if (taskType) {
        // Clear specific task type
        const filesToClear = files.filter(file => 
          (file.startsWith(`${taskType}-payload-`) || file === `${taskType}-latest.json`) && 
          file.endsWith('.json')
        );
        
        for (const file of filesToClear) {
          await fs.promises.unlink(path.join(payloadsDir, file));
        }

        console.log(`✅ All captured payloads cleared for task: ${taskType}`);
      } else {
        // Clear all payload files
        const payloadFiles = files.filter(file => 
          (file.includes('-payload-') || file.includes('-latest.json')) && 
          file.endsWith('.json')
        );
        
        for (const file of payloadFiles) {
          await fs.promises.unlink(path.join(payloadsDir, file));
        }
        
        console.log('✅ All captured payloads cleared for all tasks');
      }
    } catch (error) {
      console.error('Failed to clear payloads:', error);
      throw error;
    }
  }

  /**
   * Get all available task types that have captured payloads
   */
  static async getAvailableTaskTypes(): Promise<string[]> {
    try {
      const payloadsDir = this.getPayloadsDir();
      
      if (!fs.existsSync(payloadsDir)) {
        return [];
      }

      const files = await fs.promises.readdir(payloadsDir);
      const taskTypes = new Set<string>();
      
      // Extract task types from filenames
      for (const file of files) {
        if (file.includes('-payload-') && file.endsWith('.json')) {
          const taskType = file.split('-payload-')[0];
          taskTypes.add(taskType);
        } else if (file.includes('-latest.json')) {
          const taskType = file.replace('-latest.json', '');
          taskTypes.add(taskType);
        }
      }
      
      return Array.from(taskTypes).sort();
    } catch (error) {
      console.error('Failed to get task types:', error);
      return [];
    }
  }
} 