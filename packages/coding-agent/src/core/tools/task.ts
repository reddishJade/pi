import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	convertToLlm,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import { createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition } from "./edit.ts";
import { createFindToolDefinition } from "./find.ts";
import { createGrepToolDefinition } from "./grep.ts";
import { createLsToolDefinition } from "./ls.ts";
import { createReadToolDefinition } from "./read.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWebFetchToolDefinition } from "./webfetch.ts";
import { createWebSearchToolDefinition } from "./websearch.ts";
import { createWriteToolDefinition } from "./write.ts";

const taskSchema = Type.Object({
	description: Type.String({ description: "A short (3-5 words) description of the task" }),
	prompt: Type.String({ description: "The task for the subagent to perform" }),
	subagent_type: Type.Optional(
		Type.Union([Type.Literal("coding"), Type.Literal("research"), Type.Literal("default")], {
			description: "The type of subagent to use (default: 'coding')",
		}),
	),
});

export type TaskToolInput = Static<typeof taskSchema>;

export type TaskToolOptions = Record<string, never>;

export interface TaskToolDetails {
	progressLog: string[];
	toolCallCount: number;
	erroredToolCount: number;
	completed: boolean;
	assistantError?: string;
	childSessionFile?: string;
}

const SUBAGENT_PROMPTS: Record<string, string> = {
	coding: `You are an expert software engineer with full file system access. Your job is to complete the assigned task using the available tools.

- Use read/grep/find/ls to explore the codebase before making changes.
- Use bash to run tests, linters, or build commands when needed.
- Use edit/write to make changes.
- Prefer small, focused changes and verify them with tests or shell commands.
- Return a concise summary of what you did and any important notes.`,
	research: `You are a thorough research assistant with file system and web access. Your job is to investigate the assigned topic and provide a detailed, evidence-based answer.

- Use read/grep/find/ls to inspect local files.
- Use websearch/webfetch to gather current external information.
- Cite sources and files when possible.
- Return a structured summary of your findings.`,
	default: `You are a helpful AI assistant with file system access. Complete the assigned task efficiently using the available tools and return a concise summary.`,
};

interface AssistantResult {
	text: string;
	error?: string;
}

function extractAssistantResult(message: AgentMessage | undefined): AssistantResult {
	if (!message || message.role !== "assistant") {
		return { text: "" };
	}
	const text = message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return { text, error: message.errorMessage };
	}
	return { text };
}

function createSubagentTools(cwd: string): AgentTool<any>[] {
	return [
		wrapToolDefinition(createReadToolDefinition(cwd)),
		wrapToolDefinition(createBashToolDefinition(cwd)),
		wrapToolDefinition(createEditToolDefinition(cwd)),
		wrapToolDefinition(createWriteToolDefinition(cwd)),
		wrapToolDefinition(createGrepToolDefinition(cwd)),
		wrapToolDefinition(createFindToolDefinition(cwd)),
		wrapToolDefinition(createLsToolDefinition(cwd)),
		wrapToolDefinition(createWebSearchToolDefinition(cwd)),
		wrapToolDefinition(createWebFetchToolDefinition(cwd)),
	];
}

function persistChildSession(ctx: ExtensionContext, subagent: Agent): string | undefined {
	try {
		const parentFile = ctx.sessionManager.getSessionFile();
		const childMgr = SessionManager.create(
			ctx.cwd,
			ctx.sessionManager.getSessionDir(),
			parentFile ? { parentSession: parentFile } : undefined,
		);
		for (const msg of convertToLlm(subagent.state.messages)) {
			childMgr.appendMessage(msg);
		}
		return childMgr.getSessionFile();
	} catch {
		return undefined;
	}
}

function buildDetails(
	progressLog: string[],
	toolCallCount: number,
	erroredToolCount: number,
	completed: boolean,
): TaskToolDetails {
	return { progressLog, toolCallCount, erroredToolCount, completed };
}

function buildErrorDetails(progressLog: string[], assistantError: string): TaskToolDetails {
	return { progressLog, toolCallCount: 0, erroredToolCount: 0, completed: true, assistantError };
}

function makeStatusLine(details: TaskToolDetails): string {
	const latest = details.progressLog[details.progressLog.length - 1];
	if (!details.completed) {
		return latest ? `running: ${latest}` : "running...";
	}
	if (details.assistantError) {
		return `failed: ${details.assistantError}`;
	}
	if (details.erroredToolCount > 0) {
		return `done with ${details.erroredToolCount} tool error${details.erroredToolCount > 1 ? "s" : ""}`;
	}
	return `done${details.toolCallCount > 0 ? ` (${details.toolCallCount} tools)` : ""}`;
}

export function createTaskToolDefinition(
	cwd: string,
	_options?: Record<string, never>,
): ToolDefinition<typeof taskSchema, TaskToolDetails> {
	return {
		name: "task",
		label: "task",
		description: `Launch a subagent to perform a self-contained task. The subagent runs independently with file system and web access (read, bash, grep, edit, write, find, ls, websearch, webfetch tools).

Available subagent types:
- coding: Expert software engineer (default)
- research: Thorough research assistant with web access
- default: General-purpose assistant

Use for delegating well-defined sub-tasks. The subagent does not inherit the parent conversation context; include all necessary details in the prompt.`,
		promptSnippet: "Delegate tasks to a subagent with full tool access",
		promptGuidelines: [
			"Use task for well-defined sub-tasks that need file system or web access.",
			"The subagent runs independently and returns text results; include all needed context in the prompt.",
		],
		parameters: taskSchema,
		async execute(
			_toolCallId,
			params: TaskToolInput,
			signal: AbortSignal | undefined,
			onUpdate,
			ctx: ExtensionContext,
		) {
			const model = ctx.model;
			if (!model) {
				return {
					content: [{ type: "text" as const, text: "No model available for subagent." }],
					details: buildErrorDetails([], "no model"),
				};
			}

			const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!resolved.ok) {
				return {
					content: [{ type: "text" as const, text: `Subagent auth error: ${resolved.error}` }],
					details: buildErrorDetails([], `auth error: ${resolved.error}`),
				};
			}

			const subagentType = params.subagent_type ?? "coding";

			const streamFn: StreamFn = (mdl, context, options) =>
				streamSimple(mdl, context, {
					...options,
					signal: options?.signal ?? signal,
					...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
					headers: { ...mdl.headers, ...resolved.headers } as Record<string, string>,
				});

			const subagent = new Agent({
				initialState: {
					model,
					systemPrompt: SUBAGENT_PROMPTS[subagentType] ?? SUBAGENT_PROMPTS.default,
					tools: createSubagentTools(cwd),
					thinkingLevel: "off",
				},
				streamFn,
			});

			const onParentAbort = signal ? () => subagent.abort() : undefined;
			if (onParentAbort) {
				signal!.addEventListener("abort", onParentAbort, { once: true });
			}

			const progressLog: string[] = [];
			let toolCallCount = 0;
			let erroredToolCount = 0;

			function pushProgress(line: string): void {
				progressLog.push(line);
				if (progressLog.length > 50) {
					progressLog.splice(0, progressLog.length - 50);
				}
				onUpdate?.({
					content: [{ type: "text" as const, text: progressLog.join("\n") }],
					details: buildDetails(progressLog, toolCallCount, erroredToolCount, false),
				});
			}

			const unsubscribe = subagent.subscribe((event: AgentEvent) => {
				switch (event.type) {
					case "turn_start":
						pushProgress("thinking...");
						break;
					case "tool_execution_start":
						pushProgress(`→ ${event.toolName}`);
						break;
					case "tool_execution_end": {
						toolCallCount++;
						if (event.isError) {
							erroredToolCount++;
						}
						const status = event.isError ? "✗" : "✓";
						pushProgress(`${status} ${event.toolName}`);
						break;
					}
					case "agent_end":
						pushProgress("done");
						break;
				}
			});

			let childSessionFile: string | undefined;
			try {
				await subagent.prompt(params.prompt);
				await subagent.waitForIdle();

				childSessionFile = persistChildSession(ctx, subagent);

				const messages = subagent.state.messages;
				const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
				const result = extractAssistantResult(lastAssistant);
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Subagent failed: ${result.error}` }],
						details: { ...buildErrorDetails(progressLog, result.error), childSessionFile },
					};
				}
				return {
					content: [{ type: "text" as const, text: result.text || "(no output)" }],
					details: { ...buildDetails(progressLog, toolCallCount, erroredToolCount, true), childSessionFile },
				};
			} catch (err) {
				childSessionFile = persistChildSession(ctx, subagent);
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Subagent failed: ${message}` }],
					details: { ...buildErrorDetails(progressLog, message), childSessionFile },
				};
			} finally {
				unsubscribe();
				if (onParentAbort && signal) {
					signal.removeEventListener("abort", onParentAbort);
				}
			}
		},
		renderCall(args, theme) {
			const a = args as TaskToolInput;
			return new Text(
				theme.fg("toolTitle", theme.bold("task")) +
					theme.fg("toolOutput", ` [${a?.subagent_type ?? "coding"}] ${a?.description ?? ""}`),
				0,
				0,
			);
		},
		renderResult(result, options: ToolRenderResultOptions, theme) {
			const details = result.details;
			const output = getTextOutput(result, true);

			if (options.expanded) {
				let text = "";
				if (details) {
					text += theme.fg("muted", makeStatusLine(details)) + "\n";
					if (details.childSessionFile) {
						text += theme.fg("muted", `session: ${details.childSessionFile}`) + "\n";
					}
				}
				if (output) {
					text += theme.fg("toolOutput", output);
				}
				return text ? new Text(text, 0, 0) : new Container();
			}

			// Collapsed: one-line status summary.
			const status = details ? makeStatusLine(details) : output ? `done (${output.split("\n").length} lines)` : "";
			if (!status) {
				return new Container();
			}
			return new Text(theme.fg("muted", `${status} (${keyText("app.tools.expand")} to expand)`), 0, 0);
		},
	};
}

export function createTaskTool(
	cwd: string,
	_options?: Record<string, never>,
): AgentTool<typeof taskSchema, TaskToolDetails> {
	return wrapToolDefinition(createTaskToolDefinition(cwd, _options));
}
