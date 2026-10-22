/**
 * L3 — Explicit real-API acceptance check, never part of offline npm test.
 * Input: local API configuration and three fixed public validation prompts.
 * Output: actual chat/search/fetch status, final answers and pass/fail summary.
 * Pos: live verification entry; see ./L2.md and README.
 * Effects/Dependencies: calls configured DeepSeek APIs and uses their account
 * quota; no fake model/HTTP, no file writes, key/header/body/think-trace logging.
 */
import { randomUUID } from "node:crypto";
import { buildServices } from "./service-bootstrap.ts";

const http: { path: string; status: number; thinking: string | null }[] = [];
const actualFetch: typeof fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as { thinking?: { type?: string } } : {};
  const response = await globalThis.fetch(url, init);
  http.push({ path, status: response.status, thinking: body.thinking?.type ?? null });
  console.log(`HTTP ${response.status} ${path}`);
  return response;
};

try {
  const router = await buildServices(event => console.log(event), { fetch: actualFetch });
  const sessionId = randomUUID();
  const cases = [
    { name: "直接问答", text: "把“明天见”翻译成日语，只输出翻译。", search: false },
    { name: "连续追问", text: "上一条的日语，再给一种更口语的说法。", search: false },
    { name: "搜索与原文读取", text: "请先联网搜索 DeepSeek 官方思考模式文档，再读取 https://api-docs.deepseek.com/guides/thinking_mode/ 原文。简要说明 API 中开启和关闭思考的参数，并引用来源。", search: true },
  ];
  for (const test of cases) {
    const offset = http.length;
    const value = await router.run({ sessionId, requestId: randomUUID(), text: test.text }, AbortSignal.timeout(150_000));
    const calls = http.slice(offset);
    const passed = value.status === "completed" && Boolean(value.answer.trim()) &&
      calls.some(call => call.path === "/chat/completions" && call.thinking === "enabled" && call.status === 200) &&
      (!test.search || (calls.some(call => call.path === "/v1/tools/search" && call.status === 200) &&
        calls.some(call => call.path === "/v1/tools/fetch" && call.status === 200) &&
        value.sources.some(source => source.status === "read") && /\[S\d+\]/.test(value.answer)));
    console.log(`${passed ? "通过" : "失败"}：${test.name}；status=${value.status}，sources=${value.sources.length}`);
    console.log(value.answer);
    if (!passed) { process.exitCode = 1; break; }
  }
} catch {
  console.error("真实 API 验收未完成，请检查本机配置与前面的安全状态输出；密钥未输出。");
  process.exitCode = 1;
}
