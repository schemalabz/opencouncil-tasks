/**
 * Parameter Override System
 * 
 * Allows flexible testing by applying parameter overrides to captured payloads
 * using dot-notation syntax (e.g., "render.aspectRatio:social-9x16")
 */

export interface OverrideResult {
  success: boolean;
  payload: any;
  errors: string[];
}

/**
 * Parse override string into key-value pairs
 * Format: "path:value,path2:value2"
 */
export function parseOverrides(overrideString: string): Record<string, any> {
  if (!overrideString || typeof overrideString !== 'string') {
    return {};
  }

  const overrides: Record<string, any> = {};
  
  // Split by comma and process each override
  const pairs = overrideString.split(',').map(pair => pair.trim());
  
  for (const pair of pairs) {
    if (!pair) continue;
    
    const colonIndex = pair.indexOf(':');
    if (colonIndex === -1) {
      console.warn(`⚠️  Invalid override format (missing colon): ${pair}`);
      continue;
    }
    
    const path = pair.substring(0, colonIndex).trim();
    const value = pair.substring(colonIndex + 1).trim();
    
    if (!path) {
      console.warn(`⚠️  Empty path in override: ${pair}`);
      continue;
    }
    
    // Parse value based on type
    overrides[path] = parseValue(value);
  }
  
  return overrides;
}

/**
 * Parse string value to appropriate type
 */
function parseValue(value: string): any {
  // Remove quotes if present
  const trimmed = value.replace(/^["']|["']$/g, '');
  
  // Boolean values
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  
  // Null/undefined
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;
  
  // Numbers (including decimals and negative)
  if (/^-?\d+\.?\d*$/.test(trimmed)) {
    return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
  }
  
  // Arrays (comma-separated values in square brackets)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const arrayContent = trimmed.slice(1, -1).trim();
    if (!arrayContent) return [];
    return arrayContent.split(',').map(item => parseValue(item.trim()));
  }
  
  // Objects (JSON-like syntax)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      console.warn(`⚠️  Failed to parse object value: ${trimmed}`);
      return trimmed;
    }
  }
  
  // String (default)
  return trimmed;
}

/**
 * Apply overrides to a payload using dot-notation paths
 */
export function applyOverrides(basePayload: any, overrides: Record<string, any>): OverrideResult {
  const result: OverrideResult = {
    success: true,
    payload: JSON.parse(JSON.stringify(basePayload)), // Deep clone
    errors: []
  };
  
  for (const [path, value] of Object.entries(overrides)) {
    try {
      setNestedValue(result.payload, path, value);
    } catch (error) {
      result.success = false;
      result.errors.push(`Failed to set ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  return result;
}

/**
 * Set a nested value using dot-notation path
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let current = obj;
  
  // Navigate to the parent of the target key
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    
    if (!(key in current)) {
      current[key] = {};
    } else if (typeof current[key] !== 'object' || current[key] === null) {
      // Convert primitive to object if needed
      current[key] = {};
    }
    
    current = current[key];
  }
  
  // Set the final value
  const finalKey = keys[keys.length - 1];
  current[finalKey] = value;
}

/**
 * Get a nested value using dot-notation path
 */
export function getNestedValue(obj: any, path: string): any {
  const keys = path.split('.');
  let current = obj;
  
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  
  return current;
}

/**
 * Validate override paths against a schema (optional)
 */
export function validateOverridePaths(overrides: Record<string, any>, schema?: any): string[] {
  const errors: string[] = [];
  
  // Basic validation - check for common issues
  for (const path of Object.keys(overrides)) {
    if (!path || path.includes('..') || path.startsWith('.') || path.endsWith('.')) {
      errors.push(`Invalid path: ${path}`);
    }
  }
  
  // TODO: Add schema-based validation if needed
  // This would require the schema to be available and parsed
  
  return errors;
}

/**
 * Create a test payload with overrides applied
 */
export function createTestPayload(
  basePayload: any, 
  overrideString: string,
  skipCapture: boolean = true
): OverrideResult {
  const overrides = parseOverrides(overrideString);
  const result = applyOverrides(basePayload, overrides);
  
  // Ensure skipCapture is set
  if (result.success) {
    result.payload.skipCapture = skipCapture;
  }
  
  return result;
}

/**
 * Get available override paths for a payload (useful for documentation)
 */
export function getAvailablePaths(obj: any, prefix: string = ''): string[] {
  const paths: string[] = [];
  
  if (typeof obj !== 'object' || obj === null) {
    return paths;
  }
  
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    paths.push(currentPath);
    
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      paths.push(...getAvailablePaths(value, currentPath));
    }
  }
  
  return paths.sort();
}
