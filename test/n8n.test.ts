// Structural checks on the importable n8n workflows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../n8n/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".workflow.json"));

test("ships at least one workflow", () => assert.ok(files.length >= 1));

for (const file of files) {
  test(`${file} is a well-formed n8n workflow`, () => {
    const wf = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    assert.equal(typeof wf.name, "string");
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0);
    const names = new Set<string>();
    for (const n of wf.nodes) {
      assert.match(n.type, /^n8n-nodes-base\./, `${n.name} uses a core node`);
      assert.equal(typeof n.typeVersion, "number");
      assert.ok(Array.isArray(n.position) && n.position.length === 2);
      assert.ok(!names.has(n.name), `duplicate node name ${n.name}`);
      names.add(n.name);
    }
    for (const [source, conn] of Object.entries<{ main: { node: string }[][] }>(wf.connections)) {
      assert.ok(names.has(source), `connection source ${source} exists`);
      for (const output of conn.main) for (const target of output) assert.ok(names.has(target.node), `target ${target.node} exists`);
    }
    const text = JSON.stringify(wf);
    assert.doesNotMatch(text, /sk-ant-|AIza[0-9A-Za-z_-]{20,}|"password"\s*:/, "no secrets embedded");
  });
}
