import { describe, expect, it } from "vitest";
import { parseDecision } from "../src/router/types.ts";

describe("routing JSON validation", () => {
  it("parses only the declared decision contracts", () => {
    expect(parseDecision('{"action":"dispatch","serviceId":"chat","session":"continue"}'))
      .toEqual({ action: "dispatch", serviceId: "chat", session: "continue" });
    expect(parseDecision({ action: "clarify", question: "哪项任务？" })).toEqual({ action: "clarify", question: "哪项任务？" });
    expect(parseDecision({ action: "unsupported", reason: "执行服务未接入" })).toEqual({ action: "unsupported", reason: "执行服务未接入" });
  });

  it.each([null, [], "not JSON", { action: "dispatch", serviceId: "chat", session: "other" },
    { action: "dispatch", serviceId: "chat", session: "continue", command: "extra" }, { action: "clarify", question: "" }])(
    "rejects malformed decisions %#", raw => { expect(parseDecision(raw)).toBeNull(); });

  it.each(["new", "continue"])("accepts the literal session %s in JSON and objects", session => {
    const raw = { action: "dispatch", serviceId: "chat", session };
    expect(parseDecision(raw)).toEqual(raw);
    expect(parseDecision(JSON.stringify(raw))).toEqual(raw);
  });

  it.each([
    ["new"], ["continue"], [["new"]], [["continue"]], [], {}, { session: "new" },
    null, 0, 1, true, false, undefined, "", "other", "NEW", "new ",
  ].map(session => ({ session })))("rejects nonliteral session %# in JSON and objects", ({ session }) => {
    const raw = { action: "dispatch", serviceId: "chat", ...(session === undefined ? {} : { session }) };
    expect(parseDecision(raw)).toBeNull();
    expect(parseDecision(JSON.stringify(raw))).toBeNull();
  });
});
