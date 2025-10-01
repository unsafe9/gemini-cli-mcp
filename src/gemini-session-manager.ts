import { Config, AuthType, DEFAULT_GEMINI_MODEL, GeminiEventType, CompressionStatus } from '@google/gemini-cli-core';
import type { GeminiClient } from '@google/gemini-cli-core';
import { FinishReason, type Content } from '@google/genai';

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
                skipNextSpeakerCheck: false,  // Enable next speaker check for continuation
                interactive: false,           // Non-interactive mode for MCP server
                useRipgrep: true,            // Use ripgrep for faster file searching
                enableToolOutputTruncation: true,  // Prevent excessive tool output
                truncateToolOutputThreshold: 100000,  // 100KB limit
                truncateToolOutputLines: 2000,        // 2000 lines limit
                //chatCompression: {
                //    contextPercentageThreshold: 0.8
                //},
                //maxSessionTurns: 50,
                fileFiltering: {
                    respectGitIgnore: true,
                    respectGeminiIgnore: true,
                    enableRecursiveFileSearch: true,
                    disableFuzzySearch: false
                }
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
            await this.client.initialize();  // Ensure client is fully initialized
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

        const startTime = Date.now();
        const abortSignal = AbortSignal.timeout(timeoutMs);
        const maxContinuations = 3;
        const promptId = `prompt-${Date.now()}`;
        let accumulatedResponse = '';

        if (this.sessionState) {
            this.sessionState.lastActivity = new Date();
        }

        /*
         * Defense mechanism: While GeminiClient internally handles checkNextSpeaker,
         * occasionally the first request may not yield a response. This retry logic
         * at the session manager level provides an additional safety net.
         */
        for (let attempt = 0; attempt <= maxContinuations; attempt++) {
            if (attempt > 0) {
                onProgress?.(`No content received, requesting continuation (${attempt}/${maxContinuations})...`);
                prompt = 'Continue.';
            }

            try {
                const stream = this.client!.sendMessageStream(
                    [{ text: prompt }],
                    abortSignal,
                    promptId,
                    100
                );

                for await (const event of stream) {

                    switch (event.type) {
                        case GeminiEventType.Retry:
                            onProgress?.('Retrying...');
                            break;

                        case GeminiEventType.Content:
                            if (event.value?.length) {
                                accumulatedResponse += event.value;
                            }
                            onProgress?.(`Responding... (${accumulatedResponse.length} chars)`);
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
                            } else if (reason && reason !== FinishReason.STOP) {
                                onProgress?.(`Finished: ${reason}`);
                            } else {
                                onProgress?.('Finished');
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

                                if (compressionStatus === CompressionStatus.COMPRESSED) {
                                    onProgress?.(`Chat compressed: ${originalTokenCount} → ${newTokenCount} tokens (${percent}% saved)`);
                                } else if (compressionStatus === CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT) {
                                    onProgress?.(`Chat compression failed: would increase tokens`);
                                } else if (compressionStatus === CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR) {
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

                // Accumulate content from this attempt
                if (accumulatedResponse.length > 0) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    onProgress?.(`Complete (${accumulatedResponse.length} chars, ${elapsed}s)`);

                    // Clean up pending state on success
                    const resolve = this._pendingResolve;
                    this._pendingResolve = null;
                    this._pending = null;
                    if (resolve) resolve();

                    return accumulatedResponse;
                }

                // No content received in this attempt

                if (attempt < maxContinuations) {
                    console.error(`[GeminiSessionManager] Attempt ${attempt + 1}: No content, will retry`);
                }

            } catch (error) {
                console.error('[GeminiSessionManager] Error:', error);

                // Handle AbortError as timeout
                if (error instanceof Error && error.name === 'AbortError') {
                    const elapsed = Date.now() - startTime;
                    throw new Error(`Stream timeout after ${elapsed}ms`);
                }

                throw error;
            }
        }

        // All attempts exhausted with no content
        /*
         * TROUBLESHOOTING: No Content Events
         * 
         * Check these Config values:
         * - skipNextSpeakerCheck: should be false (enables "Please continue" auto-requests)
         * - quotaErrorOccurred: should be false (API quota not exceeded)
         * - maxSessionTurns: should be > current turn count (session not expired)
         * - pendingToolCalls.length: should be 0 (no tools waiting for response)
         * - signal.aborted: should be false (request not cancelled)
         * - finishReason: should be STOP (normal completion)
         */

        console.error('[GeminiSessionManager] All continuation attempts exhausted, no content received');
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        onProgress?.(`Complete (no content after ${maxContinuations} retries, ${elapsed}s)`);

        // Clean up pending state
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        this._pending = null;
        if (resolve) resolve();

        return accumulatedResponse;
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
