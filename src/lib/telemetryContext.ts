import { AsyncLocalStorage } from 'async_hooks';

/**
 * Telemetry context for tracking execution metadata across async operations
 */
export interface TelemetryContext {
    sessionId: string;      // Groups all AI calls within a task execution
    taskType: string;       // Type of task being executed
    taskId: string;         // Unique task execution ID
}

/**
 * AsyncLocalStorage for maintaining telemetry context throughout async operations
 * This allows us to access the sessionId from anywhere in the call chain without
 * having to pass it explicitly through every function parameter.
 */
const telemetryStorage = new AsyncLocalStorage<TelemetryContext>();

/**
 * Run a function with a telemetry context
 * All async operations within the function will have access to this context
 */
export function runWithTelemetryContext<T>(
    context: TelemetryContext,
    fn: () => T
): T {
    return telemetryStorage.run(context, fn);
}

/**
 * Get the current telemetry context (if any)
 * Returns undefined if not running within a telemetry context
 */
export function getTelemetryContext(): TelemetryContext | undefined {
    return telemetryStorage.getStore();
}

/**
 * Get the current sessionId for Langfuse grouping
 * Returns undefined if not running within a telemetry context
 */
export function getSessionId(): string | undefined {
    return telemetryStorage.getStore()?.sessionId;
}

