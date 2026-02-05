---
name: task-creation
description: Create a new task in the opencouncil-tasks codebase. Use when implementing new features or task handlers.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# SKILL: Create New Task

You are creating a new task in the opencouncil-tasks codebase. Follow these instructions precisely.

## Task Structure

Each task in this codebase is a function of type `Task<Args, Ret>`:

```typescript
type Task<Args, Ret> = (args: Args, onProgress: (stage: string, progressPercent: number) => void) => Promise<Ret>;
```

## Steps to Create a New Task

### 1. Define Types in `src/types.ts`

Add request and result types for your task:

```typescript
/*
 * Task: YourTaskName
 */

export interface YourTaskRequest extends TaskRequest {
    // Input parameters
    someInput: string;
    optionalInput?: number;
}

export interface YourTaskResult {
    // Output data
    someOutput: string;
    metadata?: {
        // Optional metadata about the operation
    };
}
```

**Rules:**
- Request types extend `TaskRequest` (which includes `callbackUrl: string`)
- Use descriptive names that match the task purpose
- Include optional `metadata` in results for debugging/logging info

### 2. Create Task File in `src/tasks/`

Create `src/tasks/yourTaskName.ts`:

```typescript
import { YourTaskRequest, YourTaskResult } from "../types.js";
import { Task } from "./pipeline.js";

export const yourTaskName: Task<YourTaskRequest, YourTaskResult> = async (request, onProgress) => {
    console.log("Starting yourTaskName:", {
        // Log relevant request info (not sensitive data)
    });

    onProgress("initializing", 10);

    // Implementation here...

    onProgress("processing", 50);

    // More implementation...

    onProgress("complete", 100);

    return {
        // Result object matching YourTaskResult
    };
};
```

**Rules:**
- Use `.js` extensions in imports (ESM requirement)
- Import `Task` type from `./pipeline.js`
- Export a named constant matching the filename
- Call `onProgress` at meaningful stages
- Log important info at start for debugging

### 3. Register in Server (`src/server.ts`)

Add your task to the task registry:

```typescript
import { yourTaskName } from "./tasks/yourTaskName.js";

// In the taskRegistry object:
const taskRegistry: TaskRegistry = {
    // ... existing tasks
    yourTaskName: yourTaskName as Task<any, any>,
};
```

### 4. Add CLI Support (`src/cli.ts`)

If the task should be callable from CLI, add a command:

```typescript
program
    .command("your-task-name")
    .description("Description of what the task does")
    .requiredOption("--input <file>", "Path to input JSON file")
    .option("--optional-param <value>", "Optional parameter description")
    .action(async (options) => {
        // Parse input, call task, output results
    });
```

### 5. Create Unit Tests

Create `src/tasks/yourTaskName.test.ts` for pure functions:

**DO test:**
- Pure helper functions (parsing, formatting, calculations)
- Any function with stable input → output behavior

**DO NOT test:**
- Network calls, file I/O, external services
- These are covered by integration/smoke tests

### 6. Document the Task

After implementation is complete, use `/task-docs` to create documentation in `docs/yourTaskName.md`.

## External Service Integration

If your task calls external APIs:

### Create a Client in `src/lib/`

```typescript
// src/lib/ServiceClient.ts
export interface ServiceResponse {
    // Response types
}

class ServiceClient {
    private baseUrl: string;
    private apiKey: string;

    constructor() {
        this.baseUrl = process.env.SERVICE_API_URL || "https://api.service.com";
        this.apiKey = process.env.SERVICE_API_KEY || "";
    }

    async fetchData(params: object): Promise<ServiceResponse> {
        // Implementation
    }
}

export const serviceClient = new ServiceClient();
```

**Rules:**
- Use environment variables for configuration
- Export a singleton instance for convenience
- Define clear interfaces for API responses

## Checklist Before Completing

- [ ] Types defined in `src/types.ts`
- [ ] Task implementation in `src/tasks/yourTaskName.ts`
- [ ] Task registered in `src/server.ts`
- [ ] CLI command added (if applicable)
- [ ] Unit tests for pure functions
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Documentation created (use `/task-docs`)
