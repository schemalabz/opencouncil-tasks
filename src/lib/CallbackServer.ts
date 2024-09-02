import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import dotenv from 'dotenv';

dotenv.config();

class CallbackServer {
    private server: any;
    private callbacks: Map<string, (data: any) => void> = new Map();
    private port: number = parseInt(process.env.CALLBACK_SERVER_PORT || '3009', 10);
    private methods = ['POST', 'GET', 'PUT'];

    constructor() {
        this.server = null;
    }

    private startServer() {
        if (this.server) {
            return;
        }
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = parse(req.url || '', true);
            const callbackId = url.pathname?.substring(1);

            if (req.method && this.methods.includes(req.method) && callbackId && this.callbacks.has(callbackId)) {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        this.callbacks.get(callbackId)?.(data);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'success' }));
                    } catch (error) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
                    }
                });
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: 'Not Found' }));
            }
        });

        this.server.listen(this.port, () => {
            console.log(`Callback server is listening on port ${this.port}`);
        });
    }
    public async getCallback<T>({ timeoutMinutes }: { timeoutMinutes: number }): Promise<{ callbackPromise: Promise<T>, url: string }> {
        this.startServer();

        const callbackId = Math.random().toString(36).substring(2);
        const publicUrl = process.env.CALLBACK_SERVER_PUBLIC_URL || `http://localhost:${this.port}`;
        const url = `${publicUrl}/${callbackId}`;

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

    public async stopServer() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}

const callbackServer = new CallbackServer();
export { callbackServer };
