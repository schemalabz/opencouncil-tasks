import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration check result
 */
interface ConfigCheck {
    name: string;
    status: 'available' | 'missing' | 'partial';
    message: string;
    required: boolean;
}

/**
 * Check if an environment variable is set
 */
function checkEnvVar(name: string): boolean {
    const value = process.env[name];
    return !!value && value.trim() !== '';
}

/**
 * Service configuration definitions
 * This is the single source of truth for required environment variables
 */
const SERVICE_CONFIGS = [
    // Core AI Services (Required)
    {
        name: 'Anthropic (Claude)',
        envVars: ['ANTHROPIC_API_KEY'],
        required: true,
        availableMessage: '✓ AI summarization and extraction enabled',
        missingMessage: '✗ ANTHROPIC_API_KEY not set - core AI features will fail'
    },

    // Optional AI Services
    {
        name: 'Perplexity Sonar',
        envVars: ['PERPLEXITY_API_KEY'],
        required: false,
        availableMessage: '✓ Web context enhancement enabled',
        missingMessage: '⚠ PERPLEXITY_API_KEY not set - subjects will not be enhanced with web context'
    },

    // Storage Services
    {
        name: 'DigitalOcean Spaces',
        envVars: ['DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_ENDPOINT'],
        required: false,
        availableMessage: '✓ File upload to Spaces enabled',
        partialMessage: '⚠ Partial Spaces configuration - missing one or more: DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_ENDPOINT',
        missingMessage: '⚠ Spaces not configured - file uploads will fail'
    },

    // Transcription Services
    {
        name: 'Gladia Transcription',
        envVars: ['GLADIA_API_KEY'],
        required: false,
        availableMessage: '✓ Transcription service enabled',
        missingMessage: '⚠ GLADIA_API_KEY not set - transcription tasks will fail'
    },

    // Diarization Services
    {
        name: 'Pyannote Diarization',
        envVars: ['PYANNOTE_API_TOKEN'],
        required: false,
        availableMessage: '✓ Speaker diarization enabled',
        missingMessage: '⚠ PYANNOTE_API_TOKEN not set - diarization tasks will fail'
    },

    // Video Services
    {
        name: 'Mux Video',
        envVars: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET'],
        required: false,
        availableMessage: '✓ Video processing enabled',
        partialMessage: '⚠ Partial Mux configuration - missing MUX_TOKEN_ID or MUX_TOKEN_SECRET',
        missingMessage: '⚠ Mux not configured - video processing features limited'
    },

    // Geocoding Services
    {
        name: 'Google Geocoding',
        envVars: ['GOOGLE_API_KEY'],
        required: false,
        availableMessage: '✓ Location geocoding enabled',
        missingMessage: '⚠ GOOGLE_API_KEY not set - location features will fail'
    },

    // Search Services
    {
        name: 'Elasticsearch',
        envVars: ['ELASTICSEARCH_HOST', 'ELASTICSEARCH_API_KEY', 'ELASTICSEARCH_CONNECTOR_ID'],
        required: false,
        availableMessage: '✓ Search indexing enabled',
        partialMessage: '⚠ Partial Elasticsearch configuration - check ELASTICSEARCH_HOST, ELASTICSEARCH_API_KEY, ELASTICSEARCH_CONNECTOR_ID',
        missingMessage: '⚠ Elasticsearch not configured - search sync will fail'
    },

    // Observability (Optional)
    {
        name: 'Langfuse Observability',
        envVars: ['LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_BASEURL'],
        required: false,
        availableMessage: '✓ LLM observability enabled',
        partialMessage: '⚠ Partial Langfuse configuration - check LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_BASEURL',
        missingMessage: 'ℹ Langfuse not configured - LLM observability disabled'
    },

    // Internal Services (Optional)
    {
        name: 'Adaline Deployment',
        envVars: ['ADALINE_SECRET'],
        required: false,
        availableMessage: '✓ Adaline integration enabled',
        missingMessage: 'ℹ ADALINE_SECRET not configured - prompt management via Adaline disabled'
    }
] as const;

/**
 * Perform all configuration checks at startup
 */
export function performStartupChecks(): void {
    console.log('\n🔍 Configuration Status:');
    console.log('━'.repeat(80));

    const checks: ConfigCheck[] = SERVICE_CONFIGS.map(config => {
        const presentVars = config.envVars.filter(checkEnvVar);
        const allPresent = presentVars.length === config.envVars.length;
        const nonePresent = presentVars.length === 0;

        let status: 'available' | 'missing' | 'partial';
        let message: string;

        if (allPresent) {
            status = 'available';
            message = config.availableMessage;
        } else if (nonePresent) {
            status = 'missing';
            message = config.missingMessage;
        } else {
            status = 'partial';
            message = ('partialMessage' in config ? config.partialMessage : config.missingMessage) as string;
        }

        return {
            name: config.name,
            status,
            message,
            required: config.required
        };
    });

    // Group by status
    const available = checks.filter(c => c.status === 'available');
    const partial = checks.filter(c => c.status === 'partial');
    const missing = checks.filter(c => c.status === 'missing');
    const criticalMissing = missing.filter(c => c.required);

    // Print all checks
    checks.forEach(check => {
        console.log(`  ${check.message}`);
    });

    console.log('━'.repeat(80));
    console.log(`📊 Summary: ${available.length} available, ${partial.length} partial, ${missing.length} missing`);
    
    // Warn if critical services are missing
    if (criticalMissing.length > 0) {
        console.log('\n⚠️  CRITICAL: Required services are missing! Server may not function properly.');
        console.log('   Please configure: ' + criticalMissing.map(c => c.name).join(', '));
    }
    
    console.log('');
}
