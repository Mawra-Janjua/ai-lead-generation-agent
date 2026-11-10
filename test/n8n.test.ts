// Structural checks on the importable n8n workflows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

type Node = {
  name: string;
  type: string;
  typeVersion: number;
  position: number[];
  parameters: Record<string, any>;
  credentials?: Record<string, { id: string; name: string }>;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: string;
};
type Workflow = { name: string; nodes: Node[]; connections: Record<string, { main: { node: string }[][] }> };

const dir = new URL("../n8n/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".workflow.json"));
const load = (file: string) => JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Workflow;
const isBackendCall = (n: Node) => n.type === "n8n-nodes-base.httpRequest" && /LEAD_AGENT_URL/.test(String(n.parameters.url));

test("ships the webhook, Google Sheets and form workflows", () => {
  for (const f of ["webhook-intake.workflow.json", "google-sheets-qualify.workflow.json", "lead-form.workflow.json"]) assert.ok(files.includes(f), f);
});

for (const file of files) {
  test(`${file} is a well-formed n8n workflow`, () => {
    const wf = load(file);
    assert.equal(typeof wf.name, "string");
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0);
    assert.equal(typeof wf.connections, "object");
    const names = new Set<string>();
    for (const n of wf.nodes) {
      assert.match(n.type, /^n8n-nodes-base\./, `${n.name} uses a core node`);
      assert.equal(typeof n.typeVersion, "number");
      assert.ok(Array.isArray(n.position) && n.position.length === 2);
      assert.ok(!names.has(n.name), `duplicate node name ${n.name}`);
      names.add(n.name);
    }
    for (const [source, conn] of Object.entries(wf.connections)) {
      assert.ok(names.has(source), `connection source ${source} exists`);
      for (const output of conn.main) for (const target of output) assert.ok(names.has(target.node), `target ${target.node} exists`);
    }
  });

  test(`${file} embeds no credentials or secrets`, () => {
    const wf = load(file);
    for (const n of wf.nodes) {
      for (const [type, cred] of Object.entries(n.credentials ?? {})) assert.equal(cred.id, "", `${n.name} ${type} credential id must be empty`);
    }
    const text = JSON.stringify(wf);
    assert.doesNotMatch(text, /sk-ant-|AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|Bearer [A-Za-z0-9._~+/-]{16,}|"password"\s*:/, "no secrets embedded");
  });

  test(`${file}: backend calls retry, never swallow errors, and route failures`, () => {
    const wf = load(file);
    const byName = new Map(wf.nodes.map((n) => [n.name, n]));
    for (const n of wf.nodes.filter(isBackendCall)) {
      assert.equal(n.retryOnFail, true, `${n.name} retryOnFail`);
      assert.equal(n.maxTries, 3);
      assert.equal(n.waitBetweenTries, 3000);
      assert.doesNotMatch(JSON.stringify(n.parameters), /neverError/, `${n.name} must not use neverError`);
      assert.equal(n.onError, "continueErrorOutput");
      assert.ok(n.parameters.headerParameters.parameters.some((h: { name: string }) => h.name === "Idempotency-Key"), `${n.name} sends Idempotency-Key`);
      const errorTargets = (wf.connections[n.name]?.main[1] ?? []).map((t) => byName.get(t.node)!);
      assert.ok(errorTargets.length > 0, `${n.name} error output is wired`);
      const hasWebhook = wf.nodes.some((x) => x.type === "n8n-nodes-base.webhook");
      for (const t of errorTargets) {
        if (hasWebhook) {
          assert.equal(t.type, "n8n-nodes-base.respondToWebhook");
          assert.equal(t.parameters.options.responseCode, 502);
          assert.equal(t.parameters.respondWith, "json");
        } else {
          assert.ok(["n8n-nodes-base.stopAndError", "n8n-nodes-base.form"].includes(t.type), `${t.name} reports the failure`);
        }
      }
    }
  });
}

test("Webhook nodes require header auth via a named, empty credential", () => {
  const hooks = files.flatMap((f) => load(f).nodes.filter((n) => n.type === "n8n-nodes-base.webhook"));
  assert.ok(hooks.length > 0);
  for (const h of hooks) {
    assert.equal(h.parameters.authentication, "headerAuth");
    assert.deepEqual(h.credentials, { httpHeaderAuth: { id: "", name: "Lead Agent webhook auth" } });
  }
});

test("form workflow collects lead fields and posts to /api/leads", () => {
  const wf = load("lead-form.workflow.json");
  const trigger = wf.nodes.find((n) => n.type === "n8n-nodes-base.formTrigger")!;
  assert.ok(trigger, "has a Form Trigger");
  const fields = trigger.parameters.formFields.values as { fieldLabel: string; requiredField?: boolean }[];
  assert.deepEqual(fields.map((f) => f.fieldLabel), ["Company", "Website", "First name", "Last name", "Email", "Title", "Country", "Notes"]);
  assert.deepEqual(fields.filter((f) => f.requiredField).map((f) => f.fieldLabel), ["Company"]);
  const call = wf.nodes.find(isBackendCall)!;
  assert.equal(call.parameters.method, "POST");
  assert.equal(call.parameters.url, "={{ $env.LEAD_AGENT_URL }}/api/leads");
  const endings = wf.nodes.filter((n) => n.type === "n8n-nodes-base.form" && n.parameters.operation === "completion");
  assert.equal(endings.length, 2, "success and error completion pages");
});

test("Google Sheets flow skips processed rows, appends only created leads and writes status back", () => {
  const wf = load("google-sheets-qualify.workflow.json");
  const filter = wf.nodes.find((n) => n.name === "Only unprocessed rows")!;
  assert.match(JSON.stringify(filter.parameters), /Status[\s\S]*"operation":"empty"/);
  const next = (name: string) => (wf.connections[name]?.main[0] ?? []).map((t) => t.node);
  assert.deepEqual(next("Flatten results").sort(), ["Keep created leads", "Mark rows in 'Leads In'"]);
  assert.match(JSON.stringify(wf.nodes.find((n) => n.name === "Keep created leads")!.parameters), /"rightValue":"created"/);
  const mark = wf.nodes.find((n) => n.name === "Mark rows in 'Leads In'")!;
  assert.equal(mark.parameters.operation, "update");
  assert.deepEqual(mark.parameters.columns.matchingColumns, ["row_number"]);
});
