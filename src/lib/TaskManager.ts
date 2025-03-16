import express from 'express';
import { Task } from '../tasks/pipeline.js';
import { TaskUpdate } from '../types.js';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

type RunningTask = Omit<TaskUpdate<any>, "result" | "error"> & {
    createdAt: Date,
    lastUpdatedAt: Date,
    taskType: string
};

// Task queue item with all necessary information to run a task
type QueuedTask<T, R> = {
    task: Task<T, R>;
    input: T;
    callbackUrl: string;
    taskType: string;
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
                const { task, input, callbackUrl, taskType } = nextTask;
                this.executeTask(task, input, callbackUrl, taskType);
            }
        }
    }

    private async executeTask<T, R>(
        task: Task<T, R>,
        input: T,
        callbackUrl: string,
        taskType: string,
    ): Promise<void> {
        const taskId = `task_${++this.taskCounter}`;
        const createdAt = new Date();
        try {
            this.runningTasks.set(taskId, {
                status: "processing",
                stage: "initializing",
                progressPercent: 0,
                createdAt,
                lastUpdatedAt: createdAt,
                taskType,
            });

            const result = await task(input, (stage, progressPercent) => {
                const now = new Date();
                const update: RunningTask = {
                    status: "processing",
                    stage,
                    progressPercent,
                    createdAt,
                    lastUpdatedAt: now,
                    taskType,
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
            };
            await this.sendCallback(callbackUrl, errorUpdate);
            console.error('Error in task:', error);
        } finally {
            this.runningTasks.delete(taskId);
            // Process the queue after a task finishes
            this.processQueue();
        }
    }

    public async runTaskWithCallback<T, R>(
        task: Task<T, R>,
        input: T,
        callbackUrl: string,
        taskType: string,
    ): Promise<void> {
        // Check if we've reached the maximum number of parallel tasks
        if (this.runningTasks.size >= this.maxParallelTasks) {
            // Queue the task
            const queuedTask: QueuedTask<T, R> = {
                task,
                input,
                callbackUrl,
                taskType,
                createdAt: new Date()
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
            });
        } else {
            // Execute the task immediately
            await this.executeTask(task, input, callbackUrl, taskType);
        }
    }

    public serveTask<REQ, RES>(task: Task<REQ, RES>) {
        return (req: express.Request<{}, {}, REQ & { callbackUrl: string }>, res: express.Response) => {
            let taskType = req.path.substring(1);

            this.runTaskWithCallback(
                task,
                req.body,
                req.body.callbackUrl,
                taskType
            );

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