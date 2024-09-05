import { Router, Request, Response } from 'express';
import dotenv from 'dotenv';

dotenv.config();

export class CallbackServer {
    private callbacks: Map<string, (data: any) => void> = new Map();
    private methods = ['POST', 'GET', 'PUT'];

    public static instance: CallbackServer | null = null;

    public static getInstance(router?: Router, path?: string): CallbackServer {
        if (!CallbackServer.instance) {
            if (!router || !path) {
                throw new Error('Router and path are required');
            }
            CallbackServer.instance = new CallbackServer(router, path);
        }
        return CallbackServer.instance;
    }


    private constructor(private router: Router, private path: string) {
        this.setupRoutes();
    }

    private setupRoutes() {
        this.router.all(`/:callbackId`, (req: Request, res: Response) => {
            const { callbackId } = req.params;

            if (this.methods.includes(req.method) && this.callbacks.has(callbackId)) {
                try {
                    const data = req.method === 'GET' ? req.query : req.body;
                    this.callbacks.get(callbackId)?.(data);
                    res.status(200).json({ status: 'success' });
                } catch (error) {
                    res.status(400).json({ status: 'error', message: 'Invalid data' });
                }
            } else {
                res.status(404).json({ status: 'error', message: 'Not Found' });
            }
        });
    }

    public async getCallback<T>({ timeoutMinutes }: { timeoutMinutes: number }): Promise<{ callbackPromise: Promise<T>, url: string }> {
        const callbackId = Math.random().toString(36).substring(2);
        const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3000'}`;
        const url = `${publicUrl}${this.path}/${callbackId}`;

        const callbackPromise = new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.callbacks.delete(callbackId);
                reject(new Error('Callback timed out'));
            }, timeoutMinutes * 60 * 1000);

            this.callbacks.set(callbackId, (data: T) => {
                clearTimeout(timeout);
                this.callbacks.delete(callbackId);
                resolve(data);
            });
        });

        return { callbackPromise, url };
    }
}