# [TaskName] Task

## Overview
Brief technical description of the task's core functionality and its role in the system architecture. Explain what the task does, why it exists, and how it fits into the overall system. Keep it to 2-3 sentences maximum.

## Architecture
High-level technical design, data flow, and key architectural decisions. Describe the main components, how data flows through the task, and any significant design patterns or architectural choices. Include references to main implementation files using the format `[filename.ext](path/to/file)`. Add a Mermaid diagram showing the processing flow if the task has multiple sequential steps.

## Input/Output Contract
- **Input**: High-level description of what the task expects as input. Mention the main data structures and any important constraints or requirements. Reference the input type definition file.
- **Output**: High-level description of what the task produces as output. Mention the main data structures and any guarantees about the output format. Reference the output type definition file.
- **File References**: List the specific files containing type definitions, request/response interfaces, and data structures.

## Processing Pipeline
Sequential steps of the task execution. List the main processing phases in order, describe what happens in each phase, and mention any data transformations or external service calls. Include a Mermaid diagram showing the flow between phases. Keep descriptions concise but include enough detail to understand the logic flow.

## Dependencies
List all external services, APIs, and third-party dependencies required by this task. For each dependency, mention what it's used for, any configuration requirements, and important constraints like rate limits or usage costs. Include environment variables needed for configuration.

## Integration Points
Describe how this task integrates with the rest of the system. Mention API endpoints, task manager integration, callback mechanisms, and any related tasks that work together in workflows. Reference relevant routing and registration files.

## Configuration
List all environment variables, runtime parameters, and feature flags used by this task. For each configuration item, provide a brief description of what it controls and any default values or constraints.

## Key Functions & Utilities
List the main exported functions, utilities, and helper modules that this task provides. Include brief descriptions of their purpose and when they might be used by other parts of the system.

## Data Flow & State Management
Describe how data flows through the task, any state management patterns used, and how the task handles concurrent operations or shared state. Include information about data persistence, caching, or temporary storage if applicable.