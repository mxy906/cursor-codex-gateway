import { Router, type Request, type Response } from "express";
import type { GatewayDeps } from "../gateway/orchestrator";
import { executeGatewayTurn, isHeldOpen, prepareGatewayTurn, rememberGatewayTurn } from "../gateway/orchestrator";
import { HttpError, mapErrorToResponse } from "../errors";
import { SseWriter } from "../utils/sse";
import { newMessageId, newResponseId } from "../utils/ids";
import { stringifyContent } from "../translate/requestTranslator";
import { parseResponsesRequest } from "../translate/responsesTranslator";
import type { PendingToolCall } from "../cursor/toolBridge";
import type { RunOutcome } from "../cursor/runController";

export function createResponsesRouter(deps: GatewayDeps): Router {
  const router = Router();
  router.post("/v1/responses", (req, res, next) => {
    void handleResponses(deps, req, res).catch(next);
  });
  return router;
}

function usageFromOutcome(outcome: RunOutcome, promptText: string) {
  const input = outcome.usage?.inputTokens ?? Math.ceil(promptText.length / 4);
  const output = outcome.usage?.outputTokens ?? Math.ceil((outcome.content?.length ?? 0) / 4);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  };
}

function functionCallItem(call: PendingToolCall) {
  return {
    id: call.id,
    type: "function_call" as const,
    call_id: call.id,
    name: call.name,
    arguments: call.argumentsJson,
    status: "completed" as const,
  };
}

function messageItem(msgId: string, text: string) {
  return {
    id: msgId,
    type: "message" as const,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{ type: "output_text" as const, text, annotations: [] as unknown[] }],
  };
}

function buildResponsesObject(params: {
  id: string;
  created: number;
  model: string;
  outcome: RunOutcome;
  promptText: string;
  reasoningEffort: string | undefined;
  msgId: string;
}) {
  const toolCalls = params.outcome.toolCalls?.length
    ? params.outcome.toolCalls
    : params.outcome.toolCall
      ? [params.outcome.toolCall]
      : [];
  const output: unknown[] = [];
  if (params.outcome.content) output.push(messageItem(params.msgId, params.outcome.content));
  for (const call of toolCalls) output.push(functionCallItem(call));
  if (output.length === 0) output.push(messageItem(params.msgId, params.outcome.content || ""));

  return {
    id: params.id,
    object: "response",
    created_at: params.created,
    status: "completed",
    model: params.model,
    output,
    usage: usageFromOutcome(params.outcome, params.promptText),
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: params.reasoningEffort || "medium", summary: "auto" },
    text: { format: { type: "text" } },
    tools: [] as unknown[],
    truncation: "disabled",
    cursor_agent_id: params.outcome.agentId,
  };
}

async function handleResponses(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");

  let parsed;
  try {
    parsed = parseResponsesRequest(req.body);
  } catch (err) {
    throw HttpError.badRequest(err instanceof Error ? err.message : "Invalid Responses request");
  }

  const prepared = await prepareGatewayTurn(deps, {
    apiKey: req.cursorApiKey,
    endpoint: "/v1/responses",
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
  const respId = newResponseId();
  const created = Math.floor(Date.now() / 1000);
  const msgId = newMessageId();
  const reasoningEffort = parsed.reasoningEffort;

  if (parsed.stream) {
    const sse = new SseWriter(res);
    const empty = {
      id: respId,
      object: "response",
      created_at: created,
      status: "in_progress",
      model: prepared.resolvedModelId,
      output: [] as unknown[],
      usage: null,
    };
    sse.send({ type: "response.created", response: empty });
    sse.send({ type: "response.in_progress", response: empty });
    sse.send({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    sse.send({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });

    let fullText = "";
    let msgClosed = false;
    let nextIndex = 1;
    const completedCalls: PendingToolCall[] = [];

    const closeMessage = () => {
      if (msgClosed) return;
      msgClosed = true;
      sse.send({
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: fullText, annotations: [] },
      });
      sse.send({
        type: "response.output_item.done",
        output_index: 0,
        item: messageItem(msgId, fullText),
      });
    };

    let heldOpen = false;
    try {
      const outcome = await executeGatewayTurn(deps, prepared, {
        abortSignal: abortController.signal,
        streaming: true,
        sink: {
          onTextDelta: (delta) => {
            fullText += delta;
            sse.send({
              type: "response.output_text.delta",
              item_id: msgId,
              output_index: 0,
              content_index: 0,
              delta,
            });
          },
          onReasoningDelta: (delta) => {
            sse.send({
              type: "response.reasoning_text.delta",
              item_id: msgId,
              output_index: 0,
              content_index: 0,
              delta,
            });
          },
          onToolCallStarted: (call) => {
            closeMessage();
            const outputIndex = nextIndex;
            nextIndex += 1;
            completedCalls.push(call);
            sse.send({
              type: "response.output_item.added",
              output_index: outputIndex,
              item: {
                id: call.id,
                type: "function_call",
                call_id: call.id,
                name: call.name,
                arguments: "",
                status: "in_progress",
              },
            });
            sse.send({
              type: "response.function_call_arguments.delta",
              item_id: call.id,
              output_index: outputIndex,
              delta: call.argumentsJson,
            });
            sse.send({
              type: "response.function_call_arguments.done",
              item_id: call.id,
              output_index: outputIndex,
              arguments: call.argumentsJson,
            });
            sse.send({
              type: "response.output_item.done",
              output_index: outputIndex,
              item: functionCallItem(call),
            });
          },
        },
      });

      heldOpen = isHeldOpen(prepared, outcome);
      closeMessage();

      const finalOutcome: RunOutcome = {
        ...outcome,
        content: outcome.content || fullText,
        toolCalls: outcome.toolCalls?.length ? outcome.toolCalls : completedCalls.length ? completedCalls : outcome.toolCalls,
      };

      if (!sse.isClosed) {
        sse.send({
          type: "response.completed",
          response: buildResponsesObject({
            id: respId,
            created,
            model: prepared.resolvedModelId,
            outcome: finalOutcome,
            promptText: promptEstimateText,
            reasoningEffort,
            msgId,
          }),
        });
        sse.done();
      }

      if (outcome.finishReason !== "cancelled") {
        rememberGatewayTurn(deps, prepared, finalOutcome);
      }
    } catch (err) {
      prepared.log.error({ err }, "streaming responses failed mid-run");
      if (!sse.isClosed) {
        const mapped = mapErrorToResponse(err);
        sse.send({
          type: "response.failed",
          response: {
            id: respId,
            status: "failed",
            error: { code: "server_error", message: mapped.body?.error?.message ?? "upstream error" },
          },
        });
        sse.done();
      }
    } finally {
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
    throw err;
  }
  if (!heldOpen) prepared.releaseSemaphore();

  if (outcome.finishReason !== "cancelled") {
    rememberGatewayTurn(deps, prepared, outcome);
  }

  res.json(
    buildResponsesObject({
      id: respId,
      created,
      model: prepared.resolvedModelId,
      outcome,
      promptText: promptEstimateText,
      reasoningEffort,
      msgId,
    }),
  );
}
