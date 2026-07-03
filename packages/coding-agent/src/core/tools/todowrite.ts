import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	priority?: "high" | "medium" | "low";
}

interface SessionTodos {
	todos: TodoItem[];
}

const todosStore = new Map<string, SessionTodos>();

function getOrCreateSessionTodos(sessionKey: string): SessionTodos {
	let todos = todosStore.get(sessionKey);
	if (!todos) {
		todos = { todos: [] };
		todosStore.set(sessionKey, todos);
	}
	return todos;
}

const todoSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "Description of the task" }),
			status: Type.Union(
				[
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
					Type.Literal("cancelled"),
				],
				{
					description: "Current status of the task",
				},
			),
			priority: Type.Optional(
				Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
					description: "Priority level of the task",
				}),
			),
		}),
		{ description: "The updated todo list. Provide the full list each time to replace the previous state." },
	),
});

export type TodoWriteToolInput = Static<typeof todoSchema>;

export interface TodoWriteToolOptions {
	/** Session key for storing todos. Defaults to cwd. */
	sessionKey?: string;
}

export function createTodoWriteToolDefinition(
	cwd: string,
	options?: TodoWriteToolOptions,
): ToolDefinition<typeof todoSchema, undefined> {
	const sessionKey = options?.sessionKey ?? cwd;
	return {
		name: "todowrite",
		label: "todowrite",
		description: `Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current.

Provide the full list of todos each time to update the entire list. The system remembers todos across tool calls within the session.`,
		promptSnippet: "Track tasks and progress",
		promptGuidelines: [
			"Use todowrite to maintain a persistent todo list during multi-step tasks.",
			"Mark items as completed when done, update priorities as needed.",
		],
		parameters: todoSchema,
		async execute(_toolCallId, params: TodoWriteToolInput, signal: AbortSignal | undefined, _onUpdate) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const store = getOrCreateSessionTodos(sessionKey);
			store.todos = params.todos;

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								todos: store.todos,
							},
							null,
							2,
						),
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const todos = (args as TodoWriteToolInput)?.todos ?? [];
			const pending = todos.filter((t: TodoItem) => t.status === "pending" || t.status === "in_progress").length;
			const done = todos.filter((t: TodoItem) => t.status === "completed").length;
			return new Text(
				theme.fg("toolTitle", theme.bold("todowrite")) +
					theme.fg("toolOutput", ` ${todos.length} items (${done} done, ${pending} pending)`),
				0,
				0,
			);
		},
		renderResult(result, _options: ToolRenderResultOptions, theme) {
			const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
			let parsed: { todos?: TodoItem[] } = {};
			try {
				parsed = JSON.parse(text) as { todos?: TodoItem[] };
			} catch {
				// fall through to empty list
			}
			const todos = parsed.todos ?? [];
			const lines: string[] = [theme.fg("toolTitle", theme.bold("Todos"))];
			for (const todo of todos) {
				const icon =
					todo.status === "completed"
						? "[x]"
						: todo.status === "cancelled"
							? "[-]"
							: todo.status === "in_progress"
								? "[~]"
								: "[ ]";
				const priority = todo.priority ? ` (${todo.priority})` : "";
				lines.push(`  ${icon} ${todo.content}${priority}`);
			}
			if (todos.length === 0) {
				lines.push(theme.fg("dim", "  (no todos)"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}

export function createTodoWriteTool(cwd: string, options?: TodoWriteToolOptions): AgentTool<typeof todoSchema> {
	return wrapToolDefinition(createTodoWriteToolDefinition(cwd, options));
}
