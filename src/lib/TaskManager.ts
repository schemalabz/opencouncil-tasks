import express from 'express';
import { Task } from '../tasks/pipeline';
import { TaskUpdate } from '../types';

type RunningTask = Omit<TaskUpdate<any>, "result" | "error"> & {
    createdAt: Date,
    lastUpdatedAt: Date,
    taskType: string
};

class TaskManager {
    private runningTasks: Map<string, RunningTask> = new Map();
    private taskCounter: number = 0;

    public getTaskUpdates(): RunningTask[] {
        return Array.from(this.runningTasks.values());
    }

    public async finish(): Promise<void> {
        while (this.runningTasks.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    public async runTaskWithCallback<T, R>(
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
            console.error('Error in pipeline:', error);
        } finally {
            this.runningTasks.delete(taskId);
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

            res.status(202).json({ message: 'Task started' });
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
}

export const taskManager = new TaskManager();