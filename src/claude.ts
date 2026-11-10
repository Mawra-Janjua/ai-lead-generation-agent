// Thin wrapper around the official Anthropic SDK for schema-validated
// (structured-output) calls. Every response is parsed against a Zod schema;
// refusals, truncation and API failures surface as typed errors — never as
// made-up "successful" data.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { HttpError } from "./http.ts";

export type ClaudeSettings = {
  apiKey?: string;
  model: string;
  /** "default" enables Anthropic's server-side refusal fallback routing. */
  fallbacks: "default" | "off";
  timeoutMs?: number;
  /** Override the API base URL (used by integration tests against a local mock). */
  baseURL?: string;
};

export type StructuredRequest<S extends z.ZodType> = {
  system: string;
  user: string;
  schema: S;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
};

export type StructuredResult<T> = {
  data: T;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
};

export class AIServiceError extends HttpError {}

export class ClaudeClient {
  private client: Anthropic;
  private settings: ClaudeSettings;

  constructor(settings: ClaudeSettings) {
    this.settings = settings;
    this.client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      timeout: settings.timeoutMs ?? 120_000,
      maxRetries: 3, // SDK retries 408/409/429/5xx with exponential backoff
    });
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.settings.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort ?? "medium" },
        ...(this.settings.fallbacks === "default"
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (response.stop_reason === "refusal") {
      throw new AIServiceError(422, "ai_refused", "Claude declined to process this input.", {
        category: response.stop_details?.category ?? null,
      });
    }
    if (response.stop_reason === "max_tokens") {
      throw new AIServiceError(502, "ai_truncated", "Claude's response was truncated; try a shorter input.");
    }
    if (!response.parsed_output) {
      throw new AIServiceError(502, "ai_invalid_output", "Claude returned output that did not match the expected schema.");
    }
    return {
      data: response.parsed_output as z.infer<S>,
      model: response.model,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    };
  }
}

export function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AIServiceError(502, "ai_auth_failed", "Claude API authentication failed. Check ANTHROPIC_API_KEY.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AIServiceError(503, "ai_rate_limited", "Claude API rate limit reached. Retry shortly.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AIServiceError(502, "ai_bad_request", `Claude API rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AIServiceError(503, "ai_unreachable", "Could not reach the Claude API.");
  }
  if (err instanceof Anthropic.APIError) {
    return new AIServiceError(502, "ai_error", `Claude API error (${err.status ?? "unknown"}).`);
  }
  // The SDK's structured-output parser throws a plain AnthropicError when the
  // model's JSON is malformed or cut off (e.g. max_tokens reached).
  if (err instanceof Anthropic.AnthropicError && /parse structured output/i.test(err.message)) {
    return new AIServiceError(502, "ai_invalid_output", "Claude returned output that could not be parsed (possibly truncated). Try a shorter input.");
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Wraps untrusted text so the model treats it as data, not instructions. */
export function asData(tag: string, text: string) {
  const safe = text.replaceAll(`</${tag}>`, `<\\/${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
