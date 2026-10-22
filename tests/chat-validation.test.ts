import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/chat/deepseek.ts";
import { Research } from "../src/chat/research.ts";
import { answerDecision, outputProblems } from "../src/chat/service.ts";
import type { AnswerSource } from "../src/services.ts";

const source: AnswerSource = {
  id: "S1", url: "https://example.com/help?lang=zh", title: "Help", status: "read",
  publishedAt: null, retrievedAt: "2026-10-23T00:00:00Z", excerpt: "Setup instructions", truncated: false,
};

describe("answer URL ownership", () => {
  it.each(["", "#setup", "#安装"])("accepts an acquired page with fragment %s without rewriting the answer", fragment => {
    const answer = `说明 [S1]：https://example.com/help?lang=zh${fragment}。`;
    expect(outputProblems(answer, [source], "auto")).toEqual([]);
    expect(answer).toContain(`?lang=zh${fragment}`);
  });

  it.each([
    "https://example.com/other?lang=zh#setup",
    "https://example.com/help?lang=en#setup",
    "https://other.example/help?lang=zh#setup",
    "http://example.com/help?lang=zh#setup",
    "https://example.com/help#setup",
  ])("rejects an unacquired page %s", url => {
    expect(outputProblems(`说明 [S1]：${url}`, [source], "auto")).toContain("链接不属于本轮已获取来源");
  });

  it("still requires acquired evidence and valid source IDs", () => {
    expect(outputProblems("https://example.com/help?lang=zh#setup", [], "auto"))
      .toContain("链接不属于本轮已获取来源");
    expect(outputProblems("说明 [S2]：https://example.com/help?lang=zh#setup", [source], "auto"))
      .toContain("引用了本轮没有取得资料的来源ID");
    expect(outputProblems("https://example.com/help?lang=zh#setup", [source], "auto"))
      .toContain("使用了外部资料却缺少来源ID引用");
    expect(outputProblems("尚未核实", [], "required").length).toBeGreaterThan(0);
    expect(outputProblems("请提供需要查询的城市？", [], "required", "clarify")).toEqual([]);
  });
});

describe("structured clarifications", () => {
  it.each([
    "你在哪个城市？", "需要先确定地点。告诉我城市名称即可。", "城市名称", "Where are you located?", "Tell me the city.",
  ])("accepts a clarification independent of phrasing: %s", answer => {
    const parsed = answerDecision(JSON.stringify({ action: "clarify", answer }));
    expect(parsed).toEqual({ action: "clarify", answer });
    expect(outputProblems(answer, [], "required", "clarify")).toEqual([]);
    expect(outputProblems(answer, [source], "required", "clarify")).toEqual([]);
  });

  it.each([
    { action: "clarify", answer: "" }, { action: "clarify", answer: "   " },
    { action: "clarify", answer: "问".repeat(301) }, { action: "clarify", answer: ["城市"] },
    { action: "clarify", question: "城市？" }, { action: "clarify", answer: "城市？", extra: true },
  ])("rejects malformed clarification %#", raw => {
    expect(answerDecision(JSON.stringify(raw))).toBeNull();
  });

  it("preserves answer/supplement decisions and trims clarification whitespace", () => {
    expect(answerDecision('{"action":"answer","answer":"回答"}')).toEqual({ action: "answer", answer: "回答" });
    expect(answerDecision('{"action":"supplement","missing":"事实"}')).toEqual({ action: "supplement", missing: "事实" });
    expect(answerDecision('{"action":"clarify","answer":"  城市？  "}')).toEqual({ action: "clarify", answer: "城市？" });
    expect(answerDecision(JSON.stringify({ action: "clarify", answer: "问".repeat(300) }))?.action).toBe("clarify");
  });

  it("does not let question-like answers bypass required evidence or citation checks", () => {
    expect(outputProblems("请提供需要查询的城市？", [], "required").length).toBeGreaterThan(0);
    expect(outputProblems("Where are you located?", [], "required", "answer").length).toBeGreaterThan(0);
    expect(outputProblems("查询结果", [source], "required", "answer")).toContain("使用了外部资料却缺少来源ID引用");
    expect(outputProblems("结论 [S1]", [source], "required", "answer")).toEqual([]);
  });

  it("still validates source IDs, URLs and size on clarification decisions", () => {
    expect(outputProblems("请确认 [S2]", [source], "required", "clarify")).toContain("引用了本轮没有取得资料的来源ID");
    expect(outputProblems("请看 https://other.example/", [source], "required", "clarify"))
      .toContain("链接不属于本轮已获取来源");
    expect(outputProblems("问".repeat(301), [], "required", "clarify")).toContain("回答为空或过长");
  });
});

describe("research catalog", () => {
  it("projects all four actual statuses without mutating source snapshots", () => {
    const sources = (["unread", "summary", "read", "failed"] as const)
      .map((status, index) => ({ ...source, id: `S${index + 1}`, status }));
    const before = structuredClone(sources);
    // Exercise the real pure projection on source data, with no model/provider/HTTP.
    const catalog = Research.prototype.catalog.call({ sources: () => sources } as Research);
    expect(JSON.parse(catalog)).toEqual(sources.map(({ id, url, title, status }) => ({ id, url, title, status })));
    expect(sources).toEqual(before);
  });

  it("starts prior-turn sources unread, excludes old evidence and blocks off tools", async () => {
    // The real adapter is never invoked: off rejects tools before provider I/O.
    const client = new DeepSeekClient({ apiKey: "offline-test-placeholder" });
    const research = new Research(client, "搜索 https://example.com/new#setup", false,
      { maxTools: 4, maxSearches: 2, maxFetches: 2, maxSources: 10 }, () => "S2", [source]);
    expect(JSON.parse(research.catalog())).toEqual([
      { id: "S1", url: source.url, title: source.title, status: "unread" },
      { id: "S2", url: "https://example.com/new", title: "https://example.com/new", status: "unread" },
    ]);
    expect(research.evidence()).toEqual([]);
    const signal = new AbortController().signal;
    for (const [name, args] of [
      ["search_web", { queries: ["搜索算法"] }], ["read_source", { source_id: "S1" }],
    ] as const) {
      const result = JSON.parse(await research.execute({ id: name, type: "function",
        function: { name, arguments: JSON.stringify(args) } }, signal));
      expect(result.error).toBe("NETWORK_DISABLED");
    }
    expect(research.searches).toBe(0);
    expect(research.fetches).toBe(0);
    expect(research.sources().every(item => item.status === "unread" && item.retrievedAt === null)).toBe(true);
    expect(source.status).toBe("read");
  });
});
