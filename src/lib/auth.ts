import express from 'express';
import path from 'path';
import { getFromEnvOrFile } from '../utils.js';

/**
 * Authentication configuration interface
 */
export interface AuthConfig {
    /** Skip authentication entirely */
    skipAuth: boolean;
    /** Paths that don't require authentication */
    publicPaths: string[];
    /** Valid API tokens for authentication */
    tokens: string[];
    /** Additional public paths from environment variables */
    additionalPublicPaths: string[];
}

/**
 * Create authentication configuration from environment variables and files
 */
export const createAuthConfig = (): AuthConfig => {
    const skipAuth = process.env.NO_AUTH === 'true';
    
    // Base public endpoints that don't require authentication
    const publicPaths = [
        '/docs',           // Swagger documentation
        '/docs/',          // Swagger documentation with trailing slash
        '/health',         // Health check endpoint (includes version info)
        '/favicon.ico'     // Browser favicon requests
    ];

    // Add development endpoints in development mode
    if (process.env.NODE_ENV === 'development') {
        publicPaths.push('/dev');  // Development routes
    }

    // Load API tokens
    const apiTokensPath = path.join(process.cwd(), 'secrets', 'apiTokens.json');
    const tokens = skipAuth ? [] : getFromEnvOrFile('API_TOKENS', apiTokensPath);

    // Additional public paths from environment variables
    const additionalPublicPaths = process.env.PUBLIC_ENDPOINTS?.split(',').map(path => path.trim()) || [];

    return {
        skipAuth,
        publicPaths,
        tokens,
        additionalPublicPaths
    };
};

/**
 * Check if a request path is a public endpoint
 */
const isPublicEndpoint = (requestPath: string, allPublicPaths: string[]): boolean => {
    return allPublicPaths.some(endpoint => 
        requestPath === endpoint || requestPath.startsWith(endpoint + '/')
    );
};

/**
 * Extract bearer token from request headers
 */
const extractBearerToken = (req: express.Request): string | null => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    
    return authHeader.split(' ')[1].trim();
};

/**
 * Validate if token is in the list of valid tokens
 */
const validateToken = (token: string, validTokens: string[]): boolean => {
    return validTokens.includes(token);
};

/**
 * Create authentication middleware with the provided configuration
 */
export const createAuthMiddleware = (config?: AuthConfig) => {
    // Use provided config or create default config
    const authConfig = config || createAuthConfig();
    
    // Combine all public paths
    const allPublicPaths = [...authConfig.publicPaths, ...authConfig.additionalPublicPaths];

    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        // Skip authentication if configured to do so
        if (authConfig.skipAuth) {
            return next();
        }

        // Check if the request path is a public endpoint
        if (isPublicEndpoint(req.path, allPublicPaths)) {
            return next();
        }

        // Extract and validate bearer token
        const token = extractBearerToken(req);
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        if (!validateToken(token, authConfig.tokens)) {
            return res.status(403).json({ error: 'Invalid token' });
        }

        next();
    };
};

/**
 * Create authentication middleware with default configuration
 * This is a convenience function for the most common use case
 */
export const authMiddleware = createAuthMiddleware();
