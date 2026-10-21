import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatService } from "../../src/chat/service.ts";
import { ChatError } from "../../src/chat/types.ts";
import type { ChatModel, ModelReply, ModelRequest, SearchHit, SearchProvider, ToolCall } from "../../src/chat/types.ts";
import type { ServiceRequest } from "../../src/services.ts";

const request: ServiceRequest = { sessionId: "session", requestId: "r1", text: "解释这个概念" };
const signal = () => new AbortController().signal;
const raw = (content: string): ModelReply => ({ message: { role: "assistant", content }, finishReason: "stop" });
const answer = (content: string): ModelReply => raw(JSON.stringify({ action: "answer", answer: content }));
const ready = (): ModelReply => raw('{"action":"answer"}');
const clarify = (missing: string): ModelReply => raw(JSON.stringify({ action: "clarify", missing }));
const supplement = (missing: string): ModelReply => raw(JSON.stringify({ action: "supplement", missing }));
const call = (id: string, name: string, args: unknown): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const tools = (...calls: ToolCall[]): ModelReply => ({ message: { role: "assistant", content: "此轮是工具决策，不是最终回答", tool_calls: calls }, finishReason: "tool_calls" });
const hit = (url = "https://example.com/a", summary = "官方资料摘要"): SearchHit => ({ url, title: "官方资料", summary, publishedAt: "2026-10-20T00:00:00Z" });
function scripted(replies: ModelReply[]) {
  const requests: ModelRequest[] = [];
  const model: ChatModel = { async complete(value) {
    requests.push(structuredClone(value));
    const next = replies.shift();
    assert.ok(next, "unexpected extra model request");
    return next;
  } };
  return { model, requests };
}
function provider() {
  const searches: string[] = [];
  const fetches: string[] = [];
  const port: SearchProvider = {
    async search(query) { searches.push(query); return [hit(), hit("https://example.com/a#section")]; },
    async fetch(url) { fetches.push(url); return { title: "原文", content: "前文。关键条款：支持工具调用。后文。" }; },
  };
  return { port, searches, fetches };
}

test("direct answers, memory history, clear and same-request replay are isolated from delivery", async () => {
  const model = scripted([ready(), answer("这是一个概念。"), ready(), answer("继续解释。"), ready(), answer("新的对话。")]);
  const search = provider();
  const service = new ChatService(model.model, search.port);
  const first = await service.run(request, signal());
  assert.equal(first.status, "completed");
  first.answer = "caller mutation";
  const replay = await service.run(request, signal());
  assert.equal(replay.answer, "这是一个概念。");
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[0]?.thinking, "disabled");
  assert.equal(model.requests[1]?.thinking, "enabled");
  assert.equal(model.requests[1]?.tools.length, 0);
  await service.run({ ...request, requestId: "r2", text: "再解释一下" }, signal());
  assert.ok(model.requests[2]?.messages.some(message => message.content === "这是一个概念。"));
  assert.equal(service.clearSession("session"), true);
  await service.run({ ...request, requestId: "r3" }, signal());
  assert.ok(!model.requests[4]?.messages.some(message => message.content === "这是一个概念。"));
  const conflict = await service.run({ ...request, text: "不同问题" }, signal());
  assert.equal(conflict.status, "failed");
  assert.equal(search.searches.length + search.fetches.length, 0);
});

test("complete search → read → literal find → supplement → cited answer loop pairs every call", async () => {
  const search = provider();
  search.port.search = async query => { search.searches.push(query); return query === "补查" ? [hit("https://example.com/b", "第二份证据")] : [hit(), hit("https://example.com/a#fragment")]; };
  const model = scripted([
    tools(call("a", "search_web", { queries: ["初查", "初查"] })),
    tools(call("b", "read_source", { source_id: "S1" })),
    tools(call("c", "find_in_source", { source_id: "S1", pattern: "关键条款" }), call("d", "read_source", { source_id: "S1", offset: 0 })),
    tools(call("e", "search_web", { queries: ["补查"] })),
    ready(),
    answer("原文支持工具调用。[S1] 补充资料提供第二份证据。[S2]"),
  ]);
  const result = await new ChatService(model.model, search.port).run({ ...request, network: "required" }, signal());
  assert.equal(result.status, "completed");
  assert.deepEqual(search.searches, ["初查", "补查"]);
  assert.equal(search.fetches.length, 1);
  assert.deepEqual(result.usage, { modelCalls: 6, toolCalls: 5, searches: 2, fetches: 1 });
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0]?.status, "read");
  assert.ok(result.sources[0]?.retrievedAt);
  assert.ok(!("body" in (result.sources[0] ?? {})));
  assert.ok(model.requests.slice(0, -1).every(value => value.thinking === "disabled"));
  const finalRequest = model.requests.at(-1)!;
  assert.equal(finalRequest.thinking, "enabled");
  assert.equal(finalRequest.tools.length, 0);
  assert.ok(finalRequest.messages.every(message => message.role !== "tool" && !(message.role === "assistant" && message.tool_calls)));
  assert.ok(JSON.stringify(finalRequest.messages).includes("前文。关键条款：支持工具调用。后文。"));
  assert.ok(JSON.stringify(finalRequest.messages).includes("第二份证据"));
  assert.ok(!JSON.stringify(finalRequest.messages).includes("此轮是工具决策，不是最终回答"));
  const messages = model.requests.at(-2)!.messages;
  const calls = messages.flatMap(message => message.role === "assistant" ? message.tool_calls ?? [] : []);
  const replies = messages.filter(message => message.role === "tool");
  assert.deepEqual(replies.map(message => message.tool_call_id), calls.map(item => item.id));
  const found = replies.find(message => message.tool_call_id === "c");
  assert.ok(found?.content.includes("关键条款"));
});

test("user URLs can be read; prior-turn sources must be fetched again", async () => {
  const search = provider();
  const model = scripted([
    tools(call("a", "read_source", { source_id: "S1" })), ready(), answer("支持工具调用。[S1]"),
    tools(call("b", "read_source", { source_id: "S1" })), ready(), answer("重新读取原文后，仍支持。[S1]"),
  ]);
  const service = new ChatService(model.model, search.port);
  await service.run({ ...request, text: "阅读 https://example.com/a" }, signal());
  const next = await service.run({ ...request, requestId: "r2", text: "联网重新核实上一轮依据" }, signal());
  assert.equal(next.status, "completed");
  assert.equal(search.fetches.length, 2);
  assert.equal(next.sources[0]?.id, "S1");
});

test("offline policy disables tools and rejects an attempted search without external calls", async () => {
  const model = scripted([tools(call("a", "search_web", { queries: ["test"] })), ready(), answer("基于已有知识解释。")]);
  const search = provider();
  const result = await new ChatService(model.model, search.port).run({ ...request, network: "auto", text: "不要联网，解释概念" }, signal());
  assert.equal(result.status, "completed");
  assert.equal(model.requests[0]?.tools.length, 0);
  assert.equal(search.searches.length, 0);
  assert.equal(result.tools[0]?.status, "NETWORK_DISABLED");
});

test("invalid JSON, unknown tools, unknown sources and unread find are safe tool failures", async () => {
  const bad = call("a", "search_web", {});
  bad.function.arguments = "{";
  const model = scripted([
    tools(bad, call("b", "delete_file", {}), call("c", "read_source", { source_id: "S999" }), call("d", "find_in_source", { source_id: "S1", pattern: "x" })),
    ready(),
    answer("请提供需要核实的具体问题。"),
  ]);
  const search = provider();
  const result = await new ChatService(model.model, search.port).run({ ...request, text: "https://example.com/a 的资料" }, signal());
  assert.deepEqual(result.tools.map(record => record.status), ["INVALID_ARGUMENTS", "UNKNOWN_TOOL", "UNKNOWN_SOURCE", "READ_SOURCE_FIRST"]);
  assert.equal(search.searches.length + search.fetches.length, 0);
});

test("no evidence and invented references never escape as final draft", async () => {
  const model = scripted([clarify("具体问题"), answer("错误结论。[S999] https://invented.example/a"), answer("查过了，很确定。"), answer("仍然确定。")]);
  const result = await new ChatService(model.model, provider().port).run({ ...request, network: "required" }, signal());
  assert.equal(result.status, "limited");
  assert.ok(!result.answer.includes("很确定"));
  assert.ok(!result.answer.includes("invented"));
  assert.equal(result.usage.modelCalls, 4);
  assert.ok(model.requests.slice(1).every(value => value.thinking === "enabled" && !value.tools.length));
});

test("required search may ask for missing conditions without inventing evidence", async () => {
  const model = scripted([clarify("城市"), answer("请问你想查询哪座城市的天气？")]);
  const search = provider();
  const result = await new ChatService(model.model, search.port).run({ ...request, text: "搜索当地天气", network: "required" }, signal());
  assert.equal(result.status, "completed");
  assert.equal(result.sources.length, 0);
  assert.equal(search.searches.length, 0);
});

test("long sources expose truncation, page offsets and literal find scope", async () => {
  const search = provider();
  search.port.fetch = async () => ({ title: "长文", content: "a".repeat(9000) + "[literal.*]" + "b".repeat(32_000) });
  const model = scripted([
    tools(call("a", "read_source", { source_id: "S1" })),
    tools(call("b", "find_in_source", { source_id: "S1", pattern: "[literal.*]" })),
    tools(call("c", "read_source", { source_id: "S1", offset: 8900 })),
    ready(),
    answer("缓存正文包含指定文本。[S1]"),
  ]);
  const result = await new ChatService(model.model, search.port).run({ ...request, text: "阅读 https://example.com/a" }, signal());
  assert.equal(result.status, "completed");
  assert.equal(result.sources[0]?.truncated, true);
  const paired = model.requests.at(-2)!.messages.filter(message => message.role === "tool");
  assert.equal(JSON.parse(paired[0]!.content).nextOffset, 8000);
  assert.equal(JSON.parse(paired[1]!.content).matches[0].offset, 9000);
  assert.equal(JSON.parse(paired[1]!.content).truncated, true);
  assert.ok(JSON.parse(paired[2]!.content).content.includes("[literal.*]"));
});

test("output feedback allows targeted repair using real evidence", async () => {
  const model = scripted([tools(call("a", "search_web", { queries: ["test"] })), ready(), answer("结论。[S999]"), answer("有摘要依据的结论。[S1]")]);
  const result = await new ChatService(model.model, provider().port).run({ ...request, network: "required" }, signal());
  assert.equal(result.status, "completed");
  assert.ok(model.requests[3]?.messages.some(message => message.role === "system" && message.content.includes("来源ID")));
  assert.equal(model.requests[3]?.thinking, "enabled");
});

test("tool budget pairs skipped calls and reserves a no-tool final model request", async () => {
  const search = provider();
  const model = scripted([tools(call("a", "search_web", { queries: ["a"] }), call("b", "read_source", { source_id: "S1" })), answer("摘要能够确认的部分。[S1]")]);
  const result = await new ChatService(model.model, search.port, { maxTools: 1 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(search.fetches.length, 0);
  assert.equal(model.requests[1]?.tools.length, 0);
  assert.equal(model.requests[1]?.thinking, "enabled");
  assert.ok(JSON.stringify(model.requests[1]?.messages).includes("TOOL_BUDGET"));
});

test("search batch budgets are checked before issuing any request", async () => {
  const model = scripted([tools(call("a", "search_web", { queries: ["a", "b"] })), ready(), answer("没有执行超预算检索。")]);
  const search = provider();
  const result = await new ChatService(model.model, search.port, { maxSearches: 1 }).run(request, signal());
  assert.equal(search.searches.length, 0);
  assert.equal(result.tools[0]?.status, "SEARCH_BUDGET");
});

test("empty search and failed tools return to model; evidence is not fabricated", async () => {
  const search = provider();
  search.port.search = async () => [];
  search.port.fetch = async () => { throw new ChatError("REQUEST_TIMEOUT"); };
  const model = scripted([tools(call("a", "search_web", { queries: ["a"] }), call("b", "read_source", { source_id: "S1" })), ready(), answer("本轮没有取得资料。")]);
  const result = await new ChatService(model.model, search.port).run({ ...request, text: "https://example.com/a" }, signal());
  assert.equal(result.sources.length, 0);
  assert.equal(result.tools[1]?.status, "REQUEST_TIMEOUT");
  assert.ok(model.requests[1]?.messages.some(message => message.role === "tool" && message.content.includes('"empty":true')));
});

test("cancellation stops the loop, concurrent duplicates share execution, and other requests are busy", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const model: ChatModel = { async complete() { calls++; started(); return new Promise<ModelReply>(() => {}); } };
  const service = new ChatService(model, provider().port);
  const controller = new AbortController();
  const running = service.run(request, controller.signal);
  await ready;
  const duplicate = service.run(request, signal());
  const busy = await service.run({ ...request, requestId: "r2" }, signal());
  assert.equal(busy.status, "failed");
  assert.equal(service.clearSession("session"), false);
  controller.abort();
  assert.equal((await running).status, "cancelled");
  assert.equal((await duplicate).status, "cancelled");
  assert.equal(calls, 1);
});

test("time budget interrupts work and uses reserved closing time", async () => {
  let calls = 0;
  const model: ChatModel = { async complete(value) {
    calls++;
    if (calls === 1) return new Promise<ModelReply>(resolve => setTimeout(() => resolve(answer("迟到的答案")), 100));
    assert.equal(value.tools.length, 0);
    assert.equal(value.thinking, "enabled");
    return answer("本轮来不及完成核实。");
  } };
  const result = await new ChatService(model, provider().port, { maxDurationMs: 60, reserveMs: 30 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(calls, 2);
  assert.ok(!result.answer.includes("迟到"));
});

test("failed closing request is stopped by the total deadline", async () => {
  let calls = 0;
  const model: ChatModel = { async complete() {
    calls++;
    return new Promise<ModelReply>(resolve => setTimeout(() => resolve(answer("迟到")), 120));
  } };
  const result = await new ChatService(model, provider().port, { maxDurationMs: 70, reserveMs: 30 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.ok(result.limitations.some(note => note.includes("总时间")));
  assert.equal(calls, 2);
});

test("truncated function-call output never executes its tool batch", async () => {
  const reply = tools(call("a", "search_web", { queries: ["a"] }));
  reply.finishReason = "length";
  const search = provider();
  const model = scripted([reply, answer("本轮没有完成核实。")]);
  const result = await new ChatService(model.model, search.port).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(search.searches.length, 0);
  assert.equal(model.requests[1]?.thinking, "enabled");
});

test("model failure is readable, cached, and does not prevent the next request", async () => {
  let calls = 0;
  const service = new ChatService({ async complete(value) { if (++calls === 1) throw new Error("SECRET_RESPONSE_BODY"); return value.thinking === "disabled" ? ready() : answer("恢复正常。"); } }, provider().port);
  const failed = await service.run(request, signal());
  assert.equal(failed.status, "failed");
  assert.ok(!JSON.stringify(failed).includes("SECRET"));
  await service.run(request, signal());
  assert.equal(calls, 1);
  assert.equal((await service.run({ ...request, requestId: "r2" }, signal())).status, "completed");
});

test("planner prose is neither returned nor used as answer evidence", async () => {
  const draft = raw("未经核实的结论：FAKE_PLANNER_CLAIM");
  draft.message.reasoning_content = "PLANNER_PRIVATE_REASONING";
  const final = answer("最终独立回答。");
  final.message.reasoning_content = "ANSWER_PRIVATE_REASONING";
  const model = scripted([draft, ready(), final, ready(), answer("后续回答。")]);
  const service = new ChatService(model.model, provider().port);
  const result = await service.run(request, signal());
  assert.equal(result.answer, "最终独立回答。");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_REASONING"));
  assert.ok(!JSON.stringify(model.requests[2]).includes("FAKE_PLANNER_CLAIM"));
  assert.ok(!JSON.stringify(model.requests[2]).includes("PLANNER_PRIVATE_REASONING"));
  await service.run({ ...request, requestId: "r2", text: "继续" }, signal());
  assert.ok(!JSON.stringify(model.requests[3]).includes("PRIVATE_REASONING"));
});

test("required search repairs a premature decision before thinking answer", async () => {
  const search = provider();
  const model = scripted([ready(), tools(call("a", "search_web", { queries: ["官方说明"] })), ready(), answer("摘要说明。[S1]")]);
  const result = await new ChatService(model.model, search.port).run({ ...request, network: "required" }, signal());
  assert.equal(result.status, "completed");
  assert.equal(search.searches.length, 1);
  assert.equal(model.requests.at(-1)?.thinking, "enabled");
});

test("last available model call is reserved for thinking after search", async () => {
  const search = provider();
  const model = scripted([tools(call("a", "search_web", { queries: ["资料"] })), answer("已查到的摘要。[S1]")]);
  const result = await new ChatService(model.model, search.port, { maxModelCalls: 2 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(model.requests[1]?.thinking, "enabled");
  assert.ok(JSON.stringify(model.requests[1]?.messages).includes("官方资料摘要"));
  const direct = scripted([ready(), answer("不需要搜索的回答。")]);
  const completed = await new ChatService(direct.model, provider().port, { maxModelCalls: 2 }).run(request, signal());
  assert.equal(completed.status, "completed");
});

test("thinking answer cannot execute additional tools or fall back to a planner draft", async () => {
  const search = provider();
  const model = scripted([ready(), tools(call("a", "search_web", { queries: ["不应执行"] }))]);
  const result = await new ChatService(model.model, search.port).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(search.searches.length, 0);
  assert.ok(!result.answer.includes("此轮是工具决策"));
});

test("cancellation during thinking stops the task without returning a draft", async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const model: ChatModel = { async complete(value) {
    if (value.thinking === "disabled") return ready();
    started();
    return new Promise<ModelReply>(() => {});
  } };
  const controller = new AbortController();
  const pending = new ChatService(model, provider().port).run(request, controller.signal);
  await waiting;
  controller.abort();
  assert.equal((await pending).status, "cancelled");
});

test("thinking output truncation is repaired with thinking still enabled", async () => {
  const truncated = answer("未完成的回答");
  truncated.finishReason = "length";
  const model = scripted([ready(), truncated, answer("完整回答。")]);
  const result = await new ChatService(model.model, provider().port).run(request, signal());
  assert.equal(result.answer, "完整回答。");
  assert.ok(model.requests.slice(1).every(value => value.thinking === "enabled" && !value.tools.length));
});

test("thinking can return one evidence gap to research, then answer from both rounds without leaking control or reasoning", async () => {
  const search = provider();
  search.port.search = async query => {
    search.searches.push(query);
    return [query === "购买价格" ? hit() : hit("https://example.com/b", "订阅费摘要")];
  };
  search.port.fetch = async url => { search.fetches.push(url); return { title: "费用原文", content: "订阅费每年100元。" }; };
  const gap = supplement("核实两家的订阅费和维护费");
  gap.message.reasoning_content = "PRIVATE_GAP_REASONING";
  const model = scripted([
    tools(call("a", "search_web", { queries: ["购买价格"] })), ready(), gap,
    tools(call("b", "search_web", { queries: ["订阅 维护 费用"] })),
    tools(call("c", "read_source", { source_id: "S2" })), ready(),
    answer("购买价见摘要。[S1] 订阅费每年100元，维护费尚未核实。[S2]"),
    ready(), answer("沿用前面的比较思路。"),
  ]);
  const service = new ChatService(model.model, search.port);
  const result = await service.run({ ...request, network: "required" }, signal());
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, { modelCalls: 7, toolCalls: 3, searches: 2, fetches: 1 });
  assert.deepEqual(model.requests.map(value => value.thinking), ["disabled", "disabled", "enabled", "disabled", "disabled", "disabled", "enabled"]);
  assert.ok(model.requests.filter(value => value.thinking === "enabled").every(value => !value.tools.length));
  assert.ok(JSON.stringify(model.requests[3]?.messages).includes("核实两家的订阅费和维护费"));
  const finalContext = JSON.stringify(model.requests[6]?.messages);
  assert.ok(finalContext.includes("官方资料摘要") && finalContext.includes("订阅费每年100元。"));
  assert.ok(!finalContext.includes("此轮是工具决策"));
  assert.ok(!JSON.stringify(model.requests).includes("PRIVATE_GAP_REASONING"));
  assert.equal(result.sources.length, 2);
  assert.ok(!result.answer.includes('"action"'));
  assert.deepEqual(await service.run({ ...request, network: "required" }, signal()), result);
  assert.equal(search.searches.length, 2);
  await service.run({ ...request, requestId: "r2", text: "继续说明" }, signal());
  const history = model.requests[7]!.messages.filter(message => message.role === "assistant");
  assert.deepEqual(history.map(message => message.content), [result.answer]);
});

test("thinking can correct an initial decision to skip research", async () => {
  const search = provider();
  const model = scripted([ready(), supplement("需要核实当前版本"),
    tools(call("a", "search_web", { queries: ["当前版本"] })), ready(), answer("版本说明见来源。[S1]")]);
  const result = await new ChatService(model.model, search.port).run(request, signal());
  assert.equal(result.status, "completed");
  assert.equal(search.searches.length, 1);
  assert.equal(model.requests[2]?.thinking, "disabled");
  assert.equal(model.requests[4]?.thinking, "enabled");
});

test("a second supplement request cannot reopen research", async () => {
  const search = provider();
  const model = scripted([ready(), supplement("版本"), tools(call("a", "search_web", { queries: ["版本"] })), ready(),
    supplement("发布日期"), answer("目前只核实了版本说明，发布日期尚不确定。[S1]")]);
  const result = await new ChatService(model.model, search.port).run(request, signal());
  assert.equal(result.status, "limited");
  assert.deepEqual(search.searches, ["版本"]);
  assert.ok(result.limitations.some(note => note.includes("机会已使用")));
  assert.ok(JSON.stringify(model.requests[4]?.messages).includes("补查可用：否"));
  assert.equal(model.requests[5]?.thinking, "enabled");
});

test("supplement requests respect both explicit and textual offline policy", async () => {
  for (const input of [{ ...request, network: "off" as const }, { ...request, text: "不要联网，解释这个概念" }]) {
    const search = provider();
    const model = scripted([ready(), supplement("最新资料"), answer("未联网核实，只能基于已有信息解释。")]);
    const result = await new ChatService(model.model, search.port).run(input, signal());
    assert.equal(result.status, "limited");
    assert.equal(search.searches.length + search.fetches.length, 0);
    assert.ok(JSON.stringify(model.requests[1]?.messages).includes("补查可用：否"));
    assert.ok(result.limitations.some(note => note.includes("禁止联网")));
  }
});

test("supplement and final answer share the original model budget", async () => {
  for (const maxModelCalls of [2, 3, 4]) {
    const search = provider();
    const replies = [ready(), supplement("需要版本资料")];
    if (maxModelCalls === 4) replies.push(tools(call("a", "search_web", { queries: ["版本"] })));
    if (maxModelCalls > 2) replies.push(answer(maxModelCalls === 4 ? "版本资料。[S1]" : "预算不足，未核实版本。"));
    const model = scripted(replies);
    const result = await new ChatService(model.model, search.port, { maxModelCalls }).run(request, signal());
    assert.equal(result.status, "limited");
    assert.equal(result.usage.modelCalls, maxModelCalls);
    assert.equal(search.searches.length, maxModelCalls === 4 ? 1 : 0);
    assert.equal(model.requests.at(-1)?.thinking, "enabled");
    assert.ok(!result.answer.includes('"action"'));
  }
});

test("supplement does not reset tool or search budgets", async () => {
  const search = provider();
  const model = scripted([tools(call("a", "search_web", { queries: ["初查"] })), supplement("需补充发布日期"), answer("目前只有初查摘要。[S1]")]);
  const result = await new ChatService(model.model, search.port, { maxTools: 1 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(search.searches.length, 1);
  assert.equal(result.usage.toolCalls, 1);
  const capped = scripted([tools(call("a", "search_web", { queries: ["初查"] })), ready(), supplement("发布日期"),
    tools(call("b", "search_web", { queries: ["发布日期"] })), ready(), answer("补查受限，只能确认初查摘要。[S1]")]);
  const limited = await new ChatService(capped.model, provider().port, { maxSearches: 1 }).run(request, signal());
  assert.equal(limited.status, "limited");
  assert.equal(limited.usage.searches, 1);
  assert.equal(limited.tools[1]?.status, "SEARCH_BUDGET");
});

test("supplement eligibility is rechecked when thinking uses the remaining research time", async () => {
  const search = provider();
  let calls = 0;
  const model: ChatModel = { async complete(value) {
    if (++calls === 1) return ready();
    if (calls === 2) {
      assert.equal(value.thinking, "enabled");
      assert.ok(JSON.stringify(value.messages).includes("补查可用：是"));
      await new Promise(resolve => setTimeout(resolve, 160));
      return supplement("资料缺口");
    }
    assert.equal(value.thinking, "enabled");
    return answer("时间不足，关键资料尚未核实。");
  } };
  const result = await new ChatService(model, search.port, { maxDurationMs: 320, reserveMs: 180 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(calls, 3);
  assert.equal(search.searches.length, 0);
  assert.ok(result.limitations.some(note => note.includes("剩余预算不足")));
});

test("supplement timeout preserves the original final-answer reserve", async () => {
  const search = provider();
  search.port.search = async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
    return [hit()];
  };
  const model = scripted([ready(), supplement("资料缺口"), tools(call("a", "search_web", { queries: ["资料"] })), answer("补查超时，尚未核实。")]);
  const result = await new ChatService(model.model, search.port, { maxDurationMs: 240, reserveMs: 120 }).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(result.usage.modelCalls, 4);
  assert.equal(result.sources.length, 0);
  assert.ok(JSON.stringify(model.requests[3]?.messages).includes("TIME_BUDGET"));
  assert.equal(model.requests[3]?.thinking, "enabled");
});

test("empty or failed supplementary search is returned to thinking with an explicit limitation", async () => {
  for (const fail of [false, true]) {
    const search = provider();
    search.port.search = async () => { if (fail) throw new Error("SECRET_PROVIDER_BODY"); return []; };
    const model = scripted([ready(), supplement("发布日期"), tools(call("a", "search_web", { queries: ["发布日期"] })), ready(), answer("本轮补查未取得资料，发布日期仍未核实。")]);
    const result = await new ChatService(model.model, search.port).run(request, signal());
    assert.equal(result.status, "limited");
    assert.equal(result.sources.length, 0);
    assert.ok(result.limitations.some(note => note.includes("失败或空结果")));
    assert.ok(!JSON.stringify([result, model.requests]).includes("SECRET_PROVIDER_BODY"));
    assert.ok(JSON.stringify(model.requests[4]?.messages).includes(fail ? "SEARCH_FAILED" : 'empty'));
  }
});

test("failed supplement planner still closes with thinking and does not expose its error body", async () => {
  let calls = 0;
  const model: ChatModel = { async complete(value) {
    if (++calls === 1) return ready();
    if (calls === 2) return supplement("关键事实");
    if (calls === 3) throw new Error("SECRET_MODEL_BODY");
    assert.equal(value.thinking, "enabled");
    return answer("补查失败，现有资料不足以判断。");
  } };
  const result = await new ChatService(model, provider().port).run(request, signal());
  assert.equal(result.status, "limited");
  assert.equal(result.usage.modelCalls, 4);
  assert.ok(!JSON.stringify(result).includes("SECRET_MODEL_BODY"));
  assert.ok(result.limitations.some(note => note.includes("补充检索未完成")));
});

test("malformed or truncated answer controls cannot trigger research or leak as user answers", async () => {
  const invalid = [
    raw('{"action":"supplement","missing":""}'),
    raw('{"action":"supplement","missing":"核实","answer":"同时回答"}'),
    raw('{"action":"supplement","missing":'),
    raw('```json\n{"action":"supplement","missing":"核实"}\n```'),
    supplement("长".repeat(601)),
    { ...supplement("被截断的请求"), finishReason: "length" as const },
    raw("未遵循协议的答案"),
  ];
  for (const bad of invalid) {
    const search = provider();
    const model = scripted([ready(), bad, answer("修正后的答复。")]);
    const result = await new ChatService(model.model, search.port).run(request, signal());
    assert.equal(result.answer, "修正后的答复。");
    assert.equal(search.searches.length + search.fetches.length, 0);
    assert.equal(model.requests[2]?.thinking, "enabled");
  }
});

test("cancellation during supplementary search starts no final call and duplicate replay performs no work", async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const search = provider();
  search.port.search = async () => { started(); return new Promise<SearchHit[]>(() => {}); };
  const model = scripted([ready(), supplement("事实缺口"), tools(call("a", "search_web", { queries: ["资料"] }))]);
  const service = new ChatService(model.model, search.port);
  const controller = new AbortController();
  const pending = service.run(request, controller.signal);
  await waiting;
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.usage.modelCalls, 3);
  assert.deepEqual(await service.run(request, signal()), result);
  assert.equal(model.requests.length, 3);
});
