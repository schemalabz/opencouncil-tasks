/**
 * TypeScript to OpenAPI 3.0 Schema Generator with Caching
 * 
 * OVERVIEW:
 * This module automatically generates OpenAPI 3.0 compatible schemas from TypeScript types
 * with disk-based caching for optimal performance during development and hot reloads.
 * It bridges the gap between TypeScript type definitions and OpenAPI 3.0 specification.
 * 
 * ARCHITECTURE:
 * 1. Content-Based Caching: SHA-256 hashing of source files for cache validation
 * 2. Disk Persistence: Cache survives module reloads and server restarts
 * 3. TypeScript AST Analysis: Discovers all exported types from types.ts and dev routes
 * 4. Smart Filtering: Excludes internal types not needed for API documentation
 * 5. JSON Schema Generation: Uses typescript-json-schema to generate base schemas
 * 6. OpenAPI 3.0 Transformation: Converts #/definitions/ to #/components/schemas/
 * 7. Schema Flattening: Extracts nested definitions to top level
 * 
 * CACHING STRATEGY:
 * - Content Hash Validation: Only regenerates when source files actually change
 * - Disk-Based Storage: Cache persists in data/.cache/schema-cache.json
 * - Git Integration: Cache directory is automatically gitignored
 * - Automatic Expiration: Cache expires after 24 hours for safety
 * - Hot Reload Optimization: Dramatically reduces schema generation time
 * - Development Friendly: Manual cache clearing available via clearSchemaCache()
 * 
 * WHY THIS APPROACH:
 * - typescript-json-schema is the best tool for TypeScript → JSON Schema conversion
 * - OpenAPI 3.0 requires different reference format than JSON Schema
 * - This transformation is a standard pattern in the ecosystem
 * - Maintains single source of truth (TypeScript types) for API schemas
 * 
 * USAGE:
 * - Schemas are automatically generated and used by Swagger UI
 * - No manual maintenance required when adding new types
 * - Exclude types by adding them to the excludeTypes array
 * - Cache is automatically managed - no intervention needed
 */

import * as TJS from 'typescript-json-schema';
import * as ts from 'typescript';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure typescript-json-schema settings
// These settings optimize the generated schemas for OpenAPI 3.0 compatibility
const settings: TJS.PartialArgs = {
  required: true,                    // Include required field information
  noExtraProps: false,              // Allow additional properties (more flexible)
  propOrder: true,                  // Preserve property order for better readability
  typeOfKeyword: true,              // Include typeof information for better type inference
  validationKeywords: ['minLength', 'maxLength', 'pattern', 'format'], // Include validation keywords
  excludePrivate: true,             // Exclude private members from schemas
  ignoreErrors: true,               // Continue on TypeScript errors (more robust)
  ref: true,                        // Generate references for complex types (essential for OpenAPI)
};

// Create program to analyze TypeScript files
const compilerOptions: ts.CompilerOptions = {
  strictNullChecks: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
};

let program: TJS.Program | null = null;
let schemas: { [key: string]: TJS.Definition } = {};

// Disk-based cache configuration
const CACHE_DIR = path.join(process.cwd(), 'data', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'schema-cache.json');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Cache structure
interface CacheData {
  schemas: { [key: string]: TJS.Definition };
  contentHash: string;
  timestamp: number;
}

let schemaCache: { [key: string]: TJS.Definition } = {};
let contentHash: string = '';

/**
 * Load cache from disk
 */
function loadCacheFromDisk(): boolean {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return false;
    }

    const cacheData: CacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    
    // Check if cache is not too old (24 hours)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - cacheData.timestamp > maxAge) {
      console.log('🗑️  Cache expired, removing old cache file');
      fs.unlinkSync(CACHE_FILE);
      return false;
    }

    schemaCache = cacheData.schemas;
    contentHash = cacheData.contentHash;
    
    console.log(`📁 Loaded cache from disk (${Object.keys(schemaCache).length} schemas, hash: ${contentHash.substring(0, 8)}...)`);
    return true;
  } catch (error) {
    console.log('⚠️  Failed to load cache from disk:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Save cache to disk
 */
function saveCacheToDisk(): void {
  try {
    const cacheData: CacheData = {
      schemas: schemaCache,
      contentHash: contentHash,
      timestamp: Date.now()
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
    console.log(`💾 Saved cache to disk (${Object.keys(schemaCache).length} schemas)`);
  } catch (error) {
    console.log('⚠️  Failed to save cache to disk:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Generate a SHA-256 content hash for the source files
 * This is used to determine if the cache is still valid
 */
function generateContentHash(): string {
  try {
    const typesPath = path.join(__dirname, '../types.ts');
    const devRoutesPath = path.join(__dirname, '../routes/dev.ts');
    
    // Read file contents
    const typesContent = fs.readFileSync(typesPath, 'utf8');
    const devContent = fs.readFileSync(devRoutesPath, 'utf8');
    
    // Create hash from file contents
    const hash = createHash('sha256');
    hash.update(typesContent);
    hash.update(devContent);
    
    return hash.digest('hex');
  } catch (error) {
    // If we can't read files, return empty hash to force regeneration
    return '';
  }
}

/**
 * Check if the schema cache is still valid based on content hash
 */
function isCacheValid(): boolean {
  // First try to load from disk if we don't have anything in memory
  if (Object.keys(schemaCache).length === 0) {
    if (loadCacheFromDisk()) {
      // Cache loaded from disk, now check if it's still valid
      const currentHash = generateContentHash();
      if (currentHash === contentHash && currentHash !== '') {
        return true;
      } else {
        // Content changed, clear the invalid cache
        schemaCache = {};
        contentHash = '';
        return false;
      }
    }
    return false;
  }

  const currentHash = generateContentHash();
  return currentHash === contentHash && currentHash !== '';
}

/**
 * Initialize the schema generator with TypeScript program
 */
export function initializeSchemaGenerator(): void {
  const typesPath = path.join(__dirname, '../types.ts');
  const devRoutesPath = path.join(__dirname, '../routes/dev.ts');
  
  try {
    program = TJS.getProgramFromFiles([typesPath, devRoutesPath], compilerOptions);
    console.log('📋 Schema generator initialized');
  } catch (error) {
    console.error('❌ Failed to initialize schema generator:', error);
    throw error;
  }
}

/**
 * Generate JSON schema for a specific TypeScript type
 */
export function generateSchema(typeName: string): TJS.Definition | null {
  if (!program) {
    initializeSchemaGenerator();
  }

  if (!program) {
    console.error('❌ Schema generator not initialized');
    return null;
  }

  try {
    // Check cache first
    if (schemas[typeName]) {
      return schemas[typeName];
    }

    const schema = TJS.generateSchema(program, typeName, settings);
    
    if (schema) {
      // Cache the schema
      schemas[typeName] = schema;
      console.log(`✅ Generated schema for type: ${typeName}`);
      return schema;
    } else {
      console.warn(`⚠️  No schema found for type: ${typeName}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Failed to generate schema for ${typeName}:`, error);
    return null;
  }
}

/**
 * Automatically discover all exported types and interfaces from types.ts and dev routes
 */
function discoverExportedTypes(): string[] {
  if (!program) {
    initializeSchemaGenerator();
  }

  if (!program) {
    console.error('❌ Schema generator not initialized');
    return [];
  }

  const typeNames: string[] = [];
  
  // Discover types from main types.ts file
  const typesFile = program.getSourceFile(path.join(__dirname, '../types.ts'));
  if (typesFile) {
    const visit = (node: ts.Node) => {
      // Check for interface declarations
      if (ts.isInterfaceDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) {
          typeNames.push(node.name.text);
        }
      }
      
      // Check for type alias declarations
      if (ts.isTypeAliasDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) {
          typeNames.push(node.name.text);
        }
      }

      // Recursively visit child nodes
      ts.forEachChild(node, visit);
    };
    visit(typesFile);
  } else {
    console.error('❌ Could not find types.ts source file');
  }

  // Discover dev-specific types from dev routes file
  const devRoutesFile = program.getSourceFile(path.join(__dirname, '../routes/dev.ts'));
  if (devRoutesFile) {
    const visit = (node: ts.Node) => {
      // Check for interface declarations
      if (ts.isInterfaceDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) {
          typeNames.push(node.name.text);
        }
      }
      
      // Check for type alias declarations
      if (ts.isTypeAliasDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) {
          typeNames.push(node.name.text);
        }
      }

      // Recursively visit child nodes
      ts.forEachChild(node, visit);
    };
    visit(devRoutesFile);
  }

  console.log(`🔍 Discovered ${typeNames.length} exported types:`, typeNames);
  return typeNames;
}

/**
 * Filter types to exclude those not needed for API documentation
 */
function filterRelevantTypes(typeNames: string[]): string[] {
  // Types to exclude from API documentation
  const excludeTypes = [
    'TaskUpdate',                    // Internal task status type
    'MediaType',                     // Simple enum type
    'TranscriptWithUtteranceDrifts', // Internal transcript type
    'SpeakerIdentificationResult',   // Internal processing type
    'TranscriptWithSpeakerIdentification', // Internal transcript type
    'DiarizationSpeakerMatch',       // Internal diarization type
    'DiarizationSpeaker',            // Internal diarization type
    'Diarization',                   // Internal diarization type
    'Voiceprint',                    // Simple type alias
    'Transcript',                    // Internal transcript type
    'Utterance',                     // Internal transcript type
    'Word',                          // Internal transcript type
    'RequestOnTranscript',           // Base interface, not used directly
    'PodcastPart',                   // Internal podcast type
  ];

  const filtered = typeNames.filter(typeName => {
    return !excludeTypes.includes(typeName);
  });

  console.log(`🎯 Filtered to ${filtered.length} relevant types (excluded ${excludeTypes.length}):`, filtered);
  return filtered;
}

/**
 * Generate schemas for all exported types with caching
 * 
 * ARCHITECTURE OVERVIEW:
 * 1. Discover all exported types from types.ts using TypeScript AST
 * 2. Filter out internal types that shouldn't be in API documentation
 * 3. Generate JSON Schema for each relevant type
 * 4. Return schemas in JSON Schema format (will be transformed to OpenAPI 3.0 later)
 * 
 * This function is the entry point for schema generation and handles the
 * complete pipeline from TypeScript types to API-ready schemas.
 */
export function generateAllTaskSchemas(): { [key: string]: TJS.Definition } {
  // Debug cache status
  const currentHash = generateContentHash();
  console.log(`🔍 Cache check: cached=${Object.keys(schemaCache).length > 0}, contentHash=${contentHash.substring(0, 8)}..., currentHash=${currentHash.substring(0, 8)}...`);
  
  // Check if we can use cached schemas
  if (isCacheValid()) {
    console.log('🚀 Using cached schemas (no regeneration needed)');
    return schemaCache;
  }

  console.log('🔄 Generating schemas from TypeScript types...');
  const allTypeNames = discoverExportedTypes();
  const relevantTypeNames = filterRelevantTypes(allTypeNames);
  const allSchemas: { [key: string]: TJS.Definition } = {};

  for (const typeName of relevantTypeNames) {
    const schema = generateSchema(typeName);
    if (schema) {
      allSchemas[typeName] = schema;
    }
  }

  // Update cache with content hash
  schemaCache = { ...allSchemas };
  contentHash = generateContentHash();
  
  // Save to disk
  saveCacheToDisk();
  
  console.log(`✅ Generated ${Object.keys(allSchemas).length} schemas and cached them (hash: ${contentHash.substring(0, 8)}...)`);

  return allSchemas;
}

/**
 * Clear schema cache completely (memory + disk)
 * This is useful for development when you want to regenerate the schemas
 */
export function clearSchemaCache(): void {
  schemaCache = {};
  contentHash = '';
  
  // Clear disk cache
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch (error) {
    console.log('⚠️  Failed to delete cache file:', error instanceof Error ? error.message : String(error));
  }
  
  console.log('🗑️  Schema cache cleared');
}

/**
 * Get cache statistics for debugging
 */
export function getCacheStats(): { 
  isCached: boolean; 
  cacheSize: number; 
  contentHash: string; 
  currentHash: string;
  cacheFileExists: boolean;
  cacheFileAge?: number;
} {
  const currentHash = generateContentHash();
  let cacheFileAge: number | undefined;
  
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      cacheFileAge = Date.now() - stats.mtime.getTime();
    }
  } catch (error) {
    // Ignore errors
  }
  
  return {
    isCached: isCacheValid(),
    cacheSize: Object.keys(schemaCache).length,
    contentHash: contentHash.substring(0, 8) + '...',
    currentHash: currentHash.substring(0, 8) + '...',
    cacheFileExists: fs.existsSync(CACHE_FILE),
    cacheFileAge: cacheFileAge
  };
}

/**
 * Transform JSON Schema references to OpenAPI 3.0 format
 * 
 * WHY THIS IS NEEDED:
 * - typescript-json-schema generates JSON Schema format (#/definitions/)
 * - OpenAPI 3.0 requires #/components/schemas/ format
 * - This is a necessary bridge between two related but different specifications
 * - The transformation is lightweight, reliable, and follows industry patterns
 * 
 * RESEARCH FINDINGS:
 * - typescript-json-schema is hardcoded to use #/definitions/ (not configurable)
 * - No alternative libraries provide better TypeScript → OpenAPI 3.0 generation
 * - This transformation is a standard approach in the ecosystem
 */
function transformSchemaToOpenAPI(schema: TJS.Definition): TJS.Definition {
  const transformed = JSON.parse(JSON.stringify(schema)); // Deep clone to avoid mutating original
  
  // Recursively convert all #/definitions/ references to #/components/schemas/
  const convertRefs = (obj: any): any => {
    if (typeof obj === 'object' && obj !== null) {
      // Convert the reference format
      if (obj.$ref && obj.$ref.startsWith('#/definitions/')) {
        obj.$ref = obj.$ref.replace('#/definitions/', '#/components/schemas/');
      }
      
      // Recursively process all possible reference locations
      if (obj.anyOf) { obj.anyOf.forEach(convertRefs); }
      if (obj.oneOf) { obj.oneOf.forEach(convertRefs); }
      if (obj.allOf) { obj.allOf.forEach(convertRefs); }
      if (obj.items) { convertRefs(obj.items); }
      if (obj.properties) { Object.values(obj.properties).forEach(convertRefs); }
      if (obj.additionalProperties) { convertRefs(obj.additionalProperties); }
    }
    return obj;
  };
  
  return convertRefs(transformed);
}

/**
 * Extract and flatten nested definitions to top-level schemas
 * 
 * WHY THIS IS NEEDED:
 * - typescript-json-schema generates nested definitions within each schema
 * - OpenAPI 3.0 expects all schemas to be at the top level under components/schemas
 * - This flattens the structure and ensures all referenced types are available
 * 
 * PROCESS:
 * 1. Extract definitions from each schema's internal definitions object
 * 2. Move them to the top level of the schemas object
 * 3. Transform references to OpenAPI 3.0 format
 * 4. Remove the original nested definitions to avoid duplication
 */
function extractNestedDefinitions(schemas: { [key: string]: TJS.Definition }): { [key: string]: TJS.Definition } {
  const allSchemas: { [key: string]: TJS.Definition } = { ...schemas };
  
  // Extract definitions from each schema and move them to top level
  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (schema.definitions) {
      for (const [defName, defSchema] of Object.entries(schema.definitions)) {
        // Only add if not already present (avoid duplicates) and if it's a valid definition
        if (!allSchemas[defName] && typeof defSchema === 'object' && defSchema !== null) {
          // Transform the extracted definition to use OpenAPI 3.0 references
          allSchemas[defName] = transformSchemaToOpenAPI(defSchema as TJS.Definition);
        }
      }
      // Remove definitions from the original schema to avoid duplication
      delete schema.definitions;
    }
  }
  
  return allSchemas;
}

/**
 * Get OpenAPI components object with all schemas
 * 
 * FINAL TRANSFORMATION PIPELINE:
 * 1. Generate schemas from TypeScript types (JSON Schema format)
 * 2. Transform all references from #/definitions/ to #/components/schemas/
 * 3. Extract and flatten nested definitions to top level
 * 4. Return OpenAPI 3.0 compatible components object
 * 
 * This is the final step that produces the schemas used by Swagger UI.
 * The transformation ensures compatibility with OpenAPI 3.0 specification.
 */
export function getOpenAPIComponents(): { components: { schemas: { [key: string]: TJS.Definition } } } {
  const allSchemas = generateAllTaskSchemas();
  
  // Transform all schemas to use OpenAPI 3.0 reference format
  const transformedSchemas: { [key: string]: TJS.Definition } = {};
  
  for (const [schemaName, schema] of Object.entries(allSchemas)) {
    transformedSchemas[schemaName] = transformSchemaToOpenAPI(schema);
  }
  
  // Extract nested definitions and flatten them to top level
  const flattenedSchemas = extractNestedDefinitions(transformedSchemas);
  
  return {
    components: {
      schemas: flattenedSchemas
    }
  };
}

