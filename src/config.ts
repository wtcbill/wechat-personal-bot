/**
 * L3 — Local probe configuration.
 * Input: optional project-root config.local.json.
 * Output: validated timeouts and a fixed project-local state directory.
 * Pos: startup configuration; see ./L2.md.
 * Effects/Dependencies: reads configuration only, no network or writes.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isRecord } from "./weixin/api.ts";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const DATA_DIRECTORY = fileURLToPath(new URL("../.weave/", import.meta.url));
export interface Config { pollTimeoutMs: number; requestTimeoutMs: number }

export async function loadConfig(): Promise<Config> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) throw new Error("请使用 Node.js 24 LTS 运行 Weave。");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(new URL("../config.local.json", import.meta.url), "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = {};
    else throw new Error("config.local.json 无法解析。");
  }
  if (!isRecord(raw) || Object.keys(raw).some(key => !["pollTimeoutMs", "requestTimeoutMs"].includes(key))) {
    throw new Error("配置含未知字段，请参考 config.example.json。");
  }
  const config: Config = { pollTimeoutMs: 35_000, requestTimeoutMs: 15_000 };
  for (const key of ["pollTimeoutMs", "requestTimeoutMs"] as const) {
    if (raw[key] !== undefined) {
      const value = raw[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > 120_000) {
        throw new Error(`${key} 必须是 1000～120000 之间的整数毫秒。`);
      }
      config[key] = value;
    }
  }
  return config;
}
