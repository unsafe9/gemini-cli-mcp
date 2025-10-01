# Gemini MCP Server

MCP Server that delegates tasks to Gemini CLI's large context window.

Bridges MCP clients (Claude Desktop, Cline, etc.) with Google's Gemini API via gemini-cli-core for:
- 📊 **Feature Planning** with massive context windows
- 🔍 **Code Analysis** across entire codebases  
- 🔒 **Security Audits** with deep understanding

## Key Features

- 🧠 **1M Token Context** - Analyze entire large codebases in one go
- 📁 **Direct File Access** - Gemini reads files using `@filename` or `@directory/` syntax
- 🔄 **Persistent Sessions** - Context maintained across requests with GeminiChat instances
- 🆓 **Cost Effective** - Use free Gemini tier for planning, save Claude for implementation
- 🔐 **OAuth2 Authentication** - Secure authentication via Google OAuth

## Architecture

```
MCP Client → MCP Server → gemini-cli-core → Gemini API
                            ├─ Config (OAuth2)
                            ├─ GeminiClient
                            └─ GeminiChat (Sessions)
```

- **MCP Layer**: Exposes tools to any MCP client
- **gemini-cli-core**: Official Gemini CLI Core library
  - **Config**: Manages authentication and tool registry
  - **GeminiClient**: API client for Gemini
  - **GeminiChat**: Maintains conversation history and sessions
- **Gemini API**: Google's Gemini AI service

### Session Management

Each session is managed by a `GeminiSessionManager` instance:

```typescript
import { GeminiSessionManager } from './gemini-session-manager.js';

const manager = new GeminiSessionManager(projectRoot, 'gemini-2.5-flash', sessionId);
await manager.start();  // Initialize Config, authenticate, start chat
const response = await manager.sendPrompt('Analyze this code');
await manager.stop();   // Cleanup resources
```

## Quick Start

### 1. Install & Build
```bash
cd ~/workspace/gemini-cli-mcp
npm install && npm run build
```

### 2. Authenticate with Google
The server will automatically prompt for OAuth2 authentication on first run. Make sure you have:
- Google account with Gemini API access
- Access to https://aistudio.google.com/apikey (optional, for API key method)

### 3. Configure MCP Client
Add to your MCP settings (Cursor: `~/.cursor/mcp.json`, Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gemini-planning": {
      "command": "node",
      "args": ["/Users/wshan/workspace/gemini-cli-mcp/dist/index.js"]
    }
  }
}
```

## Usage

The MCP server exposes three intelligent tools:

### `gemini_plan` - Planning & Architecture
**Triggers:** "plan", "design", "architecture", "how should I"
- Creates comprehensive implementation plans
- Breaks down complex features into manageable tasks
- Suggests next steps: analysis, review, validation

### `gemini_analyze` - Code Analysis & Security
**Triggers:** "analyze", "check", "find issues", "optimization"
- Performs holistic technical audits
- Identifies security vulnerabilities and performance issues
- Assesses architecture, maintainability, and tech debt

### `gemini_review` - Code Review & Feedback
**Triggers:** "review", "feedback", "look at", "check this code"
- Provides expert code review with severity levels
- Evaluates security, performance, and best practices
- Offers actionable fixes and improvements

## Examples

```bash
# Planning
"Plan a microservices architecture using @src/ and @docs/requirements/"

# Analysis  
"Analyze @src/api/ for security vulnerabilities and performance issues"

# Review
"Review @src/features/payment/ for security and best practices"
```

**Key:** Use `@filename` or `@directory/` syntax - Gemini CLI reads files directly with 2M token context!

## Development

```bash
npm run dev    # Watch mode
npm run build  # Build
npm start      # Run
```

## Troubleshooting

**Authentication failed:**
- The server uses OAuth2 authentication via gemini-cli-core
- Make sure you have a Google account with Gemini API access
- Check that you can access https://aistudio.google.com/

**Session errors:**
- Each MCP request creates or reuses a session based on `session_id`
- Sessions are automatically cleaned up after 30 minutes of inactivity
- If experiencing issues, try with a new `session_id`

## Requirements

- Node.js 18+
- Google account with Gemini API access
- Internet connection for OAuth2 authentication

## License

MIT
