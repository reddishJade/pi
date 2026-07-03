import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import * as undici from "undici";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

const webfetchSchema = Type.Object({
	url: Type.String({ description: "The HTTP or HTTPS URL to fetch content from" }),
	format: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
			description: "The format to return the content in (default: markdown)",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: `Optional timeout in seconds (max: ${MAX_TIMEOUT_SECONDS})`,
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
		}),
	),
});

export type WebFetchToolInput = Static<typeof webfetchSchema>;

export interface WebFetchToolOptions {
	userAgent?: string;
}

function acceptHeader(format: string): string {
	switch (format) {
		case "markdown":
			return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
		case "text":
			return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
		case "html":
			return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
		default:
			return "*/*";
	}
}

function extractTextFromHTML(html: string): string {
	let text = "";
	let skipDepth = 0;
	const tagStack: string[] = [];
	let inTag = false;
	let currentTag = "";

	for (let i = 0; i < html.length; i++) {
		const ch = html[i];

		if (ch === "<") {
			inTag = true;
			currentTag = "";
			continue;
		}

		if (ch === ">" && inTag) {
			inTag = false;
			const tag = currentTag.split(/\s/)[0]?.toLowerCase() ?? "";

			if (tag.startsWith("/")) {
				const closeTag = tag.slice(1);
				if (["script", "style", "noscript", "iframe", "object", "embed"].includes(closeTag)) {
					skipDepth = Math.max(0, skipDepth - 1);
				}
				if (closeTag === tagStack[tagStack.length - 1]) {
					tagStack.pop();
				}
			} else if (!tag.endsWith("/") && !tag.startsWith("!")) {
				if (["script", "style", "noscript", "iframe", "object", "embed"].includes(tag)) {
					skipDepth++;
				}
				tagStack.push(tag);
			}

			if (text.endsWith(" ") && tag === "br") {
				// preserve breaks
			} else if (["p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "th", "td"].includes(tag)) {
				if (!text.endsWith("\n")) text += "\n";
			}

			continue;
		}

		if (inTag) {
			currentTag += ch;
			continue;
		}

		if (skipDepth === 0 && ch) {
			text += ch;
		}
	}

	return text
		.replace(/\s+/g, " ")
		.replace(/\n\s+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function convertHTMLToMarkdown(html: string): string {
	// Remove script, style, noscript, iframe, object, embed
	let cleaned = html.replace(/<(script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, "");

	// Convert heading tags
	cleaned = cleaned
		.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
		.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
		.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
		.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n")
		.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n\n")
		.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n\n");

	// Convert links
	cleaned = cleaned.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

	// Convert images
	cleaned = cleaned.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, "![$2]($1)");
	cleaned = cleaned.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, "![]($1)");

	// Convert bold/italic
	cleaned = cleaned.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
	cleaned = cleaned.replace(/<b>(.*?)<\/b>/gi, "**$1**");
	cleaned = cleaned.replace(/<em>(.*?)<\/em>/gi, "*$1*");
	cleaned = cleaned.replace(/<i>(.*?)<\/i>/gi, "*$1*");

	// Convert code blocks
	cleaned = cleaned.replace(/<pre><code[^>]*>(.*?)<\/code><\/pre>/gis, "```\n$1\n```\n\n");
	cleaned = cleaned.replace(/<code>(.*?)<\/code>/gi, "`$1`");

	// Convert lists
	cleaned = cleaned.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
	cleaned = cleaned.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, "$1\n");
	cleaned = cleaned.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, "$1\n");

	// Convert horizontal rules
	cleaned = cleaned.replace(/<hr[^>]*>/gi, "---\n\n");

	// Convert paragraphs
	cleaned = cleaned.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");

	// Convert line breaks
	cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");

	// Remove remaining tags
	cleaned = cleaned.replace(/<[^>]*>/g, "");

	// Decode common HTML entities
	cleaned = cleaned
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");

	// Clean up excessive whitespace
	cleaned = cleaned.replace(/\n{4,}/g, "\n\n\n").trim();

	return cleaned;
}

function isImageMime(mime: string): boolean {
	return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet";
}

function isTextualMime(mime: string): boolean {
	return (
		!mime ||
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime.endsWith("+json") ||
		mime === "application/xml" ||
		mime.endsWith("+xml") ||
		mime === "application/javascript" ||
		mime === "application/x-javascript"
	);
}

function mimeFromContentType(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export function createWebFetchToolDefinition(
	_cwd: string,
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webfetchSchema, undefined> {
	const userAgent = options?.userAgent ?? BROWSER_UA;
	return {
		name: "webfetch",
		label: "webfetch",
		description: `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default. Use this for retrieving web page content, API responses, or documentation.`,
		promptSnippet: "Fetch content from URLs",
		parameters: webfetchSchema,
		async execute(_toolCallId, params: WebFetchToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const url = new URL(params.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error("URL must use http:// or https://");
			}

			const format = params.format ?? "markdown";
			const timeout = (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

			const response = await undici.request(url.toString(), {
				method: "GET",
				headers: {
					"User-Agent": userAgent,
					Accept: acceptHeader(format),
					"Accept-Language": "en-US,en;q=0.9",
				},
				signal,
				headersTimeout: timeout,
				bodyTimeout: timeout,
			});

			const contentType = String(response.headers["content-type"] ?? "");
			const mime = mimeFromContentType(contentType);

			if (isImageMime(mime)) {
				throw new Error(`Unsupported fetched image content type: ${mime}`);
			}

			if (!isTextualMime(mime)) {
				throw new Error(`Unsupported fetched file content type: ${mime}`);
			}

			const buffer = await response.body.arrayBuffer();
			const body = Buffer.from(buffer.slice(0, MAX_RESPONSE_BYTES));
			const content = new TextDecoder().decode(body);

			let output: string;
			if (contentType.includes("text/html")) {
				if (format === "markdown") {
					output = convertHTMLToMarkdown(content);
				} else if (format === "text") {
					output = extractTextFromHTML(content);
				} else {
					output = content;
				}
			} else {
				output = content;
			}

			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const url = (args as WebFetchToolInput)?.url ?? "";
			return new Text(theme.fg("toolTitle", theme.bold("webfetch")) + theme.fg("toolOutput", ` ${url}`), 0, 0);
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

export function createWebFetchTool(cwd: string, options?: WebFetchToolOptions): AgentTool<typeof webfetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd, options));
}
