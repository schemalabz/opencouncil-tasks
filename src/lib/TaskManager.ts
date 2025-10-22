import express from 'express';
import { Task } from '../tasks/pipeline.js';
import { TaskUpdate, TaskRequest } from '../types.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { DevPayloadManager } from '../tasks/utils/devPayloadManager.js';
import { runWithTelemetryContext } from './telemetryContext.js';
import { randomUUID } from 'crypto';

// Task metadata interface
export interface TaskMetadata {
  path?: string;
  summary: string;
  description: string;
  tags?: string[];
  security?: boolean; // defaults to true
}

// Global task registry - maps task functions to their metadata
const taskRegistry = new Map<Task<any, any>, TaskMetadata>();

// Symbol used to tag route handlers with their associated task for later path resolution
export const ROUTE_TASK_SYMBOL: unique symbol = Symbol('route_task');

dotenv.config();

type RunningTask = Omit<TaskUpdate<any>, "result" | "error"> & {
    createdAt: Date,
    lastUpdatedAt: Date,
    taskType: string,
    version?: number
};

// Common parameters for task execution
type TaskExecutionParams<T, R> = {
    task: Task<T, R>;
    input: T;
    callbackUrl: string;
    taskType: string;
    version?: number;
    capturePayload?: boolean;
};

// Task queue item with all necessary information to run a task
type QueuedTask<T, R> = TaskExecutionParams<T, R> & {
    createdAt: Date;
};

class TaskManager {
    private runningTasks: Map<string, RunningTask> = new Map();
    private taskQueue: Array<QueuedTask<any, any>> = [];
    private taskCounter: number = 0;
    private maxParallelTasks: number;

    constructor() {
        this.maxParallelTasks = parseInt(process.env.MAX_PARALLEL_TASKS || '10', 10);
        if (isNaN(this.maxParallelTasks)) {
            this.maxParallelTasks = 10; // Default to 10 if parsing fails
            console.warn('Invalid MAX_PARALLEL_TASKS in .env, using default of 10');
        }
    }

    public getTaskUpdates(): RunningTask[] {
        return Array.from(this.runningTasks.values());
    }

    public getQueuedTasksCount(): number {
        return this.taskQueue.length;
    }

    public async finish(): Promise<void> {
        while (this.runningTasks.size > 0 || this.taskQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    private processQueue(): void {
        // Process tasks from the queue if we have capacity
        while (this.runningTasks.size < this.maxParallelTasks && this.taskQueue.length > 0) {
            const nextTask = this.taskQueue.shift();
            if (nextTask) {
                this.executeTask(nextTask);
            }
        }
    }

    private async executeTask<T, R>(params: TaskExecutionParams<T, R>): Promise<void> {
        const { 
            task, 
            input, 
            callbackUrl, 
            taskType, 
            version, 
            capturePayload = true 
        } = params;
        const taskId = `task_${++this.taskCounter}`;
        const createdAt = new Date();
        
        // Create sessionId for Langfuse grouping (groups all AI calls in this task)
        const sessionId = `${taskType}-${Date.now()}-${randomUUID().slice(0, 8)}`;
        
        // Capture payload with sessionId (if enabled)
        if (capturePayload) {
            DevPayloadManager.capture(taskType, input as any, sessionId).catch(error => {
                console.error(`Failed to capture payload for ${taskType}:`, error);
            });
        }
        
        // Run task within telemetry context
        await runWithTelemetryContext(
            { sessionId, taskType, taskId },
            async () => {
                try {
                    this.runningTasks.set(taskId, {
                        status: "processing",
                        stage: "initializing",
                        progressPercent: 0,
                        createdAt,
                        lastUpdatedAt: createdAt,
                        taskType,
                        version
                    });
                    
                    console.log(`🔍 Task ${taskType} [${taskId}] - Langfuse sessionId: ${sessionId}`);

                    const result = await task(input, (stage, progressPercent) => {
                        const now = new Date();
                        const update: RunningTask = {
                            status: "processing",
                            stage,
                            progressPercent,
                            createdAt,
                            lastUpdatedAt: now,
                            taskType,
                            version
                        };
                        this.runningTasks.set(taskId, update);
                        this.sendCallback(callbackUrl, update);
                    });

                    const finalUpdate: TaskUpdate<R> & { createdAt: Date, lastUpdatedAt: Date, taskType: string } = {
                        status: "success",
                        stage: "finished",
                        progressPercent: 100,
                        result,
                        createdAt,
                        lastUpdatedAt: new Date(),
                        taskType,
                        version
                    };
                    await this.sendCallback(callbackUrl, finalUpdate);
                } catch (error: any) {
                    const errorUpdate: TaskUpdate<any> & { createdAt: Date, lastUpdatedAt: Date, taskType: string } = {
                        status: "error",
                        stage: "finished",
                        progressPercent: 100,
                        error: error.message,
                        createdAt,
                        lastUpdatedAt: new Date(),
                        taskType,
                        version
                    };
                    await this.sendCallback(callbackUrl, errorUpdate);
                    console.error('Error in task:', error);
                } finally {
                    this.runningTasks.delete(taskId);
                    // Process the queue after a task finishes
                    this.processQueue();
                }
            }
        );
    }

    public async runTaskWithCallback<T, R>(params: TaskExecutionParams<T, R>): Promise<void> {
        const { task, input, callbackUrl, taskType, version, capturePayload = true } = params;
        // Check if we've reached the maximum number of parallel tasks
        if (this.runningTasks.size >= this.maxParallelTasks) {
            // Queue the task
            const queuedTask: QueuedTask<T, R> = {
                task,
                input,
                callbackUrl,
                taskType,
                createdAt: new Date(),
                version,
                capturePayload // Preserve capturePayload flag for when task is dequeued
            };
            this.taskQueue.push(queuedTask);
            console.log(`Task ${taskType} queued. Current queue size: ${this.taskQueue.length}`);

            // Send a callback to inform that the task is queued
            await this.sendCallback(callbackUrl, {
                status: "processing",
                stage: "queued",
                progressPercent: 0,
                createdAt: queuedTask.createdAt,
                lastUpdatedAt: queuedTask.createdAt,
                taskType,
                version
            });
        } else {
            // Execute the task immediately
            await this.executeTask({ task, input, callbackUrl, taskType, version, capturePayload });
        }
    }

    /**
     * Register task metadata for Swagger generation
     */
    public registerTaskMetadata(task: Task<any, any>, metadata: TaskMetadata): void {
        taskRegistry.set(task, metadata);
    }

    /**
     * Get metadata for a task function
     */
    public getTaskMetadata(task: Task<any, any>): TaskMetadata | undefined {
        return taskRegistry.get(task);
    }

    /**
     * Get all registered tasks with their metadata
     */
    public getAllRegisteredTasks(): Array<{ task: Task<any, any>; metadata: TaskMetadata }> {
        return Array.from(taskRegistry.entries()).map(([task, metadata]) => ({ task, metadata }));
    }

    /**
     * Register a task with metadata and return the Express handler
     * This eliminates the need to specify the path twice - the path is auto-derived from the Express route
     */
    public registerTask(
        task: Task<any, any>,
        metadata: Omit<TaskMetadata, 'path'>
    ): express.RequestHandler {
        // Register metadata without path for now; we'll resolve path from Express later
        // Default security to true if not specified
        const partialMetadata: TaskMetadata = { 
            security: true, // default to secure
            ...metadata 
        };
        this.registerTaskMetadata(task, partialMetadata);

        // Create the handler and tag it with the task reference for later discovery
        const handler = this.serveTask(task);
        (handler as any)[ROUTE_TASK_SYMBOL] = task;
        return handler as express.RequestHandler;
    }


    public serveTask<REQ extends TaskRequest, RES>(
        task: Task<REQ, RES>, 
        options?: { version?: number; capturePayloads?: boolean }
    ) {
        return (req: express.Request<{}, {}, REQ>, res: express.Response) => {
            let taskType = req.path.substring(1);

            // Capture payload flag will be passed to executeTask where sessionId is available
            const capturePayload = options?.capturePayloads !== false;

            this.runTaskWithCallback({
                task,
                input: req.body,
                callbackUrl: req.body.callbackUrl,
                taskType,
                version: options?.version,
                capturePayload
            });

            const queueSize = this.taskQueue.length;
            const runningTasksCount = this.runningTasks.size;

            res.status(202).json({
                message: 'Task started',
                queueSize,
                runningTasks: runningTasksCount,
                maxParallelTasks: this.maxParallelTasks
            });
        }
    }

    /**
     * Resolve and attach route paths to registered tasks by introspecting the Express app's routes.
     * This allows using registerTask without specifying the path twice.
     */
    public resolvePathsFromApp(app: express.Express): void {
        try {
            const routerStack: any[] = (app as any)._router?.stack || [];
            for (const layer of routerStack) {
                if (!layer.route || !layer.route.path || !Array.isArray(layer.route.stack)) {
                    continue;
                }

                const routePath: string = layer.route.path;
                for (const routeLayer of layer.route.stack) {
                    const handle = routeLayer.handle;
                    if (handle && (handle as any)[ROUTE_TASK_SYMBOL]) {
                        const task: Task<any, any> = (handle as any)[ROUTE_TASK_SYMBOL];
                        const metadata = taskRegistry.get(task);
                        if (metadata) {
                            // Only set path if not already set
                            if (!metadata.path) {
                                metadata.path = routePath;
                                taskRegistry.set(task, metadata);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to resolve task paths from Express app:', error);
        }
    }

    private async sendCallback(callbackUrl: string, update: RunningTask): Promise<void> {
        console.log('Sending callback to ', callbackUrl);
        try {
            await fetch(callbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(update),
            });
        } catch (error) {
            console.error('Error sending callback:', error);
        }
    }

    public printTaskUpdates() {
        console.clear();
        console.log(chalk.bold.underline('Currently Running Tasks:'));

        const tasks = this.getTaskUpdates();

        if (tasks.length === 0) {
            console.log(chalk.italic.yellow('No tasks.'));
        } else {
            tasks.forEach((task, index) => {
                const lastUpdatedSeconds = Math.round((new Date().getTime() - task.lastUpdatedAt.getTime()) / 1000);
                console.log(
                    chalk.bold.white(`[${index + 1}]`),
                    chalk.bold.cyan(`${task.taskType.toUpperCase()}`),
                    `${chalk.green(task.status)} | ${chalk.blue(task.stage)} | ${chalk.magenta(task.progressPercent.toFixed(2))}%`,
                    `| Last Updated: ${chalk.yellow(`${lastUpdatedSeconds} seconds ago`)}`,
                    `| Running for: ${chalk.red(Math.round((new Date().getTime() - task.createdAt.getTime()) / 1000))}s`
                );
            });
        }

        // Add information about queued tasks
        console.log(chalk.bold.underline('\nTask Queue Information:'));
        console.log(`Queued tasks: ${chalk.bold.yellow(this.taskQueue.length)}`);
        console.log(`Maximum parallel tasks: ${chalk.bold.green(this.maxParallelTasks)}`);
        console.log(`Current running tasks: ${chalk.bold.blue(this.runningTasks.size)}`);

        console.log(chalk.dim('\n(Updates every 5 seconds)'));
    }
}


export const taskManager = new TaskManager();