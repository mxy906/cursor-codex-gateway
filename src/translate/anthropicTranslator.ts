import type { ChatCompletionMessage, ChatCompletionTool } from "../types/openai";
import type { PendingToolCall } from "../cursor/toolBridge";
import type { RunOutcome } from "../cursor/runController";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function systemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system) {
    if (!isPlainObject(block)) continue;
    if (String(block["type"] ?? "text") === "text") {
      const text = asText(block["text"]);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function imagePartFromSource(source: unknown): { type: "image_url"; image_url: { url: string } } | undefined {
  if (!isPlainObject(source)) return undefined;
  const kind = String(source["type"] ?? "");
  if (kind === "url") {
    const url = asText(source["url"]);
    return url ? { type: "image_url", image_url: { url } } : undefined;
  }
  if (kind === "base64") {
    const data = asText(source["data"]);
    const media = asText(source["media_type"]) || "image/png";
    if (!data) return undefined;
    return { type: "image_url", image_url: { url: `data:${media};base64,${data}` } };
  }
  return undefined;
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return asText(content);
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isPlainObject(block)) continue;
    if (String(block["type"] ?? "") === "text") parts.push(asText(block["text"]));
    else parts.push(asText(block));
  }
  return parts.join("\n");
}

export function anthropicToolsToChatTools(raw: unknown): ChatCompletionTool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: ChatCompletionTool[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const name = typeof item["name"] === "string" ? item["name"] : "";
    if (!name) continue;
    const schema = isPlainObject(item["input_schema"])
      ? item["input_schema"]
      : isPlainObject(item["inputSchema"])
        ? item["inputSchema"]
        : { type: "object", properties: {} };
    tools.push({
      type: "function",
      function: {
        name,
        description: typeof item["description"] === "string" ? item["description"] : "",
        parameters: schema,
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function anthropicMessagesToChat(body: Record<string, unknown>): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];
  const systemText = systemToText(body["system"]);
  if (systemText.trim()) {
    messages.push({ role: "system", content: systemText });
  }

  const rawMessages = Array.isArray(body["messages"]) ? body["messages"] : [];
  for (const raw of rawMessages) {
    if (!isPlainObject(raw)) continue;
    const role = String(raw["role"] ?? "user");
    const content = raw["content"];

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<ChatCompletionMessage["tool_calls"]> = [];
      let reasoning = "";

      const pushAssistant = () => {
        if (textParts.length === 0 && toolCalls.length === 0 && !reasoning) {
          messages.push({ role: "assistant", content: asText(content) || null });
          return;
        }
        const msg: ChatCompletionMessage = {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("\n") : toolCalls.length > 0 ? null : "",
        };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        if (reasoning) msg.reasoning_content = reasoning;
        messages.push(msg);
      };

      if (typeof content === "string") {
        messages.push({ role: "assistant", content });
        continue;
      }
      if (!Array.isArray(content)) {
        pushAssistant();
        continue;
      }
      for (const block of content) {
        if (!isPlainObject(block)) continue;
        const type = String(block["type"] ?? "");
        if (type === "text") textParts.push(asText(block["text"]));
        else if (type === "thinking" || type === "redacted_thinking") {
          const think = asText(block["thinking"] ?? block["data"]);
          if (think) reasoning += (reasoning ? "\n" : "") + think;
        } else if (type === "tool_use") {
          toolCalls.push({
            id: asText(block["id"]),
            type: "function",
            function: {
              name: asText(block["name"]),
              arguments: typeof block["input"] === "string" ? block["input"] : JSON.stringify(block["input"] ?? {}),
            },
          });
        }
      }
      pushAssistant();
      continue;
    }

    if (role === "user") {
      if (typeof content === "string") {
        messages.push({ role: "user", content });
        continue;
      }
      if (!Array.isArray(content)) {
        messages.push({ role: "user", content: asText(content) });
        continue;
      }

      const mixed: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
      const toolResults: ChatCompletionMessage[] = [];
      let hasImage = false;

      for (const block of content) {
        if (typeof block === "string") {
          mixed.push({ type: "text", text: block });
          continue;
        }
        if (!isPlainObject(block)) continue;
        const type = String(block["type"] ?? "");
        if (type === "text") {
          mixed.push({ type: "text", text: asText(block["text"]) });
        } else if (type === "image") {
          const image = imagePartFromSource(block["source"]);
          if (image) {
            hasImage = true;
            mixed.push(image);
          }
        } else if (type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: asText(block["tool_use_id"]),
            content: flattenToolResultContent(block["content"]),
          });
        }
      }

      for (const toolMsg of toolResults) messages.push(toolMsg);
      if (mixed.length > 0) {
        if (hasImage) messages.push({ role: "user", content: mixed });
        else messages.push({ role: "user", content: mixed.map((p) => (p.type === "text" ? p.text : "")).join("\n") });
      } else if (toolResults.length === 0) {
        messages.push({ role: "user", content: "" });
      }
      continue;
    }

    messages.push({ role: "user", content: asText(content) });
  }

  if (messages.length === 0) messages.push({ role: "user", content: "Hello" });
  return messages;
}

export function parseAnthropicRequest(body: unknown): {
  model: string;
  stream: boolean;
  maxTokens: number;
  messages: ChatCompletionMessage[];
  tools: ChatCompletionTool[] | undefined;
  metadata: Record<string, unknown> | undefined;
} {
  if (!isPlainObject(body)) {
    throw new Error("Request body must be a JSON object");
  }
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  if (!model) {
    throw new Error('"model" is required');
  }
  const maxTokensRaw = body["max_tokens"];
  const maxTokens = typeof maxTokensRaw === "number" && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : 4096;
  return {
    model,
    stream: body["stream"] === true,
    maxTokens,
    messages: anthropicMessagesToChat(body),
    tools: anthropicToolsToChatTools(body["tools"]),
    metadata: isPlainObject(body["metadata"]) ? body["metadata"] : undefined,
  };
}

export function estimateAnthropicTokens(body: unknown): number {
  try {
    const text = JSON.stringify(body ?? "");
    return Math.max(1, Math.ceil(text.length / 4));
  } catch {
    return 1;
  }
}

function parseToolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return isPlainObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: argumentsJson };
  }
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export function outcomeToContentBlocks(outcome: RunOutcome, includeThinking: boolean): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const reasoning = includeThinking ? outcome.reasoningContent : undefined;
  if (reasoning) blocks.push({ type: "thinking", thinking: reasoning });
  if (outcome.content) blocks.push({ type: "text", text: outcome.content });

  const toolCalls = outcome.toolCalls?.length
    ? outcome.toolCalls
    : outcome.toolCall
      ? [outcome.toolCall]
      : [];
  for (const call of toolCalls) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parseToolInput(call.argumentsJson),
    });
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

export function stopReasonFor(outcome: RunOutcome): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
  const hasTools = Boolean(outcome.toolCalls?.length || outcome.toolCall);
  if (hasTools || outcome.finishReason === "tool_calls") return "tool_use";
  if ((outcome.finishReason as string) === "length") return "max_tokens";
  return "end_turn";
}

export function usageFromOutcome(outcome: RunOutcome, promptText: string) {
  const input = outcome.usage?.inputTokens ?? Math.ceil(promptText.length / 4);
  const output = outcome.usage?.outputTokens ?? Math.ceil((outcome.content?.length ?? 0) / 4);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export function buildAnthropicMessage(params: {
  id: string;
  model: string;
  outcome: RunOutcome;
  promptText: string;
  includeThinking: boolean;
}) {
  const content = outcomeToContentBlocks(params.outcome, params.includeThinking);
  return {
    id: params.id,
    type: "message" as const,
    role: "assistant" as const,
    model: params.model,
    content,
    stop_reason: stopReasonFor(params.outcome),
    stop_sequence: null,
    usage: usageFromOutcome(params.outcome, params.promptText),
  };
}

export function collectToolCalls(outcome: RunOutcome): PendingToolCall[] {
  if (outcome.toolCalls?.length) return outcome.toolCalls;
  if (outcome.toolCall) return [outcome.toolCall];
  return [];
}
