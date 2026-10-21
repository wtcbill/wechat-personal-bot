import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepSeekClient } from "../../src/chat/deepseek.ts";
import { ChatError } from "../../src/chat/types.ts";
import type { ModelRequest } from "../../src/chat/types.ts";
const request: ModelRequest = { messages: [{ role: "user", content: "你好" }], tools: [], thinking: "disabled", maxTokens: 100 };
const signal = () => new AbortController().signal;
const payload = { choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const hit = { url: "https://example.com/a", title: "资料", summary: "摘要", snippet: "片段", date: null };

test("wire paths/auth/nonthinking mode and independent search/fetch schemas", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [json(payload), json({ results: [hit] }), json({ title: "原文", content: "正文" })];
  const fake: typeof fetch = async (url, init) => {
    assert.ok(init);
    calls.push({ url: String(url), init });
    return replies.shift()!;
  };
  const client = new DeepSeekClient({ apiKey: "FAKE_KEY", fetch: fake });
  assert.equal((await client.complete(request, signal())).message.content, "你好");
  assert.equal((await client.search("查询", "😀".repeat(140), 5, signal())).length, 1);
  assert.equal((await client.fetch("https://example.com/a#fragment", signal())).content, "正文");
  assert.deepEqual(calls.map(item => item.url), ["https://api.deepseek.com/chat/completions", "https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch"]);
  assert.ok(calls.every(item => (item.init.headers as Record<string, string>).Authorization === "Bearer FAKE_KEY" && item.init.redirect === "error"));
  const chatBody = JSON.parse(String(calls[0]?.init.body));
  assert.equal(chatBody.thinking.type, "disabled");
  assert.equal(chatBody.tool_choice, "none");
  const searchBody = JSON.parse(String(calls[1]?.init.body));
  assert.equal([...searchBody.ori_question].length, 128);
  assert.equal(searchBody.need_content, false);
  assert.equal(JSON.parse(String(calls[2]?.init.body)).url, "https://example.com/a");
});

test("thinking is selected per request and the answer request has no tools", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new DeepSeekClient({ apiKey: "fake", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json(payload);
  } });
  const tool = { type: "function" as const, function: { name: "search_web", parameters: {} } };
  await client.complete({ ...request, tools: [tool] }, signal());
  await client.complete({ ...request, thinking: "enabled", maxTokens: 16_384 }, signal());
  assert.deepEqual(bodies[0]?.thinking, { type: "disabled" });
  assert.equal(bodies[0]?.tool_choice, "auto");
  assert.equal(bodies[0]?.reasoning_effort, undefined);
  assert.deepEqual(bodies[1]?.thinking, { type: "enabled" });
  assert.equal(bodies[1]?.reasoning_effort, "high");
  assert.equal(bodies[1]?.max_tokens, 16_384);
  assert.equal(bodies[1]?.tool_choice, "none");
  assert.equal(bodies[1]?.tools, undefined);
});

test("retryable HTTP failures retry finitely, authentication failures do not leak body/key", async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: "FAKE_SECRET", retryDelayMs: 0,
    fetch: async () => ++calls === 1 ? json({ error: "FAKE_SECRET" }, 429) : json(payload) });
  await client.complete(request, signal());
  assert.equal(calls, 2);
  calls = 0;
  const denied = new DeepSeekClient({ apiKey: "FAKE_SECRET", fetch: async () => { calls++; return json({ error: "FAKE_SECRET" }, 401); } });
  await assert.rejects(denied.complete(request, signal()), error => error instanceof ChatError && error.code === "HTTP_401" && !String(error).includes("SECRET"));
  assert.equal(calls, 1);
});

test("malformed responses, duplicate tool IDs, empty pages and credential URLs are rejected", async () => {
  const invalid = [json({ choices: [] }), json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "a", type: "function", function: { name: "search_web", arguments: "{}" } }, { id: "a", type: "function", function: { name: "search_web", arguments: "{}" } }] } }] }),
    json({ title: "a", content: "" })];
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: "fake", fetch: async () => { calls++; return invalid.shift()!; } });
  await assert.rejects(client.complete(request, signal()), { code: "INVALID_CHAT_RESPONSE" });
  await assert.rejects(client.complete(request, signal()), { code: "INVALID_TOOL_CALLS" });
  await assert.rejects(client.fetch("https://example.com/a", signal()), { code: "EMPTY_SOURCE" });
  await assert.rejects(client.fetch("https://name:password@example.com/a", signal()), { code: "INVALID_URL" });
  assert.equal(calls, 3);
});

test("Unicode search length, bounded retry count and response byte limit are enforced", async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: "fake", retryDelayMs: 0, fetch: async () => { calls++; return json({}, 503); } });
  await assert.rejects(client.search("😀".repeat(129), "q", 5, signal()), { code: "INVALID_SEARCH_ARGUMENTS" });
  assert.equal(calls, 0);
  await assert.rejects(client.complete(request, signal()), { code: "HTTP_503" });
  assert.equal(calls, 2);
  const huge = new DeepSeekClient({ apiKey: "fake", fetch: async () => new Response("x".repeat(2_000_001)) });
  await assert.rejects(huge.complete(request, signal()), { code: "RESPONSE_TOO_LARGE" });
});

test("request timeout aborts fetch, retries finitely, and caller cancellation does not retry", async () => {
  let calls = 0;
  const fake: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    calls++;
    const timer = setTimeout(() => reject(new Error("late")), 100);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
  const client = new DeepSeekClient({ apiKey: "fake", fetch: fake, requestTimeoutMs: 5, retryDelayMs: 0 });
  await assert.rejects(client.complete(request, signal()), { code: "REQUEST_TIMEOUT" });
  assert.equal(calls, 2);
  const controller = new AbortController();
  const running = client.complete(request, controller.signal);
  controller.abort();
  await assert.rejects(running, { code: "CANCELLED" });
  assert.equal(calls, 3);
});
