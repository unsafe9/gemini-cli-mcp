import { Config, AuthType, DEFAULT_GEMINI_MODEL, GeminiEventType } from '@google/gemini-cli-core';
import type { GeminiClient } from '@google/gemini-cli-core';
import type { Content } from '@google/genai';

export interface SessionState {
    id: string;
    createdAt: Date;
    lastActivity: Date;
    isActive: boolean;
}

export type ProgressCallback = (message: string) => void;

export class GeminiSessionManager {
    private config: Config | null = null;
    private client: GeminiClient | null = null;
    private sessionState: SessionState | null = null;
    private readonly projectRoot: string;
    private readonly model: string;
    private readonly sessionId: string;
    private _pending: Promise<void> | null = null;
    private _pendingResolve: (() => void) | null = null;

    constructor(
        projectRoot: string,
        model: string = DEFAULT_GEMINI_MODEL,
        sessionId?: string
    ) {
        this.projectRoot = projectRoot;
        this.model = model;
        this.sessionId = sessionId || `session-${Date.now()}`;
    }

    /**
     * Determines authentication type from environment variables.
     * Compatible with official Gemini CLI environment variable handling.
     */
    private getAuthTypeFromEnv(): AuthType | undefined {
        if (process.env['GOOGLE_GENAI_USE_GCA'] === 'true') {
            return AuthType.LOGIN_WITH_GOOGLE;
        }
        if (process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
            return AuthType.USE_VERTEX_AI;
        }
        if (process.env['GEMINI_API_KEY']) {
            return AuthType.USE_GEMINI;
        }
        return undefined;
    }

    async start(systemInstruction?: string): Promise<void> {
        if (this.isActive()) {
            console.error('[GeminiSessionManager] Already started');
            return;
        }

        console.error(`[GeminiSessionManager] Starting session: ${this.sessionId} (${this.model})`);

        try {
            this.config = new Config({
                targetDir: this.projectRoot,
                cwd: this.projectRoot,
                model: this.model,
                sessionId: this.sessionId,
                debugMode: false,
            });

            await this.config!.initialize();

            const authType = this.getAuthTypeFromEnv();
            if (!authType) {
                console.error('[GeminiSessionManager] No auth environment variables found, using OAuth');
                await this.config!.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
            } else {
                console.error(`[GeminiSessionManager] Using auth type: ${authType}`);
                await this.config!.refreshAuth(authType);
            }

            this.client = this.config.getGeminiClient();
            await this.client.startChat();
            await this.client.setTools();

            if (systemInstruction) {
                this.setSystemInstruction(systemInstruction);
            }

            this.sessionState = {
                id: this.sessionId,
                createdAt: new Date(),
                lastActivity: new Date(),
                isActive: true,
            };

            console.error('[GeminiSessionManager] Session started successfully');
        } catch (error) {
            console.error('[GeminiSessionManager] Failed to start session:', error);
            this.cleanup();
            throw error;
        }
    }

    setSystemInstruction(instruction: string): void {
        if (!this.client) {
            throw new Error('Session not started');
        }
        this.client.getChat().setSystemInstruction(instruction);
    }

    async sendPrompt(
        prompt: string,
        timeoutMs: number = 6000000,
        onProgress?: ProgressCallback
    ): Promise<string> {
        if (!this.isActive()) {
            throw new Error('Session not active');
        }

        if (this._pending) {
            await this._pending.catch(() => { });
        }
        this._pending = new Promise<void>((resolve) => { this._pendingResolve = resolve; });

        let accumulatedResponse = '';
        const startTime = Date.now();

        try {
            if (this.sessionState) {
                this.sessionState.lastActivity = new Date();
            }

            const stream = this.client!.sendMessageStream(
                [{ text: prompt }],
                new AbortController().signal,
                `prompt-${Date.now()}`,
                100
            );

            for await (const event of stream) {
                const elapsed = Date.now() - startTime;
                if (elapsed > timeoutMs) {
                    throw new Error(`Stream timeout after ${elapsed}ms`);
                }

                switch (event.type) {
                    case GeminiEventType.Retry:
                        onProgress?.('Retrying...');
                        break;

                    case GeminiEventType.Content:
                        accumulatedResponse += event.value;
                        if (accumulatedResponse.length > 0) {
                            onProgress?.(`Responding... (${accumulatedResponse.length} chars)`);
                        }
                        break;

                    case GeminiEventType.Thought:
                        const subject = event.value.subject;
                        const description = event.value.description;
                        if (description) {
                            onProgress?.(`Thinking: ${subject} - ${description.substring(0, 50)}...`);
                        } else {
                            onProgress?.(`Thinking: ${subject || 'Processing...'}`);
                        }
                        break;

                    case GeminiEventType.ToolCallRequest:
                        const toolName = event.value.name;
                        const args = event.value.args;
                        const argKeys = Object.keys(args);
                        if (argKeys.length > 0) {
                            const firstArg = argKeys[0];
                            const firstValue = args[firstArg];
                            if (typeof firstValue === 'string' && firstValue.length < 50) {
                                onProgress?.(`Using tool: ${toolName}(${firstArg}: "${firstValue}")`);
                            } else {
                                onProgress?.(`Using tool: ${toolName}(${argKeys.length} args)`);
                            }
                        } else {
                            onProgress?.(`Using tool: ${toolName}()`);
                        }
                        break;

                    case GeminiEventType.ToolCallResponse:
                        if (event.value.error) {
                            const errorMsg = event.value.error.message;
                            const errorType = event.value.errorType;
                            if (errorType) {
                                onProgress?.(`Tool failed (${errorType}): ${errorMsg}`);
                            } else {
                                onProgress?.(`Tool failed: ${errorMsg}`);
                            }
                        } else if (event.value.outputFile) {
                            onProgress?.(`Tool completed: wrote to ${event.value.outputFile}`);
                        } else if (event.value.contentLength !== undefined) {
                            onProgress?.(`Tool completed (${event.value.contentLength} bytes)`);
                        } else {
                            onProgress?.(`Tool completed`);
                        }
                        break;

                    case GeminiEventType.ToolCallConfirmation:
                        const confirmToolName = event.value.request.name;
                        const confirmArgs = event.value.request.args;
                        if (confirmArgs && Object.keys(confirmArgs).length > 0) {
                            onProgress?.(`Confirming tool: ${confirmToolName} with ${Object.keys(confirmArgs).length} args`);
                        } else {
                            onProgress?.(`Confirming tool: ${confirmToolName}`);
                        }
                        break;

                    case GeminiEventType.Finished:
                        const reason = event.value.reason;
                        const usageMetadata = event.value.usageMetadata;
                        if (usageMetadata) {
                            const promptTokens = usageMetadata.promptTokenCount;
                            const totalTokens = usageMetadata.totalTokenCount;
                            if (totalTokens && promptTokens) {
                                onProgress?.(`Finished (${promptTokens} prompt + ${totalTokens - promptTokens} response tokens)`);
                            }
                        } else if (reason && reason !== 'STOP') {
                            onProgress?.(`Finished: ${reason}`);
                        }
                        break;

                    case GeminiEventType.Error:
                        const errorMsg = event.value.error.message;
                        const status = event.value.error.status;
                        if (status) {
                            throw new Error(`API Error ${status}: ${errorMsg}`);
                        } else {
                            throw new Error(errorMsg);
                        }

                    case GeminiEventType.ChatCompressed:
                        if (event.value) {
                            const { originalTokenCount, newTokenCount, compressionStatus } = event.value;
                            const saved = originalTokenCount - newTokenCount;
                            const percent = Math.round((saved / originalTokenCount) * 100);

                            if (compressionStatus === 1) { // COMPRESSED
                                onProgress?.(`Chat compressed: ${originalTokenCount} → ${newTokenCount} tokens (${percent}% saved)`);
                            } else if (compressionStatus === 2) { // FAILED_INFLATED
                                onProgress?.(`Chat compression failed: would increase tokens`);
                            } else if (compressionStatus === 3) { // FAILED_ERROR
                                onProgress?.(`Chat compression failed: token count error`);
                            }
                        }
                        break;

                    case GeminiEventType.LoopDetected:
                        onProgress?.('Loop detected - stopping to prevent infinite cycle');
                        break;

                    case GeminiEventType.MaxSessionTurns:
                        onProgress?.('Max session turns reached - please start a new session');
                        break;

                    case GeminiEventType.UserCancelled:
                        onProgress?.('Cancelled by user');
                        throw new Error('User cancelled');

                    case GeminiEventType.Citation:
                        const citations = event.value;
                        if (citations) {
                            const citationLines = citations.split('\n').filter(line => line.trim());
                            onProgress?.(`Found ${citationLines.length - 1} citations`);
                        }
                        break;
                }
            }

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            onProgress?.(`Complete (${accumulatedResponse.length} chars, ${elapsed}s)`);

            return accumulatedResponse;

        } catch (error) {
            console.error('[GeminiSessionManager] Error:', error);
            throw error;
        } finally {
            const resolve = this._pendingResolve;
            this._pendingResolve = null;
            this._pending = null;
            if (resolve) resolve();
        }
    }

    async stop(): Promise<void> {
        this.cleanup();
    }

    isActive(): boolean {
        return (
            this.config !== null &&
            this.client !== null &&
            this.sessionState?.isActive === true
        );
    }

    getModel(): string {
        return this.model;
    }

    getHistory(curated: boolean = false): Content[] {
        if (!this.client) {
            throw new Error('Session not started');
        }
        return this.client.getChat().getHistory(curated);
    }

    setHistory(history: Content[]): void {
        if (!this.client) {
            throw new Error('Session not started');
        }
        this.client.getChat().setHistory(history);
    }

    clearHistory(): void {
        if (!this.client) {
            throw new Error('Session not started');
        }
        this.client.getChat().clearHistory();
    }

    private cleanup(): void {
        if (this.sessionState) {
            this.sessionState.isActive = false;
        }
        this.client = null;
        this.config = null;
    }
}
