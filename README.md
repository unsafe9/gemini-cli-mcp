# Gemini MCP Server

An MCP (Model Context Protocol) server that leverages Gemini CLI's large context window to provide powerful AI tools for code planning, analysis, and review. Bridges MCP clients (Claude Desktop, Claude Code, etc.) with Google's Gemini API through gemini-cli-core, offering 1M+ token context for comprehensive codebase analysis with direct file access.

## Tools

### `gemini_plan` - Planning & Architecture
Expert planning consultant that creates comprehensive implementation plans with phases, dependencies, and visual diagrams.

### `gemini_analyze` - Code Analysis & Security  
Senior software analyst performing holistic technical audits to identify security vulnerabilities, performance issues, and architectural problems.

### `gemini_review` - Code Review & Feedback
Expert code reviewer providing detailed feedback with severity levels, concrete fixes, and actionable improvements.

## Quick Start

### Install & Build
```bash
npm install && npm run build
```

### Setup MCP Client
```json
{
  "mcpServers": {
    "gemini-planning": {
      "command": "node",
      "args": ["/path/to/gemini-cli-mcp/dist/index.js"],
      "env": {
        "GEMINI_MODEL": "gemini-2.5-pro"
      }
    }
  }
}
```

### Authentication

**Gemini CLI Compatible**: Uses the same environment variables as the official Gemini CLI.

- **OAuth**: No environment variables needed (default)
- **Vertex AI**: Set `GOOGLE_GENAI_USE_VERTEXAI=true` with GCP credentials

**Environment Variables**:
- `GEMINI_API_KEY` - API key authentication
- `GOOGLE_GENAI_USE_VERTEXAI=true` - Vertex AI
- `GOOGLE_GENAI_USE_GCA=true` - Force OAuth

## Examples

### Planning
```
"Plan a microservices architecture using @src/ and @docs/requirements/"
"Design a payment system with @src/payment/ and @docs/api-specs/"
"How should I implement user authentication in @src/auth/?"
```

### Analysis
```
"Analyze @src/api/ for security vulnerabilities and performance issues"
"Check @components/ for performance bottlenecks"
"Find code quality issues in @utils/helper.ts"
"Analyze @src/ for architectural patterns and tech debt"
```

### Review
```
"Review @src/auth/login.ts for security and best practices"
"Review the changes in @components/ and provide feedback"
"Check @api/routes.ts for potential bugs"
"Review @src/features/payment/ for security issues"
```

**File Access:** Use `@filename` or `@directory/` syntax - Gemini CLI reads files directly.
