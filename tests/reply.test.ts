import { describe, expect, it } from "vitest";
import { formatReply } from "../src/reply.ts";
import type { ServiceResult } from "../src/services.ts";

const result = (answer = "答案"): ServiceResult => ({ status: "completed", answer, sources: [], limitations: [] });

describe("reply formatting", () => {
  it("keeps evidence internal and distinct limitations with Unicode-safe part boundaries", () => {
    const value = result("😀".repeat(70) + "[S1]");
    value.sources = [{ id: "S1", title: "资料", url: "https://example.com", publishedAt: null, retrievedAt: null,
      excerpt: "", status: "read", truncated: false }];
    value.limitations = ["尚未核实", "尚未核实"];
    const parts = formatReply(value, 32);
    expect(parts.every(part => Array.from(part).length <= 32)).toBe(true);
    expect(parts.join("")).not.toContain("[S1]");
    expect(parts.join("")).not.toContain("https://example.com");
    expect(parts.join("")).not.toContain("资料");
    expect(parts.join("").match(/限制：尚未核实/g)).toHaveLength(1);
    expect(parts.join("").startsWith("😀".repeat(70))).toBe(true);
    expect(value.answer).toContain("[S1]");
    expect(value.sources).toHaveLength(1);
  });

  it("preserves a link explicitly included in the requested answer", () => {
    const value = result("官方文档：https://example.com [S1]");
    value.sources = [{ id: "S1", title: "资料", url: "https://example.com", publishedAt: null, retrievedAt: null,
      excerpt: "", status: "read", truncated: false }];
    expect(formatReply(value)).toEqual(["官方文档：https://example.com"]);
  });

  it("rejects unsafe source URLs", () => {
    const value = result();
    value.sources = [{ id: "S1", title: "资料", url: "https://user:secret@example.com", publishedAt: null, retrievedAt: null,
      excerpt: "", status: "read", truncated: false }];
    expect(() => formatReply(value)).toThrow();
  });
});
