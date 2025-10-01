import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { GeminiSessionManager } from './gemini-session-manager.js';

/**
 * Factory function type for creating Gemini session managers
 */
export type GeminiSessionFactory = (projectPath: string, sessionId: string) => GeminiSessionManager;

/**
 * Tool arguments schema for validation
 */
const toolArgsSchema = z.object({
    prompt: z.string().min(1, 'Prompt is required'),
    project_path: z.string().optional(),
    session_id: z.string().optional(),
});

/**
 * MCP Server that exposes Gemini capabilities as tools
 * This server acts as a bridge between MCP clients and Gemini CLI Core API
 */
export class MCPServer {
    private server: Server;
    private sessions: Map<string, GeminiSessionManager> = new Map();
    private sessionFactory: GeminiSessionFactory;

    /**
     * @param sessionFactory Factory function that creates GeminiSessionManager instances
     * @param serverName Name of the MCP server
     * @param serverVersion Version of the MCP server
     */
    constructor(sessionFactory: GeminiSessionFactory, serverName: string, serverVersion: string) {
        this.sessionFactory = sessionFactory;
        this.server = new Server(
            {
                name: serverName,
                version: serverVersion,
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.setupToolHandlers();
        this.setupErrorHandling();
    }

    private setupToolHandlers() {
        // Core guidelines for MCP clients
        const geminiGuidelines = `
🚫 **NEVER READ FILES FIRST** - Call Gemini tools directly with @path/to/file syntax.
❌ WRONG: "analyze structure first" or "read files then analyze"
✅ CORRECT: "gemini_analyze @src/ for analysis" or "gemini_review @src/components/"

Gemini CLI reads all files automatically - just provide the path!
`;

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'gemini_plan',
                        description:
                            'Create comprehensive, implementation-ready plans for complex feature development.\n\n' +
                            '**USE WHEN:** "plan", "design", "architecture", "how should I", "what\'s the best approach", feature strategy, system design, migration strategies\n\n' +
                            '**EXAMPLES:**\n' +
                            '- "Plan a microservices architecture using @src/ and @docs/requirements/"\n' +
                            '- "How should I structure my React application for scalability?"\n\n' +
                            '**WORKFLOW:** For complex plans, break into phases: Core architecture → Implementation → Testing/Deployment\n\n' +
                            '**OUTPUT:** Structured plans with phases, dependencies, diagrams, and actionable recommendations\n\n' +
                            geminiGuidelines,
                        inputSchema: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description: 'The planning request or question to send to Gemini. Include context about the feature, goals, and any constraints.',
                                },
                                project_path: {
                                    type: 'string',
                                    description: 'Optional: Absolute path to the project directory. Defaults to current working directory.',
                                },
                                session_id: {
                                    type: 'string',
                                    description: 'Optional: Session ID for maintaining conversation context across requests. Use the same ID for follow-up questions.',
                                },
                            },
                            required: ['prompt'],
                        },
                    } as Tool,
                    {
                        name: 'gemini_analyze',
                        description:
                            'Perform holistic technical audits. Help engineers understand codebase alignment with long-term goals, architectural soundness, scalability, and maintainability.\n\n' +
                            '**USE WHEN:** "analyze", "check", "find issues", "optimization", "performance", security audit, code quality, architecture patterns, best practices, scalability assessment\n\n' +
                            '**EXAMPLES:**\n' +
                            '- "Analyze @src/api/ for security vulnerabilities"\n' +
                            '- "Analyze @src/ for architectural patterns and tech debt"\n\n' +
                            '**WORKFLOW:** Initial Assessment → Deep Dive → Cross-Reference → Validation → Action Planning\n\n' +
                            '**OUTPUT:** Executive summary, key findings, recommendations, and prioritized action items\n\n' +
                            geminiGuidelines,
                        inputSchema: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description: 'The analysis request. Be specific about what you want to analyze and why.',
                                },
                                project_path: {
                                    type: 'string',
                                    description: 'Optional: Absolute path to the project directory',
                                },
                                session_id: {
                                    type: 'string',
                                    description: 'Optional: Session ID for maintaining conversation context across requests. Use the same ID for follow-up questions.',
                                },
                            },
                            required: ['prompt'],
                        },
                    } as Tool,
                    {
                        name: 'gemini_review',
                        description:
                            'Deliver precise, actionable feedback to improve code quality. Deep knowledge of software-engineering best practices across security, performance, maintainability, and architecture.\n\n' +
                            '**USE WHEN:** "review", "feedback", "look at", "check this code", "what do you think", code changes, pull requests, commits, implementation evaluation, bug identification, code style, security/performance concerns\n\n' +
                            '**EXAMPLES:**\n' +
                            '- "Review @src/auth/login.ts for security and best practices"\n' +
                            '- "Review @file1.ts @file2.ts @dir/ for batch review"\n\n' +
                            '**WORKFLOW:** Initial Scan → Security Focus → Performance Check → Best Practices → Integration Test → Action Planning\n\n' +
                            '**OUTPUT:** Detailed findings with severity levels, specific fixes, and code examples\n\n' +
                            geminiGuidelines,
                        inputSchema: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description: 'The review request. Specify files or directories to review and what aspects to focus on.',
                                },
                                project_path: {
                                    type: 'string',
                                    description: 'Optional: Absolute path to the project directory',
                                },
                                session_id: {
                                    type: 'string',
                                    description: 'Optional: Session ID for maintaining conversation context across requests. Use the same ID for follow-up questions.',
                                },
                            },
                            required: ['prompt'],
                        },
                    } as Tool,
                ],
            };
        });

        // Handle tool calls
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const { name, arguments: args } = request.params;
            const startTime = Date.now();

            if (!args) {
                throw new Error('Missing tool arguments');
            }

            try {
                // Validate arguments with Zod
                const validatedArgs = toolArgsSchema.parse(args);
                const { prompt: userPrompt, project_path, session_id } = validatedArgs;
                const projectPath = project_path || process.cwd();
                const userSessionId = session_id || 'default';

                // Create unique session key combining tool name and user session ID
                // This ensures different tools have separate sessions with their own system instructions
                const sessionKey = `${name}:${userSessionId}`;

                console.error(`[MCP Server] 🚀 ${name} (session: ${userSessionId}, key: ${sessionKey})`);

                // Get or create session
                let sessionManager = this.sessions.get(sessionKey);
                if (!sessionManager) {
                    console.error(`[MCP Server] Creating new session: ${sessionKey}`);
                    sessionManager = this.sessionFactory(projectPath, userSessionId);

                    // Get role-specific system instruction
                    const systemInstruction = this.getRoleInstruction(name);

                    // Start session with system instruction
                    await sessionManager.start(systemInstruction);
                    this.sessions.set(sessionKey, sessionManager);
                }

                console.error(`[MCP Server] ⏳ Processing ${name}...`);

                // Send user prompt with progress callback
                const response = await sessionManager.sendPrompt(userPrompt, 6000000, async (message) => {
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: {
                            progressToken: extra.requestId,
                            progress: 0,
                            message: message,
                        },
                    });

                    console.error(`[MCP Server] 📊 ${message}`);
                });

                const processingTime = Date.now() - startTime;
                console.error(`[MCP Server] ✅ ${name} completed in ${processingTime}ms`);

                return {
                    content: [
                        {
                            type: 'text',
                            text: response,
                        },
                    ],
                    metadata: {
                        session_id: userSessionId,
                        tool: name,
                        model: sessionManager.getModel(),
                        timestamp: new Date().toISOString(),
                        processing_time_ms: processingTime,
                        project_path: projectPath,
                        file_references: this.extractFileReferences(userPrompt),
                    },
                };
            } catch (error) {
                const processingTime = Date.now() - startTime;
                console.error(`[MCP Server] ❌ Error executing ${name} after ${processingTime}ms:`, error);

                if (error instanceof z.ZodError) {
                    const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Invalid arguments: ${issues}`,
                            },
                        ],
                        isError: true,
                        metadata: {
                            tool: name,
                            error_type: 'validation_error',
                            processing_time_ms: processingTime,
                        },
                    };
                }

                const errorMessage = error instanceof Error ? error.message : String(error);
                const context = `Tool: ${name}`;

                return {
                    content: [
                        {
                            type: 'text',
                            text: this.formatErrorResponse(
                                new Error(`Error communicating with Gemini CLI: ${errorMessage}`),
                                context
                            ),
                        },
                    ],
                    isError: true,
                    metadata: {
                        tool: name,
                        error_type: 'execution_error',
                        processing_time_ms: processingTime,
                    },
                };
            }
        });
    }

    private setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error('[MCP Server] Error:', error);
        };

        process.on('SIGINT', async () => {
            await this.cleanup();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            await this.cleanup();
            process.exit(0);
        });
    }

    /**
     * Get role-specific system instruction based on tool name
     */
    private getRoleInstruction(toolName: string): string {
        const baseInstructions = `You are an AI agent delegated by an MCP client. 

🚫 CRITICAL: Provide COMPLETE responses in a single call. Do NOT ask follow-up questions or request additional information.
✅ REQUIRED: Deliver comprehensive, actionable results immediately.
❌ FORBIDDEN: "Do you need more details?", "Should I continue?", or partial responses.

You handle ALL file reading automatically.`;

        switch (toolName) {
            case 'gemini_plan':
                return `${baseInstructions}

**TASK:** Create comprehensive, implementation-ready plans for complex feature development

**REQUIRED OUTPUT:**
1. Executive Summary
2. Phased Implementation Plan (numbered phases)
3. Technical Architecture (with ASCII diagrams)
4. Risk Assessment
5. Next Steps

**FORMAT:** Use numbered phases, ASCII diagrams (Phase 1 → Phase 2), bullet points, no emojis`;

            case 'gemini_analyze':
                return `${baseInstructions}

**TASK:** Perform holistic technical audits focusing on architecture, scalability, and maintainability

**REQUIRED OUTPUT:**
1. Executive Summary (one paragraph)
2. Key Findings (categorized with evidence)
3. Quick Wins
4. Next Steps

**ASSESS:** Architecture, scalability, maintainability, security, operations, future-proofing
**SEVERITY:** CRITICAL | HIGH | MEDIUM | LOW`;

            case 'gemini_review':
                return `${baseInstructions}

**TASK:** Deliver precise, actionable feedback to improve code quality

**REQUIRED OUTPUT:**
1. Findings with locations and severity
2. Concrete fixes with code examples
3. Overall Quality Assessment
4. Top 3 Priorities
5. Positive Aspects

**FOCUS:** Security, performance, maintainability, architecture, testing, dependencies
**SEVERITY:** CRITICAL | HIGH | MEDIUM | LOW`;

            default:
                return baseInstructions;
        }
    }



    /**
     * Extract file references from user prompt using @syntax
     */
    private extractFileReferences(prompt: string): string[] {
        const fileRefPattern = /@([^\s]+)/g;
        const matches = [];
        let match;

        while ((match = fileRefPattern.exec(prompt)) !== null) {
            matches.push(match[1]);
        }

        return matches;
    }

    /**
     * Enhanced error handling with structured response
     */
    private formatErrorResponse(error: Error, context: string): string {
        const errorMessage = error.message;

        return `## ❌ Error: ${errorMessage}

**Context:** ${context}

**Possible Solutions:**
1. **Authentication Issues:**
   - Verify Gemini CLI is properly configured
   - Check Google OAuth2 credentials
   - Run: \`gemini auth login\`

2. **Network Issues:**
   - Check internet connection
   - Verify firewall settings
   - Try again in a few moments

3. **Configuration Issues:**
   - Check project path is valid
   - Verify file permissions
   - Ensure required files exist

**Next Steps:**
1. Check the logs for more details
2. Verify your setup using: \`gemini --version\`
3. Retry the operation
4. Contact support if the issue persists

**Useful Commands:**
- \`gemini auth status\` - Check authentication status
- \`gemini config list\` - View current configuration
- \`gemini --help\` - Get help with commands`;
    }

    async cleanup() {
        const shutdownPromises: Promise<void>[] = [];
        for (const [, sessionManager] of this.sessions.entries()) {
            shutdownPromises.push(sessionManager.stop());
        }
        await Promise.all(shutdownPromises);
        this.sessions.clear();
    }

    async start() {
        console.error('[MCP Server] Starting Gemini CLI MCP Server');
        console.error('[MCP Server] Available tools: gemini_plan, gemini_analyze, gemini_review');
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('[MCP Server] Ready and listening for requests');
    }
}


