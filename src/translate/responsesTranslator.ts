import type { ChatCompletionMessage, ChatCompletionTool } from "../types/openai";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentPartsToText(content: unknown): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "number" ? String(content) : "";

  const textParts: string[] = [];
  const mixed: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  let hasImage = false;

  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
      mixed.push({ type: "text", text: part });
      continue;
    }
    if (!isPlainObject(part)) continue;
    const type = String(part["type"] ?? "");
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = String(part["text"] ?? "");
      textParts.push(text);
      mixed.push({ type: "text", text });
    } else if (type === "input_image" || type === "image_url") {
      hasImage = true;
      const image = isPlainObject(part["image_url"]) ? part["image_url"] : part;
      const url = String(image["url"] ?? part["image_url"] ?? "");
      if (url) mixed.push({ type: "image_url", image_url: { url } });
    }
  }

  if (hasImage) return mixed;
  return textParts.join("\n");
}

const HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "code_interpreter",
  "computer",
  "computer_use",
]);

export function responsesToolsToChatTools(raw: unknown): ChatCompletionTool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: ChatCompletionTool[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const type = String(item["type"] ?? "function");
    if (HOSTED_TOOL_TYPES.has(type)) continue;

    const fn = isPlainObject(item["function"]) ? item["function"] : item;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (!name) continue;

    tools.push({
      type: "function",
      function: {
        name,
        description: typeof fn["description"] === "string" ? fn["description"] : "",
        parameters: isPlainObject(fn["parameters"]) ? fn["parameters"] : { type: "object", properties: {} },
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function responsesInputToMessages(body: Record<string, unknown>): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];
  const instructions = body["instructions"];
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }

  const input = body["input"];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) {
    if (messages.length === 0) messages.push({ role: "user", content: "Hello" });
    return messages;
  }

  const pendingToolCalls: NonNullable<ChatCompletionMessage["tool_calls"]> = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls.splice(0, pendingToolCalls.length),
    });
  };

  for (const item of input) {
    if (typeof item === "string") {
      flushToolCalls();
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!isPlainObject(item)) continue;

    const itemType = String(item["type"] ?? "");
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = String(item["call_id"] ?? item["id"] ?? "");
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: String(item["name"] ?? ""),
          arguments: typeof item["arguments"] === "string" ? item["arguments"] : JSON.stringify(item["arguments"] ?? {}),
        },
      });
      continue;
    }
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      flushToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: String(item["call_id"] ?? ""),
        content: typeof item["output"] === "string" ? item["output"] : JSON.stringify(item["output"] ?? ""),
      });
      continue;
    }
    if (itemType === "reasoning" || itemType === "item_reference") continue;

    flushToolCalls();
    let role = String(item["role"] ?? (itemType === "message" ? "user" : "user"));
    if (role === "developer") role = "system";
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") role = "user";

    const content = contentPartsToText(item["content"]);
    const message: ChatCompletionMessage = {
      role: role as ChatCompletionMessage["role"],
      content: content === "" ? (role === "assistant" ? null : "") : content,
    };
    if (Array.isArray(item["tool_calls"])) {
      message.tool_calls = item["tool_calls"] as ChatCompletionMessage["tool_calls"];
    }
    messages.push(message);
  }

  flushToolCalls();
  if (messages.length === 0) messages.push({ role: "user", content: "Hello" });
  return messages;
}

export function parseResponsesRequest(body: unknown): {
  model: string;
  stream: boolean;
  messages: ChatCompletionMessage[];
  tools: ChatCompletionTool[] | undefined;
  reasoningEffort: string | undefined;
  metadata: Record<string, unknown> | undefined;
} {
  if (!isPlainObject(body)) {
    throw new Error("Request body must be a JSON object");
  }
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  if (!model) {
    throw new Error('"model" is required');
  }
  const reasoning = isPlainObject(body["reasoning"]) ? body["reasoning"] : undefined;
  return {
    model,
    stream: body["stream"] === true,
    messages: responsesInputToMessages(body),
    tools: responsesToolsToChatTools(body["tools"]),
    reasoningEffort: typeof reasoning?.["effort"] === "string" ? reasoning["effort"] : undefined,
    metadata: isPlainObject(body["metadata"]) ? body["metadata"] : undefined,
  };
}
