import { Router, type Request, type Response } from "express";
import type { GatewayDeps } from "../gateway/orchestrator";
import { executeGatewayTurn, isHeldOpen, prepareGatewayTurn, rememberGatewayTurn } from "../gateway/orchestrator";
import { HttpError, mapErrorToResponse } from "../errors";
import { SseWriter } from "../utils/sse";
import { newMessageId } from "../utils/ids";
import { stringifyContent } from "../translate/requestTranslator";
import {
  buildAnthropicMessage,
  estimateAnthropicTokens,
  parseAnthropicRequest,
  stopReasonFor,
  usageFromOutcome,
} from "../translate/anthropicTranslator";
import type { PendingToolCall } from "../cursor/toolBridge";
import type { RunOutcome } from "../cursor/runController";

export function createMessagesRouter(deps: GatewayDeps): Router {
  const router = Router();

  router.post("/v1/messages/count_tokens", (req, res, next) => {
    try {
      parseAnthropicRequest(req.body);
      res.json({
        type: "message_count_tokens",
        input_tokens: estimateAnthropicTokens(req.body),
      });
    } catch (err) {
      next(HttpError.badRequest(err instanceof Error ? err.message : "Invalid Messages request"));
    }
  });

  router.post("/v1/messages", (req, res, next) => {
    void handleMessages(deps, req, res).catch(next);
  });

  return router;
}

function anthropicError(res: Response, err: unknown): void {
  const mapped = mapErrorToResponse(err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(mapped.status).json({
    type: "error",
    error: {
      type: mapped.body.error?.type ?? "api_error",
      message: mapped.body.error?.message ?? "request failed",
    },
  });
}

async function handleMessages(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");

  let parsed;
  try {
    parsed = parseAnthropicRequest(req.body);
  } catch (err) {
    throw HttpError.badRequest(err instanceof Error ? err.message : "Invalid Messages request");
  }

  const prepared = await prepareGatewayTurn(deps, {
    apiKey: req.cursorApiKey,
    endpoint: "/v1/messages",
    requestedModelId: parsed.model,
    rawMessages: parsed.messages,
    tools: parsed.tools,
    metadata: parsed.metadata,
    requestId: req.requestId,
  });

  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const promptEstimateText = parsed.messages.map((m) => stringifyContent(m.content)).join("\n");
  const msgId = newMessageId();
  const includeThinking = deps.config.includeThinking;

  if (parsed.stream) {
    const sse = new SseWriter(res);
    const ping = setInterval(() => sse.sendComment("ping"), 15_000);

    const emptyMessage = {
      id: msgId,
      type: "message",
      role: "assistant",
      model: prepared.resolvedModelId,
      content: [] as unknown[],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    sse.sendEvent("message_start", { type: "message_start", message: emptyMessage });

    let blockIndex = 0;
    let thinkingOpen = false;
    let textOpen = false;
    let thinkingText = "";
    let fullText = "";
    const completedCalls: PendingToolCall[] = [];

    const closeThinking = () => {
      if (!thinkingOpen) return;
      sse.sendEvent("content_block_stop", { type: "content_block_stop", index: 0 });
      thinkingOpen = false;
      blockIndex = Math.max(blockIndex, 1);
    };

    const ensureTextOpen = () => {
      if (textOpen) return;
      closeThinking();
      sse.sendEvent("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "text", text: "" },
      });
      textOpen = true;
    };

    const closeText = () => {
      if (!textOpen) return;
      sse.sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
      textOpen = false;
      blockIndex += 1;
    };

    let heldOpen = false;
    try {
      const outcome = await executeGatewayTurn(deps, prepared, {
        abortSignal: abortController.signal,
        streaming: true,
        sink: {
          onReasoningDelta: (delta) => {
            if (!includeThinking) return;
            if (!thinkingOpen && !textOpen && completedCalls.length === 0) {
              sse.sendEvent("content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "" },
              });
              thinkingOpen = true;
            }
            if (!thinkingOpen) return;
            thinkingText += delta;
            sse.sendEvent("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: delta },
            });
          },
          onTextDelta: (delta) => {
            ensureTextOpen();
            fullText += delta;
            sse.sendEvent("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: delta },
            });
          },
          onToolCallStarted: (call) => {
            closeThinking();
            closeText();
            completedCalls.push(call);
            const index = blockIndex;
            sse.sendEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
            });
            sse.sendEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: call.argumentsJson },
            });
            sse.sendEvent("content_block_stop", { type: "content_block_stop", index });
            blockIndex += 1;
          },
        },
      });

      heldOpen = isHeldOpen(prepared, outcome);
      closeThinking();
      closeText();

      const finalOutcome: RunOutcome = {
        ...outcome,
        content: outcome.content || fullText,
        reasoningContent: outcome.reasoningContent || thinkingText,
        toolCalls: outcome.toolCalls?.length
          ? outcome.toolCalls
          : completedCalls.length
            ? completedCalls
            : outcome.toolCalls,
      };

      if (!sse.isClosed) {
        const usage = usageFromOutcome(finalOutcome, promptEstimateText);
        sse.sendEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReasonFor(finalOutcome), stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        });
        sse.sendEvent("message_stop", { type: "message_stop" });
        sse.end();
      }

      if (outcome.finishReason !== "cancelled") {
        rememberGatewayTurn(deps, prepared, finalOutcome);
      }
    } catch (err) {
      prepared.log.error({ err }, "streaming messages failed mid-run");
      if (!sse.isClosed) {
        const mapped = mapErrorToResponse(err);
        sse.sendEvent("error", {
          type: "error",
          error: {
            type: mapped.body.error?.type ?? "api_error",
            message: mapped.body.error?.message ?? "upstream error",
          },
        });
        sse.end();
      }
    } finally {
      clearInterval(ping);
      if (!heldOpen) prepared.releaseSemaphore();
    }
    return;
  }

  let outcome: RunOutcome;
  let heldOpen = false;
  try {
    outcome = await executeGatewayTurn(deps, prepared, {
      abortSignal: abortController.signal,
      sink: undefined,
      streaming: false,
    });
    heldOpen = isHeldOpen(prepared, outcome);
  } catch (err) {
    prepared.releaseSemaphore();
    anthropicError(res, err);
    return;
  }
  if (!heldOpen) prepared.releaseSemaphore();

  if (outcome.finishReason !== "cancelled") {
    rememberGatewayTurn(deps, prepared, outcome);
  }

  res.json(
    buildAnthropicMessage({
      id: msgId,
      model: prepared.resolvedModelId,
      outcome,
      promptText: promptEstimateText,
      includeThinking,
    }),
  );
}
