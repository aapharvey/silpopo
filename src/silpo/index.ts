import type { Env, SilpoSource } from "../types";
import { MockSilpoSource } from "./mock";
import { SilpoMcpSource } from "./mcp";

export function silpoSource(env: Env): SilpoSource {
  return env.SILPO_MODE === "mcp" ? new SilpoMcpSource(env) : new MockSilpoSource(env.TIMEZONE);
}
