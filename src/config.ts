import { readFileSync } from "node:fs";
import { z } from "zod";
import { IcpSchema, type Icp } from "./schemas.ts";

const optional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4102),
  HOST: z.string().default("127.0.0.1"),
  /** Only "true" enables X-Forwarded-For; anything else is rejected rather than silently ignored. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  API_KEY: optional,
  ANTHROPIC_API_KEY: optional,
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_FALLBACKS: z.enum(["default", "off"]).default("default"),
  DATABASE_PATH: z.string().default("./data/leads.db"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(512 * 1024),
  ICP_FILE: z.string().default("./config/icp.json"),
  HUNTER_API_KEY: optional,
  HUNTER_MIN_GAP_MS: z.coerce.number().int().min(0).default(250),
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  OUTREACH_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(60),
  SENDER_NAME: z.string().default("Your Name"),
  SENDER_COMPANY: z.string().default("Your Company"),
  SENDER_OFFER: z.string().default("a short description of what you offer"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/** Loads the ICP from ICP_FILE, falling back to config/icp.example.json. */
export function loadIcp(path: string): { icp: Icp; source: string } {
  for (const candidate of [path, "./config/icp.example.json"]) {
    try {
      return { icp: IcpSchema.parse(JSON.parse(readFileSync(candidate, "utf8"))), source: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid ICP file ${candidate}: ${(err as Error).message}`);
    }
  }
  throw new Error("No ICP file found. Copy config/icp.example.json to config/icp.json.");
}
