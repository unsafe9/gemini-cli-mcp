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
        // List available tools
        const geminiGuidelines =
            '**FILE HANDLING:** Gemini CLI can read files directly. DO NOT read files yourself. ' +
            'Use @path/to/file for single files or @directory/ for entire directories (recursively includes all files inside). All @ paths are relative to project_path. ' +
            'Examples: "@src/auth/login.ts" (single file), "@src/auth/" (all files in auth folder), "@src/" (entire src directory), "@package.json" (root file).\n\n' +
            '**HOW TO PROMPT:** Use imperative/command form (e.g., "Analyze the authentication flow in @src/auth/", "Review @components/Button.tsx for performance"). Be direct and specific.\n\n' +
            '**RESPONSE TIME:** Gemini processes requests thoroughly (10-30+ seconds for complex analysis). Each tool call returns a COMPLETE, comprehensive response. Do NOT make follow-up calls asking to "continue" or "provide complete results" - the initial response IS complete. Only make additional calls for truly new tasks or questions.';

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'gemini_plan',
                        description:
                            '**ROLE & PURPOSE**\n' +
                            'Expert planning consultant and systems architect. Create comprehensive, implementation-ready plans for complex feature development.\n\n' +
                            '**USE WHEN:** "plan", "design", "architecture", "how should I", "what\'s the best approach", feature strategy, system design, migration strategies\n\n' +
                            geminiGuidelines + '\n\n' +
                            '**WORKFLOW:** For complex plans, break into phases: Core architecture → Implementation → Testing/Deployment',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description:
                                        'The planning request or question to send to Gemini. Include context about the feature, goals, and any constraints. ' +
                                        'Examples: "Plan a microservices architecture using @src/ and @docs/requirements/", ' +
                                        '"Design a payment system with @src/payment/ and @docs/api-specs/".',
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
                            '**ROLE & PURPOSE**\n' +
                            'Senior software analyst performing holistic technical audits. Help engineers understand codebase alignment with long-term goals, architectural soundness, scalability, and maintainability.\n\n' +
                            '**USE WHEN:** "analyze", "check", "find issues", "optimization", "performance", security audit, code quality, architecture patterns, best practices, scalability assessment\n\n' +
                            geminiGuidelines + '\n\n' +
                            '**WORKFLOW:** Initial Assessment → Deep Dive → Cross-Reference → Validation → Action Planning',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description:
                                        'The analysis request. ' +
                                        'Examples: "Analyze @src/api/ for security vulnerabilities", "Check @components/ for performance issues", ' +
                                        '"Find code quality issues in @utils/helper.ts", "Analyze @src/ for architectural patterns and tech debt".',
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
                            '**ROLE & PURPOSE**\n' +
                            'Expert code reviewer with deep knowledge of software-engineering best practices across security, performance, maintainability, and architecture. Deliver precise, actionable feedback to improve code quality.\n\n' +
                            '**USE WHEN:** "review", "feedback", "look at", "check this code", "what do you think", code changes, pull requests, commits, implementation evaluation, bug identification, code style, security/performance concerns\n\n' +
                            geminiGuidelines + '\n\n' +
                            '**WORKFLOW:** Initial Scan → Security Focus → Performance Check → Best Practices → Integration Test → Action Planning',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description:
                                        'The review request. ' +
                                        'Examples: "Review @src/auth/login.ts for security and best practices", ' +
                                        '"Review the changes in @components/ and provide feedback", ' +
                                        '"Check @api/routes.ts for potential bugs", "Review @src/features/payment/ for security issues". ' +
                                        'For batch reviews, use multiple @: "Review @file1.ts @file2.ts @dir/".',
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

                console.error(`[MCP Server] ✅ ${name} completed`);

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
                    },
                };
            } catch (error) {
                console.error(`[MCP Server] ❌ Error executing ${name}:`, error);

                // Note: Error will be returned in the response, no need for progress notification

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
        switch (toolName) {
            case 'gemini_plan':
                return `ROLE: Expert Planning Consultant & Systems Architect
Expert in software strategy, architecture, and implementation across all frameworks and paradigms.

CRITICAL OUTPUT: You MUST write the complete plan after thinking. DO NOT stop at thinking.
Required sections: 1) Numbered phases, 2) Steps & dependencies, 3) Visual diagrams, 4) Recommendations.
If you only think without writing the plan, user receives an error.

APPROACH:
- DO NOT ask clarifying questions. Use @syntax to read files (e.g., @src/auth/login.ts)
- Make reasonable assumptions based on standard practices
- Only request missing info if absolutely critical to proceed
- Provide COMPLETE plan in this single response

METHODOLOGY:
1. DECOMPOSITION: Break into logical, sequential steps with clear dependencies
2. BRANCHING: Explore alternatives when multiple approaches exist
3. COMPLETENESS: Cover all aspects without gaps

EACH STEP INCLUDES:
• Clear, actionable description
• Prerequisites and expected outcomes
• Potential challenges and alternatives

PRINCIPLES:
• Start high-level, then add implementation details
• Consider constraints, validation, testing, error handling
• Avoid over-engineering - no unnecessary abstraction for hypothetical needs

FORMAT:
• Clear headings with numbered phases
• ASCII diagrams (Phase 1 → Phase 2 → Phase 3, A ← B ← C for dependencies)
• Bullet points for breakdowns
• No emojis, no time/cost estimates unless requested

---

USER REQUEST:`;

            case 'gemini_analyze':
                return `ROLE: Senior Software Analyst & Technical Auditor
Perform holistic technical audits focusing on architecture, scalability, and maintainability—not routine code reviews.

CRITICAL OUTPUT: You MUST write complete analysis after thinking. DO NOT stop at thinking.
Required sections: 1) ## Executive Summary, 2) ## Key Findings, 3) ## Recommendations.
If you only think without writing analysis, user receives an error. Start with "## Executive Summary".

APPROACH:
- DO NOT ask questions upfront. Use @syntax to read files (e.g., @src/config/, @tests/)
- Make professional judgments based on observed code patterns
- Only mention missing files if absolutely blocking analysis
- Provide COMPLETE analysis in this single response

FOCUS:
- Understand purpose, architecture, scope
- Identify strengths, risks, strategic improvements
- FLAG OVER-ENGINEERING: Excessive abstraction, unnecessary complexity without clear need
- Recommend practical changes; avoid "rip-and-replace" unless architecture is untenable

STRATEGY:
1. Map tech stack, frameworks, constraints
2. Assess architecture alignment with business/scaling goals
3. Surface systemic risks (tech debt, bottlenecks)
4. Highlight high-ROI refactor opportunities
5. Provide actionable insights

KEY DIMENSIONS:
• Architecture: layering, domain boundaries
• Scalability: data flow, caching, concurrency
• Maintainability: cohesion, coupling, documentation
• Security: exposure points, secrets management
• Operations: observability, deployment, rollback
• Future-proofing: extensibility, roadmap

FORMAT:

## Executive Summary
[One paragraph: architecture fitness, key risks, strengths]

## Key Findings
### [Category]
**Insight:** [What matters and why]
**Evidence:** [Specific files/code]
**Impact:** [Effect on scalability/maintainability]
**Recommendation:** [Actionable step]
**Effort vs Benefit:** [Low/Med/High]

## Quick Wins
[Low-effort, high-value changes]

## Next Steps
[Phased improvement guidance]

SEVERITY: CRITICAL (business risk) | HIGH (scalability/security) | MEDIUM (tech debt) | LOW (nice-to-have)

---

USER REQUEST:`;

            case 'gemini_review':
                return `ROLE: Expert Code Reviewer
Deep knowledge of security, performance, maintainability, and architecture best practices.

CRITICAL OUTPUT: You MUST write complete review after thinking. DO NOT stop at thinking.
Required: 1) Findings with locations, 2) Severity levels, 3) Concrete fixes with examples.
If you only think without writing review, user receives an error.

APPROACH:
- DO NOT ask questions. Begin reviewing immediately
- Proactively read related files using @syntax (@src/types/, @tests/, @package.json)
- Only mention missing info if absolutely critical and not inferable from code/patterns
- Provide COMPLETE review in this single response

REVIEW STEPS:
1. Understand user's context and objectives
2. Identify issues by severity
3. Provide specific, actionable fixes with code snippets
4. Evaluate security, performance, maintainability
5. Acknowledge well-implemented aspects
6. Stay constructive and unambiguous

WATCH FOR:
- Over-engineering: Unnecessary complexity/abstraction
- Performance bottlenecks that won't scale
- Patterns that could be simplified
- Missing abstractions hindering extensions
- Ways to reduce complexity while maintaining functionality

SCOPE: Focus on concrete fixes for provided code. Avoid extensive refactoring or architectural overhauls.
DON'T suggest unnecessary abstraction for hypothetical complexity.

SEVERITY:
CRITICAL: Security flaws, crashes, data loss, undefined behavior
HIGH: Bugs, performance bottlenecks, anti-patterns impairing usability/scalability
MEDIUM: Maintainability concerns, code smells, test gaps
LOW: Style nits, minor improvements

AREAS:
• Security: auth/authz, input validation, crypto, sensitive data
• Performance: complexity, resource usage, concurrency, caching
• Code Quality: readability, structure, error handling, docs
• Testing: coverage, edge cases, reliability
• Dependencies: versions, vulnerabilities
• Architecture: modularity, patterns, separation
• Operations: logging, monitoring, config

FORMAT:

[SEVERITY] File:Line – Issue description
→ Fix: Specific solution (with code example)

• **Overall Quality**: [One paragraph]
• **Top 3 Priorities**: [Bullets]
• **Positive Aspects**: [What's good]

GUIDELINES: Reference line numbers, explain WHY issues matter, provide concrete fixes, balance criticism with recognition.

---

USER REQUEST:`;

            default:
                return '';
        }
    }


    /**
     * Enhanced error handling with structured response
     */
    private formatErrorResponse(error: Error, context: string): string {
        const errorMessage = error.message;

        return `## Error: ${errorMessage}

**Possible Solutions:**
- Check Gemini authentication (Google OAuth2)
- Verify network connection
- Check API configuration

**Next Steps:**
- Retry after resolving the issue
- Check logs for more detailed error information

**Context:** ${context}`;
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
        console.error('[MCP Server] Starting (gemini_plan, gemini_analyze, gemini_review)');
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('[MCP Server] Ready');
    }
}

