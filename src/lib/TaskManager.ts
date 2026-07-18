import express from 'express';
import { randomUUID } from 'node:crypto';
import { Task } from '../tasks/pipeline.js';
import { TaskUpdate } from '../types.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { runWithTaskTrace } from './observability.js';
import { LlmMode, TaskCancelledError, TaskControl, newTaskControl, runWithTaskControl } from './taskControl.js';

// Per-process prefix so task IDs never collide across server restarts.
const INSTANCE_ID = randomUUID().slice(0, 8);

// Task metadata interface
export interface TaskMetadata {
  path?: string;
  summary: string;
  description: string;
  tags?: string[];
  security?: boolean; // defaults to true
  version?: number;
}

// Global task registry - maps task functions to their metadata
const taskRegistry = new Map<Task<any, any>, TaskMetadata>();

// Symbol used to tag route handlers with their associated task for later path resolution
export const ROUTE_TASK_SYMBOL: unique symbol = Symbol('route_task');

dotenv.config();

type CallbackPayload = TaskUpdate<unknown> & {
    createdAt: Date,
    lastUpdatedAt: Date,
    taskType: string,
    taskId?: string,
};

type RunningTask = Omit<CallbackPayload, "result" | "error"> & {
    callbackUrl: string,
    taskId: string,
};

// Task queue item with all necessary information to run a task
type QueuedTask<T, R> = {
    task: Task<T, R>;
    input: T;
    callbackUrl: string;
    taskType: string;
    createdAt: Date;
    version?: number;
    taskId: string;
    onDone?: () => void;
};

export class TaskManager {
    private runningTasks: Map<string, RunningTask> = new Map();
    private taskControls: Map<string, TaskControl> = new Map();
    private taskQueue: Array<QueuedTask<any, any>> = [];
    private taskCounter: number = 0;
    private maxParallelTasks: number;

    constructor(maxParallelTasks?: number) {
        this.maxParallelTasks = maxParallelTasks ?? parseInt(process.env.MAX_PARALLEL_TASKS || '10', 10);
        if (isNaN(this.maxParallelTasks)) {
            this.maxParallelTasks = 10;
            console.warn('Invalid MAX_PARALLEL_TASKS in .env, using default of 10');
        }
    }

    public getTaskUpdates(): (RunningTask & { llmMode: LlmMode })[] {
        return Array.from(this.runningTasks.entries()).map(([taskId, task]) => ({
            ...task,
            llmMode: this.taskControls.get(taskId)?.llmMode ?? 'batch',
        }));
    }

    public getQueuedTasksCount(): number {
        return this.taskQueue.length;
    }

    public getQueuedTaskSummaries(): { taskId: string; taskType: string; createdAt: Date }[] {
        return this.taskQueue.map(({ taskId, taskType, createdAt }) => ({ taskId, taskType, createdAt }));
    }

    public getMaxParallelTasks(): number {
        return this.maxParallelTasks;
    }

    public async finish(): Promise<void> {
        while (this.runningTasks.size > 0 || this.taskQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    private processQueue(): void {
        while (this.runningTasks.size < this.maxParallelTasks && this.taskQueue.length > 0) {
            const nextTask = this.taskQueue.shift();
            if (nextTask) {
                const { task, input, callbackUrl, taskType, taskId, version, onDone } = nextTask;
                void this.executeTask(task, input, callbackUrl, taskType, taskId, version).finally(() => onDone?.());
            }
        }
    }

    private async executeTask<T, R>(
        task: Task<T, R>,
        input: T,
        callbackUrl: string,
        taskType: string,
        taskId: string,
        version?: number
    ): Promise<void> {
        const createdAt = new Date();
        const control = newTaskControl(taskId);
        this.taskControls.set(taskId, control);
        try {
            const initialUpdate: RunningTask = {
                status: "processing",
                stage: "initializing",
                progressPercent: 0,
                createdAt,
                lastUpdatedAt: createdAt,
                taskType,
                callbackUrl,
                version,
                taskId,
            };
            this.runningTasks.set(taskId, initialUpdate);

            await this.sendCallback(callbackUrl, initialUpdate);

            if (control.cancel.signal.aborted) {
                throw new TaskCancelledError(`Task ${taskId} cancelled`);
            }

            const result = await runWithTaskControl(control, () => runWithTaskTrace(
                { taskType, version, input, callbackUrl },
                () => task(input, (stage, progressPercent) => {
                    // Universal cancellation checkpoint: every task reports
                    // progress, so every task observes cancellation here
                    // without task-code changes.
                    if (control.cancel.signal.aborted) {
                        throw new TaskCancelledError(`Task ${taskId} cancelled`);
                    }
                    const now = new Date();
                    const update: RunningTask = {
                        status: "processing",
                        stage,
                        progressPercent,
                        createdAt,
                        lastUpdatedAt: now,
                        taskType,
                        callbackUrl,
                        version,
                        taskId,
                    };
                    this.runningTasks.set(taskId, update);
                    this.sendCallback(callbackUrl, update);
                })
            ));

            const finalUpdate: TaskUpdate<R> & { createdAt: Date, lastUpdatedAt: Date, taskType: string, taskId: string } = {
                status: "success",
                stage: "finished",
                progressPercent: 100,
                result,
                createdAt,
                lastUpdatedAt: new Date(),
                taskType,
                version,
                taskId,
            };
            await this.sendCallback(callbackUrl, finalUpdate);
        } catch (error: any) {
            const cancelled = error instanceof TaskCancelledError;
            const errorUpdate: TaskUpdate<any> & { createdAt: Date, lastUpdatedAt: Date, taskType: string, taskId: string } = {
                status: cancelled ? "cancelled" : "error",
                stage: cancelled ? "cancelled" : "finished",
                progressPercent: 100,
                ...(cancelled ? {} : { error: error.message }),
                createdAt,
                lastUpdatedAt: new Date(),
                taskType,
                version,
                taskId,
            };
            await this.sendCallback(callbackUrl, errorUpdate);
            if (cancelled) {
                console.log(`Task ${taskId} (${taskType}) cancelled`);
            } else {
                console.error('Error in task:', error);
            }
        } finally {
            this.runningTasks.delete(taskId);
            this.taskControls.delete(taskId);
            this.processQueue();
        }
    }

    public runTaskWithCallback<T, R>(
        task: Task<T, R>,
        input: T,
        callbackUrl: string,
        taskType: string,
        version?: number
    ): { taskId: string; completion: Promise<void> } {
        const taskId = `task_${INSTANCE_ID}_${++this.taskCounter}`;

        if (this.runningTasks.size >= this.maxParallelTasks) {
            let onDone!: () => void;
            const completion = new Promise<void>(resolve => { onDone = resolve; });
            const queuedTask: QueuedTask<T, R> = {
                task, input, callbackUrl, taskType, createdAt: new Date(), version, taskId, onDone,
            };
            this.taskQueue.push(queuedTask);
            console.log(`Task ${taskType} queued as ${taskId}. Current queue size: ${this.taskQueue.length}`);

            void this.sendCallback(callbackUrl, {
                status: "processing",
                stage: "queued",
                progressPercent: 0,
                createdAt: queuedTask.createdAt,
                lastUpdatedAt: queuedTask.createdAt,
                taskType,
                version,
                taskId,
            });
            return { taskId, completion };
        }

        return { taskId, completion: this.executeTask(task, input, callbackUrl, taskType, taskId, version) };
    }

    /**
     * Cancel a task. Queued tasks are removed immediately ('cancelled');
     * running tasks get their signal aborted and finish cooperatively at the
     * next checkpoint ('cancelling'). Returns null for unknown/finished ids.
     */
    public cancelTask(taskId: string): 'cancelling' | 'cancelled' | null {
        const queuedIndex = this.taskQueue.findIndex(t => t.taskId === taskId);
        if (queuedIndex !== -1) {
            const [queued] = this.taskQueue.splice(queuedIndex, 1);
            // Resolve completion only after the callback delivery attempt, matching
            // the running-task path where the terminal callback is awaited before
            // the task promise settles.
            void this.sendCallback(queued.callbackUrl, {
                status: "cancelled",
                stage: "cancelled",
                progressPercent: 0,
                createdAt: queued.createdAt,
                lastUpdatedAt: new Date(),
                taskType: queued.taskType,
                version: queued.version,
                taskId,
            }).finally(() => queued.onDone?.());
            return 'cancelled';
        }
        const control = this.taskControls.get(taskId);
        if (control) {
            control.cancel.abort();
            return 'cancelling';
        }
        return null;
    }

    /**
     * Switch a running task's LLM calls to streaming mode: future aiChat
     * calls skip the Batch API, and an in-flight batch poll wakes up, cancels
     * the Anthropic batch, and re-issues via streaming. Idempotent.
     */
    public promoteTask(taskId: string): boolean {
        const control = this.taskControls.get(taskId);
        if (!control) return false;
        control.llmMode = 'streaming';
        control.promote.abort();
        return true;
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
        const handler = this.serveTask(task, metadata.version) as unknown as express.RequestHandler & { [key: symbol]: any };
        (handler as any)[ROUTE_TASK_SYMBOL] = task;
        return handler;
    }

    public serveTask<REQ, RES>(task: Task<REQ, RES>, version?: number) {
        return (req: express.Request<{}, {}, REQ & { callbackUrl: string }>, res: express.Response) => {
            let taskType = req.path.substring(1);

            const { taskId } = this.runTaskWithCallback(
                task,
                req.body,
                req.body.callbackUrl,
                taskType,
                version
            );

            res.status(202).json({
                message: 'Task started',
                taskId,
                queueSize: this.taskQueue.length,
                runningTasks: this.runningTasks.size,
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

    private async sendCallback(callbackUrl: string, update: CallbackPayload): Promise<void> {
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
