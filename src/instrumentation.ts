/**
 * OpenTelemetry instrumentation for Langfuse observability
 * 
 * This file sets up automatic tracing of AI SDK calls to Langfuse.
 * It must be imported BEFORE any other modules to ensure proper instrumentation.
 * 
 * Usage: Import at the top of server.ts or other entry points:
 *   import './instrumentation.js';
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { LangfuseExporter } from 'langfuse-vercel';

// Only initialize if Langfuse is configured and telemetry is enabled
const shouldEnableTelemetry = 
  process.env.CAPTURE_PAYLOADS === 'true' &&
  process.env.LANGFUSE_SECRET_KEY &&
  process.env.LANGFUSE_PUBLIC_KEY;

if (shouldEnableTelemetry) {
  // Determine environment for Langfuse filtering
  const environment = process.env.NODE_ENV === 'development' ? 'development' : 'production';
  
  console.log(`🔍 Initializing Langfuse telemetry (environment: ${environment})...`);
  
  const sdk = new NodeSDK({
    serviceName: 'opencouncil-tasks',
    traceExporter: new LangfuseExporter({
      debug: false, // Set to true for debugging
      environment: environment,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable HTTP instrumentation to avoid noise
        '@opentelemetry/instrumentation-http': {
          enabled: false
        },
        '@opentelemetry/instrumentation-express': {
          enabled: false
        }
      })
    ]
  });

  sdk.start();
  
  console.log('✅ Langfuse telemetry initialized');
  
  // Gracefully shutdown on process termination
  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('Langfuse SDK shut down successfully'))
      .catch((error) => console.error('Error shutting down Langfuse SDK', error))
      .finally(() => process.exit(0));
  });
} else {
  console.log('ℹ️  Langfuse telemetry disabled (CAPTURE_PAYLOADS not enabled or credentials missing)');
}

export {};

