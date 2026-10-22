import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/chat/deepseek.ts";
import { Research } from "../src/chat/research.ts";
import { outputProblems } from "../src/chat/service.ts";
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
    expect(outputProblems("请提供需要查询的城市？", [], "required")).toEqual([]);
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
