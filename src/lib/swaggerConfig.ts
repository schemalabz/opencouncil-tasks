import swaggerJSDoc from 'swagger-jsdoc';
import { getOpenAPIComponents, initializeSchemaGenerator } from './schemaGenerator.js';
import { generateSwaggerPaths } from './swaggerGenerator.js';

// Initialize schema generator
initializeSchemaGenerator();

// Basic OpenAPI definition
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'OpenCouncil Tasks API',
    version: '1.0.0',
    description: `
This API provides endpoints for the backend task processing service for the [OpenCouncil](https://github.com/schemalabz/opencouncil) platform.
This service handles various audio, video, and content processing tasks through the API interface.

## Authentication

This API uses Bearer token authentication. Include your API token in the Authorization header:

\`Authorization: Bearer your-api-token\`

You can disable authentication by setting \`NO_AUTH=true\` in your environment variables.
    `,
  },
  servers: [
    {
      url: process.env.PUBLIC_URL,
      description: process.env.NODE_ENV === 'development' ? 'Development server' : 'Production server'
    }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'API token for authentication. Contact your administrator to obtain a token.'
      }
    }
  },
  security: [
    {
      bearerAuth: []
    }
  ]
};

// Swagger JSDoc options
const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    ...swaggerDefinition,
    paths: generateSwaggerPaths(), // Generate paths from task registry
    components: {
      ...swaggerDefinition.components,
      ...getOpenAPIComponents().components, // Merge auto-generated schemas with security schemes
    },
  },
  apis: [
    './src/routes/*.ts', // Only include routes files (no server.ts)
    './src/routes/*.js',
    './dist/routes/*.js', // Include compiled JS files for production
  ],
};

// Generate swagger specification
export const swaggerSpec = swaggerJSDoc(swaggerOptions);

