import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const questionSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			header: Type.Optional(Type.String({ description: "Very short label for the question (max 30 characters)" })),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Display text for the option" }),
						description: Type.Optional(Type.String({ description: "Explanation of the choice" })),
					}),
					{ description: "Available choices (omit for free-text input)" },
				),
			),
			multiple: Type.Optional(
				Type.Boolean({
					description: "Allow selecting multiple choices (default: false)",
				}),
			),
		}),
		{
			description:
				"Questions to ask the user. For each question, provide the question text and optional options. When options are provided, the user selects from them; otherwise free-text input is used.",
			minItems: 1,
		},
	),
});

export type QuestionToolInput = Static<typeof questionSchema>;

function formatQuestionAnswers(questions: QuestionToolInput["questions"], answers: string[][]): string {
	const formatted = questions
		.map(
			(q: { question: string }, i: number) =>
				`"${q.question}" = "${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`,
		)
		.join(", ");
	return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

export function createQuestionToolDefinition(
	_cwd: string,
	_options?: Record<string, never>,
): ToolDefinition<typeof questionSchema, undefined> {
	return {
		name: "question",
		label: "question",
		description: `Use this tool when you need to ask the user questions during execution.
This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer choices to the user about direction to take

When options are provided for a question, the user selects from them. Otherwise free-text input is used.
Answers are returned as arrays of labels. Set multiple: true to allow selecting more than one option.

NOTE: This tool requires an interactive UI (TUI mode) to work. In non-interactive modes, it will fail.`,
		promptSnippet: "Ask the user questions",
		promptGuidelines: [
			"Use the question tool to ask the user for clarification when instructions are ambiguous.",
			"When recommending an option, make it the first option and add '(Recommended)' to its label.",
		],
		parameters: questionSchema,
		async execute(
			_toolCallId,
			params: QuestionToolInput,
			signal: AbortSignal | undefined,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			if (!ctx?.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Cannot ask questions in non-interactive mode. Please rephrase your request or use the interactive TUI mode.",
						},
					],
					details: undefined,
				};
			}

			const answers: string[][] = [];

			for (const q of params.questions) {
				if (signal?.aborted) throw new Error("Operation aborted");

				if (q.options && q.options.length > 0) {
					const choices = q.options.map((opt: { label: string; description?: string }) =>
						opt.description ? `${opt.label} - ${opt.description}` : opt.label,
					);

					if (q.multiple) {
						const selected: string[] = [];
						const remaining = [...choices];
						while (remaining.length > 0) {
							const pick = await ctx.ui.select(
								`${q.question} (selected: ${selected.length})`,
								["[done]", ...remaining],
								{ signal },
							);
							if (!pick || pick === "[done]") break;
							selected.push(pick);
							const idx = remaining.indexOf(pick);
							if (idx >= 0) remaining.splice(idx, 1);
						}
						answers.push(selected);
					} else {
						const answer = await ctx.ui.select(q.question, choices, { signal });
						answers.push(answer ? [answer] : []);
					}
				} else {
					const answer = await ctx.ui.input(q.question, q.header, { signal });
					answers.push(answer ? [answer] : []);
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: formatQuestionAnswers(params.questions, answers),
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const count = (args as QuestionToolInput)?.questions?.length ?? 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("question")) +
					theme.fg("toolOutput", ` asking ${count} question${count !== 1 ? "s" : ""}`),
				0,
				0,
			);
		},
	};
}

export function createQuestionTool(cwd: string, _options?: Record<string, never>): AgentTool<typeof questionSchema> {
	return wrapToolDefinition(createQuestionToolDefinition(cwd, _options));
}
