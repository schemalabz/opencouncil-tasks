/**
 * Swagger Generator for Task Endpoints
 * 
 * This module generates Swagger documentation from registered task metadata
 * and Express routes, keeping Swagger logic separate from TaskManager.
 */

import { taskManager } from './TaskManager.js';

/**
 * Get the request type name for a task path
 * This follows the naming convention: TaskNameRequest
 */
function getRequestTypeName(path: string): string {
    // Remove leading slash and convert to PascalCase
    const taskName = path.substring(1);
    return taskName.charAt(0).toUpperCase() + taskName.slice(1) + 'Request';
}

/**
 * Generate Swagger paths from registered tasks
 * This keeps Swagger logic separate from TaskManager
 */
export function generateSwaggerPaths(): Record<string, any> {
    const paths: Record<string, any> = {};
    
    // Add public endpoints
    paths['/health'] = {
        get: {
            summary: 'Health check',
            description: 'Check if the API is running and healthy, includes version information',
            tags: ['System'],
            responses: {
                '200': {
                    description: 'Service is healthy',
                    content: {
                        'application/json': {
                            schema: {
                                $ref: '#/components/schemas/HealthResponse'
                            }
                        }
                    }
                }
            }
        }
    };

    // Add task endpoints
    const registeredTasks = taskManager.getAllRegisteredTasks();
    
    for (const { task, metadata } of registeredTasks) {
        if (!metadata.path) {
            console.warn(`⚠️  No path found for task: ${task.name || 'unknown'}`);
            continue;
        }

        const pathSpec: any = {
            post: {
                summary: metadata.summary,
                description: metadata.description,
                tags: metadata.tags || ['Tasks'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                $ref: `#/components/schemas/${getRequestTypeName(metadata.path)}`
                            }
                        }
                    }
                },
                responses: {
                    '202': {
                        description: 'Task started successfully',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        message: { type: 'string', example: 'Task started' },
                                        queueSize: { type: 'number' },
                                        runningTasks: { type: 'number' },
                                        maxParallelTasks: { type: 'number' }
                                    }
                                }
                            }
                        }
                    },
                    '400': {
                        description: 'Invalid request'
                    },
                    '500': {
                        description: 'Task execution failed'
                    }
                }
            }
        };

        // Add security if required
        if (metadata.security) {
            pathSpec.post.security = [{ bearerAuth: [] }];
            pathSpec.post.responses['401'] = {
                description: 'Unauthorized - Invalid or missing token'
            };
        }

        paths[metadata.path] = pathSpec;
    }
    
    return paths;
}
