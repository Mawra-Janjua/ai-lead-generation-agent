// Real Anthropic SDK against a local mock Messages API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeClient } from "../src/claude.ts";
import { ClaudeLeadAI, leadFacts, tierFor } from "../src/ai.ts";
import { icpSignals, normalizeLead } from "../src/normalize.ts";
import { RawLeadSchema } from "../src/schemas.ts";
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
