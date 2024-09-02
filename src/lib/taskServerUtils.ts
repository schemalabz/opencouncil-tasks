import express from 'express';
import { Task } from '../tasks/pipeline';
import { TaskUpdate } from '../types';

export const runTaskWithCallback = async <T, R>(
    task: Task<T, R>,
    input: T,
    callbackUrl: string,
) => {
    try {
        const result = await task(input, (stage, progressPercent) => {
            const update: TaskUpdate<any> = {
                status: "processing",
                stage,
                progressPercent,
            };
            fetch(callbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(update),
            }).catch(error => {
                console.error('Error sending callback:', error);
            });
        });

        const finalUpdate: TaskUpdate<R> = {
            status: "success",
            stage: "finished",
            progressPercent: 100,
            result
        };
        await fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(finalUpdate),
        });
    } catch (error: any) {
        const errorUpdate: TaskUpdate<any> = {
            status: "error",
            stage: "finished",
            progressPercent: 100,
            error: error.message
        };
        await fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(errorUpdate),
        }).catch(callbackError => {
            console.error('Error sending error callback:', callbackError);
        });

        console.error('Error in pipeline:', error);
    }
};

export const serveTask = <REQ, RES>(task: Task<REQ, RES>, validate: (req: express.Request) => boolean) => {
    return (req: express.Request<{}, {}, REQ & { callbackUrl: string }>, res: express.Response) => {
        if (!validate(req)) {
            return;
        }

        runTaskWithCallback(
            task,
            req.body,
            req.body.callbackUrl
        )
    }
}