import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import * as undici from "undici";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MCP_EXA_URL = "https://mcp.exa.ai/mcp";
const MCP_PARALLEL_URL = "https://search.parallel.ai/mcp";
const MAX_NUM_RESULTS = 20;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

const websearchSchema = Type.Object({
	query: Type.String({ description: "Web search query" }),
	numResults: Type.Optional(
		Type.Integer({
			description: `Number of search results to return (default: 8, max: ${MAX_NUM_RESULTS})`,
			minimum: 1,
			maximum: MAX_NUM_RESULTS,
		}),
	),
	livecrawl: Type.Optional(
		Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
			description:
				"Live crawl mode - 'fallback': use live crawling as backup if cached unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
		}),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
			description: "Search type - 'auto': balanced search, 'fast': quick results, 'deep': comprehensive search",
		}),
	),
});

export type WebSearchToolInput = Static<typeof websearchSchema>;

export interface WebSearchToolOptions {
	exaApiKey?: string;
	parallelApiKey?: string;
	preferParallel?: boolean;
}

function selectProvider(options?: WebSearchToolOptions): "exa" | "parallel" {
	if (options?.preferParallel) return "parallel";
	if (process.env.OPENCODE_EXPERIMENTAL_PARALLEL || process.env.PARALLEL_API_KEY) return "parallel";
	if (process.env.EXA_API_KEY || options?.exaApiKey) return "exa";
	return "exa";
}

async function callExaMCP(
	params: { query: string; numResults: number; livecrawl: string; type: string },
	signal: AbortSignal | undefined,
	apiKey?: string,
): Promise<string | undefined> {
	let url = MCP_EXA_URL;
	if (apiKey) {
		const u = new URL(url);
		u.searchParams.set("exaApiKey", apiKey);
		url = u.toString();
	}

	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search_exa",
			arguments: {
				query: params.query,
				type: params.type,
				numResults: params.numResults,
				livecrawl: params.livecrawl,
			},
		},
	});

	const response = await undici.request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body,
		signal,
		headersTimeout: REQUEST_TIMEOUT_MS,
		bodyTimeout: REQUEST_TIMEOUT_MS,
	});

	const buffer = await response.body.arrayBuffer();
	const text = new TextDecoder().decode(buffer.slice(0, MAX_RESPONSE_BYTES));
	return parseMCPResponse(text);
}

async function callParallelMCP(
	params: { query: string; numResults: number; sessionID: string },
	signal: AbortSignal | undefined,
	apiKey?: string,
): Promise<string | undefined> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"User-Agent": "pi/1.0",
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const searchQueries: string[] = [params.query];

	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search",
			arguments: {
				objective: params.query,
				search_queries: searchQueries,
				session_id: params.sessionID,
			},
		},
	});

	const response = await undici.request(MCP_PARALLEL_URL, {
		method: "POST",
		headers,
		body,
		signal,
		headersTimeout: REQUEST_TIMEOUT_MS,
		bodyTimeout: REQUEST_TIMEOUT_MS,
	});

	const buffer = await response.body.arrayBuffer();
	const text = new TextDecoder().decode(buffer.slice(0, MAX_RESPONSE_BYTES));
	return parseMCPResponse(text);
}

function parseMCPResponse(body: string): string | undefined {
	const trimmed = body.trim();
	if (!trimmed) return undefined;

	try {
		const parsed = JSON.parse(trimmed);
		const content = parsed?.result?.content;
		if (Array.isArray(content)) {
			const textItem = content.find((item: any) => item?.text);
			if (textItem?.text) return textItem.text;
		}
	} catch {
		// Not direct JSON - try SSE parsing
	}

	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		try {
			const data = JSON.parse(line.slice(6));
			const content = data?.result?.content;
			if (Array.isArray(content)) {
				const textItem = content.find((item: any) => item?.text);
				if (textItem?.text) return textItem.text;
			}
		} catch {}
	}

	return undefined;
}

export function createWebSearchToolDefinition(
	cwd: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof websearchSchema, undefined> {
	return {
		name: "websearch",
		label: "websearch",
		description: `Search the web for current information. Use this for queries about recent events, information beyond knowledge cutoff, or any topic needing up-to-date data. Supports optional result count and search type ('auto', 'fast', 'deep').`,
		promptSnippet: "Search the web for current information",
		parameters: websearchSchema,
		async execute(_toolCallId, params: WebSearchToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const provider = selectProvider(options);
			const exaApiKey = options?.exaApiKey ?? process.env.EXA_API_KEY;
			const parallelApiKey = options?.parallelApiKey ?? process.env.PARALLEL_API_KEY;

			const text =
				provider === "exa"
					? await callExaMCP(
							{
								query: params.query,
								numResults: params.numResults ?? 8,
								livecrawl: params.livecrawl ?? "fallback",
								type: params.type ?? "auto",
							},
							signal,
							exaApiKey,
						)
					: await callParallelMCP(
							{
								query: params.query,
								numResults: params.numResults ?? 8,
								sessionID: cwd,
							},
							signal,
							parallelApiKey,
						);

			return {
				content: [
					{
						type: "text",
						text: text ?? "No search results found. Please try a different query.",
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const query = (args as WebSearchToolInput)?.query ?? "";
			return new Text(theme.fg("toolTitle", theme.bold("websearch")) + theme.fg("toolOutput", ` ${query}`), 0, 0);
		},
		renderResult(result, options: ToolRenderResultOptions, theme) {
			if (!options.expanded) {
				return new Container();
			}
			const output = (result.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text ?? "")
				.join("\n");
			if (!output) return new Container();
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof websearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
