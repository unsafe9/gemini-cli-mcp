#!/usr/bin/env node

import { MCPServer, GeminiSessionFactory } from './mcp-server.js';
import { GeminiSessionManager } from './gemini-session-manager.js';

/**
 * MCP Server entry point
 * Starts the MCP server that exposes Gemini capabilities via gemini-cli-core
 */
async function main() {
    try {
        // Get configuration from environment variables
        const model = process.env.AGENT_MODEL || 'gemini-2.5-flash';

        // Create Gemini session factory
        const sessionFactory: GeminiSessionFactory = (projectPath: string, sessionId: string) => {
            return new GeminiSessionManager(projectPath, model, sessionId);
        };

        // Create MCP server
        const server = new MCPServer(sessionFactory, 'gemini-cli', '1.0.0');

        await server.start();

        // Keep the process running
        process.stdin.resume();
    } catch (error) {
        console.error('[Main] Fatal error during startup:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
});
