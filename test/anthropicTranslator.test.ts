import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicMessagesToChat,
  anthropicToolsToChatTools,
  buildAnthropicMessage,
  estimateAnthropicTokens,
  parseAnthropicRequest,
  stopReasonFor,
} from "../src/translate/anthropicTranslator";
import type { RunOutcome } from "../src/cursor/runController";

function outcome(partial: Partial<RunOutcome>): RunOutcome {
  return {
    content: "",
    reasoningContent: "",
    finishReason: "stop",
    toolCall: undefined,
    usage: undefined,
    agentId: "agent-1",
    runId: "run-1",
    model: undefined,
    ...partial,
  };
}

test("parseAnthropicRequest requires model and accepts extra Claude Code fields", () => {
  const parsed = parseAnthropicRequest({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    stream: true,
    temperature: 0.2,
    top_k: 40,
    thinking: { type: "enabled", budget_tokens: 8000 },
    cache_control: { type: "ephemeral" },
    metadata: { user_id: "dev" },
    system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "ping" }],
    tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  });
  assert.equal(parsed.model, "claude-sonnet-5");
  assert.equal(parsed.stream, true);
  assert.equal(parsed.maxTokens, 1024);
  assert.equal(parsed.messages[0]?.role, "system");
  assert.equal(parsed.messages[1]?.content, "ping");
  assert.equal(parsed.tools?.[0]?.function.name, "bash");
});

test("parseAnthropicRequest rejects a missing model", () => {
  assert.throws(() => parseAnthropicRequest({ messages: [] }), /model/);
});

test("anthropicMessagesToChat maps tool_use and tool_result", () => {
  const messages = anthropicMessagesToChat({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "calling" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
      },
    ],
  });
  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[0]?.tool_calls?.[0]?.id, "toolu_1");
  assert.equal(messages[0]?.reasoning_content, "plan");
  assert.equal(messages[1]?.role, "tool");
  assert.equal(messages[1]?.tool_call_id, "toolu_1");
  assert.equal(messages[1]?.content, "file body");
});

test("anthropicMessagesToChat maps base64 images to data URLs", () => {
  const messages = anthropicMessagesToChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      },
    ],
  });
  assert.equal(messages[0]?.role, "user");
  assert.ok(Array.isArray(messages[0]?.content));
  const parts = messages[0]?.content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
  assert.equal(parts[1]?.image_url?.url, "data:image/png;base64,abc");
});

test("anthropicToolsToChatTools skips nameless entries", () => {
  const tools = anthropicToolsToChatTools([{ description: "no name" }, { name: "ok", input_schema: { type: "object" } }]);
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.function.name, "ok");
});

test("buildAnthropicMessage uses tool_use stop_reason and thinking blocks", () => {
  const message = buildAnthropicMessage({
    id: "msg_1",
    model: "claude-sonnet-5",
    promptText: "hi",
    includeThinking: true,
    outcome: outcome({
      content: "done",
      reasoningContent: "think",
      finishReason: "tool_calls",
      toolCall: { id: "call_1", name: "Bash", argumentsJson: "{\"cmd\":\"ls\"}" },
    }),
  });
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0]?.type, "thinking");
  assert.equal(message.content[1]?.type, "text");
  assert.equal(message.content[2]?.type, "tool_use");
});

test("stopReasonFor maps tool_calls and stop", () => {
  assert.equal(stopReasonFor(outcome({ finishReason: "tool_calls" })), "tool_use");
  assert.equal(stopReasonFor(outcome({ finishReason: "stop" })), "end_turn");
});

test("estimateAnthropicTokens is at least 1", () => {
  assert.ok(estimateAnthropicTokens({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello world" }] }) >= 1);
});
