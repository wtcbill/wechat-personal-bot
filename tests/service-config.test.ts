import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_SERVICE_CONFIG, parseServiceConfig } from "../src/service-config.ts";

describe("API configuration schema", () => {
  it("keeps the committed example free of keys and supports independent models", () => {
    const sample = JSON.parse(readFileSync(new URL("../services.config.example.json", import.meta.url), "utf8")) as unknown;
    expect(parseServiceConfig(sample)).toEqual(DEFAULT_SERVICE_CONFIG);
    expect(parseServiceConfig({ router: { model: "router-model" }, chat: { model: "answer-model" } })).toMatchObject({
      router: { model: "router-model", apiKeyEnv: "WEAVE_ROUTER_API_KEY" }, chat: { model: "answer-model", apiKeyEnv: "WEAVE_CHAT_API_KEY" },
    });
  });

  it("parses shared and role-specific key fields without changing defaults", () => {
    const value = parseServiceConfig({ apiKey: "  local-key  ", router: { apiKey: "router-key" } });
    expect(value.apiKey).toBe("local-key"); expect(value.router.apiKey).toBe("router-key");
    expect(DEFAULT_SERVICE_CONFIG.apiKey).toBe("");
  });

  it.each([null, [], { token: "secret" }, { apiKey: 123 }, { router: { apiKey: "bad\nkey" } }, { chat: { provider: "unknown" } },
    { router: { requestTimeoutMs: -1 } }, { chat: { apiKeyEnv: "invalid-name" } }, { router: { model: "bad/model" } }])(
    "rejects malformed fields %#", raw => { expect(() => parseServiceConfig(raw)).toThrow(); });
});
