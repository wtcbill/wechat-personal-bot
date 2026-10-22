/**
 * L3 — Controlled real-API acceptance for the first review fixes.
 * Input: ignored local chat API config and fixed public prompts.
 * Output: actual policy, model/tool decisions, HTTP status and final results.
 * Pos: explicit live verification; see ./L2.md and ../README.md.
 * Effects/Dependencies: real DeepSeek account quota; no fake model/HTTP, file
 * writes, channel operations, secret/header/body or reasoning-trace logging.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeepSeekClient } from "./chat/deepseek.ts";
import { Research } from "./chat/research.ts";
import { ChatService } from "./chat/service.ts";
import type { ModelReply, ModelRequest } from "./chat/types.ts";
import { loadServiceConfig } from "./service-config.ts";
import type { NetworkPolicy } from "./services.ts";

interface Observation {
  thinking: string; policy: string | undefined; offeredTools: number;
  action: string | null; tools: string[]; catalog: { id: string; status: string }[];
}
class ObservedClient extends DeepSeekClient {
  readonly observations: Observation[] = [];
  override async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    const system = request.messages[0]?.content ?? "";
    const reply = await super.complete(request, signal);
    let action: string | null = null;
    try { action = (JSON.parse(reply.message.content ?? "") as { action?: string }).action ?? null; } catch { /* Tool reply. */ }
    const catalogText = /已登记来源（不代表本轮已读取）：([^\n]+)/.exec(system)?.[1];
    const catalog = catalogText ? JSON.parse(catalogText) as Observation["catalog"] : [];
    const observation: Observation = { thinking: request.thinking, policy: /网络策略：(auto|off|required)/.exec(system)?.[1],
      offeredTools: request.tools.length, action, tools: (reply.message.tool_calls ?? []).map(call => call.function.name),
      catalog: catalog.map(({ id, status }) => ({ id, status })) };
    this.observations.push(observation);
    console.log(JSON.stringify({ model: observation }));
    return reply;
  }
}

const http: { path: string; status: number }[] = [];
const actualFetch: typeof fetch = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  const record = { path: new URL(String(url)).pathname, status: response.status };
  http.push(record);
  console.log(JSON.stringify({ http: record }));
  return response;
};

try {
  const config = await loadServiceConfig();
  const apiKey = config.chat.apiKey?.trim() || config.apiKey.trim() || process.env[config.chat.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error("MISSING_API_KEY");
  const client = new ObservedClient({ apiKey, model: config.chat.model, requestTimeoutMs: config.chat.requestTimeoutMs,
    thinkingTimeoutMs: config.chat.thinkingTimeoutMs, fetch: actualFetch });
  const chat = new ChatService(client, client);
  const cases: { name: string; text: string; network?: NetworkPolicy; search: boolean; anchor?: string; clarify?: boolean }[] = [
    { name: "默认auto解释搜索算法", text: "解释搜索算法，用两句话。", search: false },
    { name: "默认auto时效新闻", text: "今天有什么新闻？简要列一条，并引用来源。", search: true },
    { name: "显式auto翻译引用", text: "把‘不要联网’翻译成英文，只给翻译。", network: "auto", search: false },
    { name: "auto自然语言禁止搜索", text: "不需要搜索，润色下面的文字：这个工具很好用，我每天都用它。只给润色结果。", search: false },
    { name: "显式off包含搜索联网词", text: "搜索和联网是什么意思？用一句话说明。", network: "off", search: false },
    { name: "显式required及同页锚点", network: "required", search: true, anchor: "#enable-thinking",
      text: "请联网读取 DeepSeek 官方思考模式文档 https://api-docs.deepseek.com/guides/thinking_mode/ 原文。用一句话说明启用思考的参数，引用来源，并原样附上该页链接 https://api-docs.deepseek.com/guides/thinking_mode/#enable-thinking 。" },
    { name: "required固定文案澄清通路", text: "请查询天气；未提供城市，请先原样问“请问你想查询哪个城市的天气？”，不要猜测城市。", network: "required", search: false, clarify: true },
  ];
  for (const test of cases) {
    console.log(`开始：${test.name}`);
    const observationStart = client.observations.length, httpStart = http.length;
    const value = await chat.run({ sessionId: randomUUID(), requestId: randomUUID(), text: test.text,
      ...(test.network === undefined ? {} : { network: test.network }) }, AbortSignal.timeout(150_000));
    console.log(JSON.stringify({ case: test.name, status: value.status, usage: value.usage, tools: value.tools,
      sources: value.sources.map(({ id, status }) => ({ id, status })), limitations: value.limitations, answer: value.answer }));
    assert.equal(value.status, "completed", test.name);
    assert.ok(value.answer.trim(), test.name);
    const observations = client.observations.slice(observationStart);
    assert.ok(observations.length >= 2);
    assert.ok(observations.every(item => item.policy === (test.network ?? "auto")), "实际模型上下文策略必须保留参数");
    assert.ok(observations.some(item => item.thinking === "enabled" && item.offeredTools === 0));
    const calls = http.slice(httpStart);
    assert.ok(calls.every(item => item.status === 200), "真实HTTP必须成功");
    if (test.search) {
      // required needs acquired evidence; a known URL may go straight to Fetch.
      assert.ok(test.anchor
        ? value.usage.fetches > 0 && calls.some(item => item.path === "/v1/tools/fetch")
        : value.usage.searches > 0 && calls.some(item => item.path === "/v1/tools/search"));
      assert.ok(value.sources.length && /\[S\d+\]/.test(value.answer));
    } else {
      assert.equal(value.usage.searches, 0);
      assert.equal(value.usage.fetches, 0);
      assert.ok(observations.every(item => item.tools.length === 0 && item.action !== "supplement"));
      assert.ok(calls.every(item => item.path === "/chat/completions"));
    }
    if (test.network === "off") assert.ok(observations.every(item => item.offeredTools === 0));
    if (test.anchor) {
      assert.ok(value.answer.includes(test.anchor), "最终答案必须保留fragment");
      assert.ok(value.usage.fetches > 0 && value.sources.some(item => item.status === "read"));
    }
    if (test.clarify) assert.match(value.answer, /[?？]$/);
    console.log(`通过：${test.name}`);
  }

  console.log("开始：真实Research状态、缓存和跨轮初始化");
  let id = 100;
  const limits = { maxTools: 5, maxSearches: 2, maxFetches: 2, maxSources: 10 };
  const url = "https://api-docs.deepseek.com/guides/thinking_mode/";
  const research = new Research(client, `读取 ${url}`, true, limits, () => `S${id++}`);
  const signal = AbortSignal.timeout(60_000);
  const tool = async (name: string, args: object) => {
    const result = JSON.parse(await research.execute({ id: randomUUID(), type: "function",
      function: { name, arguments: JSON.stringify(args) } }, signal)) as { ok: boolean };
    assert.equal(result.ok, true, name);
    const catalog = JSON.parse(research.catalog()) as { id: string; status: string }[];
    assert.deepEqual(catalog.map(item => item.status), research.sources().map(item => item.status));
    console.log(JSON.stringify({ researchCatalog: catalog.map(({ id, status }) => ({ id, status })) }));
  };
  assert.ok(research.sources().every(item => item.status === "unread"));
  await tool("search_web", { queries: ["site:api-docs.deepseek.com/guides/thinking_mode DeepSeek thinking"] });
  assert.ok(research.sources().some(item => item.status === "summary"));
  const sourceId = research.sources().find(item => item.url === url)!.id;
  await tool("read_source", { source_id: sourceId });
  assert.equal(research.sources().find(item => item.id === sourceId)?.status, "read");
  const fetches = research.fetches;
  await tool("read_source", { source_id: sourceId });
  assert.equal(research.fetches, fetches, "同轮后续读取必须复用缓存");
  const next = new Research(client, "继续", true, limits, () => `S${id++}`, research.sources());
  assert.ok(next.sources().length > 0 && next.sources().every(item => item.status === "unread" && item.retrievedAt === null));
  assert.deepEqual(next.evidence(), []);
  console.log("通过：真实Research状态、缓存和跨轮初始化；7个真实模型样本通过。");
} catch (error) {
  // Only assertion messages are ours; never log provider/config exception bodies.
  console.error(error instanceof assert.AssertionError ? `验收失败：${error.message}` : "真实验收未完成；检查前面的安全状态输出，密钥未输出。");
  process.exitCode = 1;
}
