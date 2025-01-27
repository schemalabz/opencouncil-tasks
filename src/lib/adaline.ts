
import fetch from 'node-fetch';
interface AdalineDeployment {
    id: string;
    config: {
        provider: string;
        model: string;
        settings: {
            maxTokens: number;
            temperature: number;
        }
    };
    messages: {
        role: string;
        content: {
            modality: string;
            value: string;
        }[];
    }[];
    variables: {
        name: string;
        value: {
            modality: string;
            value: string;
        }
    }[];
}

export async function fetchAdalineDeployment(projectId: string, deploymentId?: string): Promise<AdalineDeployment> {
    const adalineSecret = process.env.ADALINE_SECRET;
    if (!adalineSecret) {
        throw new Error('ADALINE_SECRET environment variable is not set');
    }

    const endpoint = deploymentId
        ? `https://api.adaline.ai/v1/deployments/${projectId}/${deploymentId}`
        : `https://api.adaline.ai/v1/deployments/${projectId}/current`;

    const response = await fetch(endpoint, {
        headers: {
            'Authorization': `Bearer ${adalineSecret}`
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Adaline deployment: ${response.statusText}`);
    }

    return response.json() as Promise<AdalineDeployment>;
}

interface AdalineLogVariables {
    [key: string]: string;
}

interface AdalineLogMetadata {
    [key: string]: string;
}

interface AdalineLogRequest {
    projectId: string;
    provider: string;
    model: string;
    completion: string;
    cost?: number;
    latency?: number;
    inputTokens?: number;
    outputTokens?: number;
    variables?: AdalineLogVariables;
    metadata?: AdalineLogMetadata;
    referenceId?: string;
}

interface AdalineLogResponse {
    id: string;
}

export async function submitAdalineLog(log: AdalineLogRequest): Promise<AdalineLogResponse> {
    const adalineSecret = process.env.ADALINE_SECRET;
    if (!adalineSecret) {
        throw new Error('ADALINE_SECRET environment variable is not set');
    }

    const response = await fetch('https://api.adaline.ai/v1/logs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adalineSecret}`
        },
        body: JSON.stringify(log)
    });

    if (!response.ok) {
        throw new Error(`Failed to submit Adaline log: ${response.statusText}`);
    }

    return response.json() as Promise<AdalineLogResponse>;
}
