/**
 * Isolated Claude Code protocol smoke test.
 *
 * Hits a running gateway over HTTP only. Does not read or write ~/.claude,
 * does not set ANTHROPIC_BASE_URL, and does not launch the Claude Code CLI.
 *
 *   SMOKE_BASE_URL=http://127.0.0.1:8787 AUTH_KEY=change-me npm run smoke:messages
 */
import "dotenv/config";

const BASE_URL = (process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`).replace(/\/$/, "");
const AUTH_KEY = process.env["AUTH_KEY"] ?? process.env["SMOKE_AUTH_KEY"];
const MODEL = process.env["SMOKE_MODEL"] ?? "claude-sonnet-5";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    ...extra,
  };
  if (AUTH_KEY) {
    h["Authorization"] = `Bearer ${AUTH_KEY}`;
    h["x-api-key"] = AUTH_KEY;
  }
  return h;
}

async function must(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`PASS  ${name} - ${detail} (${Date.now() - started}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`FAIL  ${name} - ${detail}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  await must("HEAD /api/hello", async () => {
    const res = await fetch(`${BASE_URL}/api/hello`, { method: "HEAD" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return String(res.status);
  });

  await must("POST /v1/messages/count_tokens", async () => {
    const res = await fetch(`${BASE_URL}/v1/messages/count_tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const body = (await res.json()) as { input_tokens?: number; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    if (typeof body.input_tokens !== "number") throw new Error(`unexpected body ${JSON.stringify(body)}`);
    return `${body.input_tokens} tokens`;
  });

  await must("GET /v1/models (Anthropic shape)", async () => {
    const res = await fetch(`${BASE_URL}/v1/models`, { headers: headers() });
    const body = (await res.json()) as { data?: Array<{ id?: string; type?: string }>; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    if (!Array.isArray(body.data) || body.data.length === 0) throw new Error("empty model list");
    if (body.data[0]?.type !== "model") throw new Error(`expected Anthropic model objects, got ${JSON.stringify(body.data[0])}`);
    return `${body.data.length} models`;
  });

  await must("POST /v1/messages (non-stream)", async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "Reply with the single word PONG." }],
      }),
    });
    const body = (await res.json()) as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    if (body.type !== "message" || body.role !== "assistant") throw new Error(`unexpected ${JSON.stringify(body)}`);
    const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!text) throw new Error("empty assistant text");
    return text.slice(0, 80);
  });

  await must("POST /v1/messages (stream SSE)", async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "Reply with the single word PONG." }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (!raw.includes("event: message_start")) throw new Error("missing message_start");
    if (!raw.includes("event: message_stop")) throw new Error("missing message_stop");
    return `${raw.split("event:").length - 1} events`;
  });

  if (process.exitCode) {
    console.error("\nClaude Code protocol smoke failed.");
    process.exit(1);
  }
  console.log("\nClaude Code protocol smoke passed.");
}

void main();
