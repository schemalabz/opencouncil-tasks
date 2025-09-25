# Payload Capture & Testing System

## Overview

The payload capture system automatically captures real API requests during development to enable flexible testing with parameter overrides. This system allows developers to test with real data patterns and edge cases by capturing actual frontend requests and replaying them with any combination of parameter modifications.

## Key Benefits

- **Real Data Testing**: Use actual payloads from frontend calls instead of manually crafting test data
- **Flexible Parameter Overrides**: Test any combination of parameters without pre-defined variations
- **Development Workflow**: Streamlined testing with captured payloads during development
- **Task Agnostic**: Works with any task type, not just specific ones
- **Organized Storage**: Task-specific directories for better payload management
- **Interactive Documentation**: Swagger UI for easy testing and exploration

## Architecture

### Core Components

1. **DevPayloadManager**: Unified class for capturing, storing, and managing payloads
2. **Parameter Override System**: Flexible parameter modification using dot-notation syntax
3. **TaskManager Integration**: Automatic capture during task execution
4. **Dev API Endpoints**: RESTful endpoints for testing and payload management
5. **Swagger UI**: Interactive API documentation and testing interface

### Directory Structure

```
data/
└── dev-payloads/
    ├── generateHighlight-payload-2024-01-15T10-30-45-123Z.json
    ├── generateHighlight-payload-2024-01-15T11-15-22-456Z.json
    ├── generateHighlight-latest.json
    ├── transcribe-payload-2024-01-15T09-45-12-789Z.json
    ├── transcribe-latest.json
    └── summarize-latest.json
```

## Quick Start

### 1. Enable Payload Capture

Set environment variables in your `.env` file:

```bash
# Enable payload capture
CAPTURE_PAYLOADS=true

# Capture all tasks (default) or specific ones
CAPTURE_TASK_TYPES=all
# OR
CAPTURE_TASK_TYPES=generateHighlight,transcribe,summarize

# Optional: Customize storage settings
PAYLOAD_MAX_FILES_PER_TASK=50
DATA_DIR=./data
```

### 2. Make API Calls

Make normal API calls from your frontend application. Payloads will be automatically captured:

```bash
# Example: Generate a highlight
curl -X POST http://localhost:3005/generateHighlight \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "callbackUrl": "http://your-app.com/callback",
    "media": {...},
    "parts": [...],
    "render": {...}
  }'
```

### 3. View Captured Payloads

```bash
# View all available task types and their templates
curl http://localhost:3005/dev/test-templates

# View captured payloads for a specific task
curl http://localhost:3005/dev/captured-payloads/generateHighlight

# View all captured payloads
curl http://localhost:3005/dev/captured-payloads
```

### 4. Test with Parameter Overrides

```bash
# Test with latest captured payload
curl -X POST http://localhost:3005/dev/test-task/generateHighlight

# Test with specific captured payload
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?payload=1"

# Test with parameter overrides (single parameter)
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.aspectRatio:social-9x16"

# Test with multiple parameter overrides
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.aspectRatio:social-9x16,render.includeCaptions:true,render.socialOptions.zoomFactor:0.8"

# Test with specific payload and overrides
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?payload=1&overrides=render.socialOptions.backgroundColor:#ffffff"

# Test with custom payload
curl -X POST http://localhost:3005/dev/test-task/generateHighlight \
  -H "Content-Type: application/json" \
  -d '{"media": {...}, "parts": [...], "render": {...}}'

# Test with custom payload and overrides
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.aspectRatio:social-9x16" \
  -H "Content-Type: application/json" \
  -d '{"media": {...}, "parts": [...], "render": {...}}'
```


## Using Swagger UI for Testing

The system includes interactive API documentation at `http://localhost:3005/docs`.

1. **Navigate to `/docs`** in your browser
2. **Select a task endpoint** (e.g., `/dev/test-task/{taskType}`)
3. **Click "Try it out"** to enable interactive testing
4. **Set parameters**:
   - `taskType`: Choose from dropdown (generateHighlight, transcribe, etc.)
   - `payload`: Index of captured payload (optional)
   - `overrides`: Parameter overrides in dot-notation (optional)
5. **Execute** to test with real data
6. **View results** and copy cURL commands for further use

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAPTURE_PAYLOADS` | `false` | Enable/disable payload capture |
| `CAPTURE_TASK_TYPES` | `all` | Task types to capture (`all` or comma-separated list). Invalid task types will trigger warnings and fall back to `all`. |
| `PAYLOAD_MAX_FILES_PER_TASK` | `10` | Maximum files to keep per task type |
| `DATA_DIR` | `./data` | Base directory for data storage |

### Programmatic Configuration

```typescript
import { DevPayloadManager } from './tasks/utils/devPayloadManager.js';

// Get current configuration
const config = DevPayloadManager.getConfig();

// Check if capture is enabled for a task
const shouldCapture = DevPayloadManager.shouldCapture('generateHighlight', payload);

// Manually capture a payload
await DevPayloadManager.capture('generateHighlight', payload);

// Get captured payloads
const payloads = await DevPayloadManager.getCapturedPayloads('generateHighlight');

// Get available task types
const taskTypes = await DevPayloadManager.getAvailableTaskTypes();

// Clear payloads
await DevPayloadManager.clearPayloads('generateHighlight');
```

## Parameter Override System

The parameter override system allows you to modify any parameter in a captured payload using dot-notation syntax. This replaces the need for pre-defined variations with flexible, on-the-fly parameter modification.

### Override Syntax

**Format**: `path:value,path2:value2`

**Examples**:
- `render.aspectRatio:social-9x16` - Change aspect ratio
- `render.includeCaptions:true` - Enable captions
- `render.socialOptions.zoomFactor:0.8` - Set zoom factor
- `render.socialOptions.backgroundColor:#ffffff` - Set background color

### Supported Value Types

- **Strings**: `render.aspectRatio:social-9x16`
- **Booleans**: `render.includeCaptions:true`
- **Numbers**: `render.socialOptions.zoomFactor:0.8`
- **Colors**: `render.socialOptions.backgroundColor:#ffffff`
- **Arrays**: `render.features:[caption,speaker,overlay]`
- **Objects**: `render.socialOptions:{marginType:solid,backgroundColor:#000000}`

### Common Override Examples

#### GenerateHighlight Task

```bash
# Change aspect ratio
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.aspectRatio:social-9x16"

# Enable captions and speaker overlay
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.includeCaptions:true,render.includeSpeakerOverlay:true"

# Configure social media options
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.socialOptions.marginType:solid,render.socialOptions.backgroundColor:#ffffff,render.socialOptions.zoomFactor:0.8"

# Complex configuration
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.aspectRatio:social-9x16,render.includeCaptions:true,render.socialOptions:{marginType:blur,zoomFactor:0.7}"
```


#### `POST /dev/test-task/:taskType`
Test a task with captured payloads and parameter overrides.

**Query Parameters:**
- `payload` (optional): Index of captured payload to use (default: 0)
- `overrides` (optional): Parameter overrides in dot-notation format

**Request Body:** Custom payload (optional)

**Response:**
```json
{
  "success": true,
  "message": "Task test completed successfully",
  "taskType": "generateHighlight",
  "testName": "payload-0-with-overrides",
  "result": {
    "parts": [...]
  },
  "payload": {
    "media": {...},
    "parts": [...],
    "render": {
      "aspectRatio": "social-9x16",
      "includeCaptions": true
    }
  },
  "overrides": {
    "render.aspectRatio": "social-9x16",
    "render.includeCaptions": true
  }
}
```

#### `GET /dev/captured-payloads/:taskType?`
Get captured payloads for a specific task type or all tasks.

#### `DELETE /dev/captured-payloads/:taskType?`
Clear captured payloads for a specific task type or all tasks.



## Development Workflow

### 1. **Capture Real Data**
```bash
# Enable capture
export CAPTURE_PAYLOADS=true

# Start your development server
npm run dev

# Make requests from your frontend application
# Payloads are automatically captured
```

### 2. **Explore Captured Data**
```bash
# See what's available
curl http://localhost:3005/dev/test-templates

# View specific task payloads
curl http://localhost:3005/dev/captured-payloads/generateHighlight
```

### 3. **Test with Parameter Overrides**
```bash
# Test with latest payload
curl -X POST http://localhost:3005/dev/test-task/generateHighlight

# Test specific scenario with overrides
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?overrides=render.aspectRatio:social-9x16,render.includeCaptions:true"

# Test with older payload and custom overrides
curl -X POST "http://localhost:3005/dev/test-task/generateHighlight?payload=2&overrides=render.socialOptions.zoomFactor:0.8"

# Use Swagger UI for interactive testing
# Visit: http://localhost:3005/docs
```

### 4. **Iterate and Debug**
- Use parameter overrides to test different configurations
- Combine multiple overrides for complex scenarios
- Use Swagger UI for interactive exploration
- Compare results across different parameter combinations
- Clear old payloads when needed

## Best Practices

### Security
- Payloads are automatically sanitized (callback URLs replaced with 'dev-test')
- Don't commit captured payload files to version control
- Add `data/dev-payloads/` to your `.gitignore`

### Performance
- Set reasonable limits with `PAYLOAD_MAX_FILES_PER_TASK`
- Clear old payloads periodically
- Use task-specific capture (`CAPTURE_TASK_TYPES`) in production-like environments

### Testing
- Use captured payloads for integration tests
- Test different parameter combinations before deploying new features
- Use Swagger UI for interactive testing and exploration
- Keep representative payloads for regression testing

### Organization
- Use meaningful parameter override combinations
- Document common override patterns for your team
- Use Swagger UI to discover available parameters
- Group related overrides logically in your testing workflow

## Troubleshooting

### No Payloads Captured
1. Check `CAPTURE_PAYLOADS=true` is set
2. Verify task type is included in `CAPTURE_TASK_TYPES`
3. Ensure requests include `skipCapture: false` or omit the property
4. Check server logs for capture errors

### Parameter Overrides Not Working
1. Check override syntax is correct (path:value format)
2. Verify parameter paths exist in the payload
3. Ensure value types match expected parameter types
4. Check for typos in parameter names (case-sensitive)
5. Use Swagger UI to explore available parameters

### Storage Issues
1. Check `DATA_DIR` permissions
2. Verify disk space availability
3. Review `PAYLOAD_MAX_FILES_PER_TASK` settings

### Import Errors
1. Ensure task files export the correct function name
2. Check task file paths match the expected pattern: `src/tasks/{taskType}.js`
3. Verify task functions accept the expected signature: `(payload, onProgress) => Promise<result>`
 