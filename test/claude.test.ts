// Real Anthropic SDK against a local mock Messages API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeClient } from "../src/claude.ts";
import { ClaudeLeadAI, leadFacts, tierFor } from "../src/ai.ts";
import { icpSignals, normalizeLead } from "../src/normalize.ts";
import { RawLeadSchema, ScoreSchema } from "../src/schemas.ts";
import type { HttpError } from "../src/http.ts";
import { closeServer, icp, lead } from "./helpers.ts";

async function mockApi(replies: unknown[]) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(replies.shift()) }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => closeServer(server) };
}

const ctxFor = (i: number) => {
  const l = normalizeLead(RawLeadSchema.parse(lead(i))).lead!;
  return { lead: l, enrichment: null, signals: icpSignals(l, icp) };
};

test("score request carries ICP, signals and only supplied facts; output is clamped", async () => {
  const api = await mockApi([{ score: 140, tier: "B", reasons: ["Logistics, 240 staff"], risks: [], missing_data: [] }]);
  try {
    const ai = new ClaudeLeadAI(new ClaudeClient({ apiKey: "k", model: "claude-opus-5-5", fallbacks: "default", baseURL: api.baseURL }));
    const s = await ai.score(ctxFor(0), icp);
    assert.equal(s.score, 100);
    assert.equal(s.tier, "A", "tier re-derived from the clamped score");
    const body = api.bodies[0];
    assert.equal(body.output_config.effort, "low");
    assert.match(body.messages[0].content, /<icp>[\s\S]*Mid-market logistics/);
    assert.match(body.messages[0].content, /"industryMatch":true/);
    assert.doesNotMatch(body.messages[0].content, /sarah\.khan@/, "email address is not sent to the model");
    assert.match(body.system, /Never assume or invent facts/);
  } finally {
    await api.close();
  }
});

test("outreach drops personalization that cites fields the lead does not have", async () => {
  const api = await mockApi([
    {
      subject: "Order-status emails at BrightCart",
      body: "Hi Daniel, ...",
      personalization: [
        { point: "BrightCart", source_field: "company" },
        { point: "recent funding round", source_field: "enrichment.description" },
      ],
    },
  ]);
  try {
    const ai = new ClaudeLeadAI(new ClaudeClient({ apiKey: "k", model: "claude-opus-5-5", fallbacks: "off", baseURL: api.baseURL }));
    const o = await ai.outreach(ctxFor(1), icp, { name: "Mawra", company: "X", offer: "automation" });
    assert.deepEqual(o.personalization, [{ point: "BrightCart", source_field: "company" }]);
    assert.ok(api.bodies[0].output_config.format.schema.properties.personalization);
  } finally {
    await api.close();
  }
});

test("leadFacts omits empty fields and tierFor keeps exclusion-driven D", () => {
  const facts = leadFacts(ctxFor(1));
  assert.ok(!("enrichment.industry" in facts));
  assert.equal(facts.company, "BrightCart");
  assert.equal(tierFor(85, "D"), "D");
  assert.equal(tierFor(65, "A"), "B");
});

// ---- Error mapping: every failure surfaces as a typed HttpError, never as data ----

type Raw = { status?: number; body?: unknown; delayMs?: number };

async function rawApi(reply: Raw) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    for await (const _ of req);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.statusCode = reply.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    close: () => (server.closeAllConnections(), closeServer(server)),
  };
}

const message = (stop_reason: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 }, ...extra,
});
const apiError = (type: string, msg: string) => ({ type: "error", error: { type, message: msg } });

async function expectAIError(reply: Raw, expected: { status: number; code: string }, settings: { timeoutMs?: number } = {}) {
  const api = await rawApi(reply);
  try {
    const client = new ClaudeClient({ apiKey: "k", model: "claude-opus-5-5", fallbacks: "off", baseURL: api.baseURL, maxRetries: 0, ...settings });
    await assert.rejects(
      client.structured({ system: "s", user: "u", schema: ScoreSchema }),
      (e: HttpError) => {
        assert.equal(e.code, expected.code, e.message);
        assert.equal(e.status, expected.status);
        return true;
      },
    );
  } finally {
    await api.close();
  }
}

test("refusal maps to 422 ai_refused with the stop category", async () => {
  await expectAIError({ body: message("refusal", [], { stop_details: { type: "refusal", category: "cyber" } }) }, { status: 422, code: "ai_refused" });
});

test("max_tokens truncation maps to ai_truncated (empty) or ai_invalid_output (cut-off JSON)", async () => {
  await expectAIError({ body: message("max_tokens", []) }, { status: 502, code: "ai_truncated" });
  await expectAIError({ body: message("max_tokens", [{ type: "text", text: '{"score": 80, "tier": "A", "reas' }]) }, { status: 502, code: "ai_invalid_output" });
});

test("output that does not match the schema maps to 502 ai_invalid_output", async () => {
  await expectAIError({ body: message("end_turn", [{ type: "text", text: JSON.stringify({ score: "high" }) }]) }, { status: 502, code: "ai_invalid_output" });
  await expectAIError({ body: message("end_turn", [{ type: "text", text: "not json" }]) }, { status: 502, code: "ai_invalid_output" });
});

test("5xx / overloaded, rate limit and auth errors map to typed codes", async () => {
  await expectAIError({ status: 529, body: apiError("overloaded_error", "Overloaded") }, { status: 502, code: "ai_error" });
  await expectAIError({ status: 500, body: apiError("api_error", "Internal") }, { status: 502, code: "ai_error" });
  await expectAIError({ status: 429, body: apiError("rate_limit_error", "slow down") }, { status: 503, code: "ai_rate_limited" });
  await expectAIError({ status: 401, body: apiError("authentication_error", "bad key") }, { status: 502, code: "ai_auth_failed" });
  await expectAIError({ status: 400, body: apiError("invalid_request_error", "bad") }, { status: 502, code: "ai_bad_request" });
});

test("a request timeout maps to 503 ai_unreachable", async () => {
  await expectAIError({ delayMs: 1000, body: message("end_turn", []) }, { status: 503, code: "ai_unreachable" }, { timeoutMs: 50 });
});
