import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { NormalizedLead } from "./normalize.ts";
import type { Enrichment } from "./enrich.ts";
import type { Outreach, Score } from "./schemas.ts";
import type { IcpSignals } from "./normalize.ts";

export type LeadRecord = {
  id: string;
  lead: NormalizedLead;
  enrichment: Enrichment | null;
  signals: IcpSignals | null;
  score: Score | null;
  outreach: Outreach | null;
  status: "new" | "scored" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = { id: string; data: string; status: LeadRecord["status"]; error: string | null; score: number | null; tier: string | null; created_at: string; updated_at: string };

export class LeadStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        score INTEGER,
        tier TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lead_keys (
        key TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(id)
      );
      CREATE TABLE IF NOT EXISTS idempotent_leads (
        idem_key TEXT NOT NULL,
        lead_id TEXT NOT NULL REFERENCES leads(id),
        PRIMARY KEY (idem_key, lead_id)
      );
      CREATE INDEX IF NOT EXISTS leads_score ON leads(score);
    `);
  }

  findDuplicate(keys: string[]): string | null {
    for (const k of keys) {
      const row = this.db.prepare("SELECT lead_id FROM lead_keys WHERE key = ?").get(k) as { lead_id: string } | undefined;
      if (row) return row.lead_id;
    }
    return null;
  }

  /**
   * Atomically reserves the dedupe keys and stores the lead. Runs in one
   * synchronous transaction, so it cannot interleave with another request in
   * this process, and the PRIMARY KEY on lead_keys rejects a concurrent writer
   * from another process. A key conflict means "duplicate": nothing is stored.
   */
  claim(lead: NormalizedLead, keys: string[], idemKey?: string): { rec: LeadRecord } | { duplicateOf: string } {
    const now = new Date().toISOString();
    const rec: LeadRecord = { id: randomUUID(), lead, enrichment: null, signals: null, score: null, outreach: null, status: "new", error: null, createdAt: now, updatedAt: now };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findDuplicate(keys);
      if (existing) {
        this.db.exec("ROLLBACK");
        return { duplicateOf: existing };
      }
      this.db
        .prepare("INSERT INTO leads (id, data, status, error, score, tier, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)")
        .run(rec.id, JSON.stringify(this.payload(rec)), rec.status, now, now);
      const stmt = this.db.prepare("INSERT INTO lead_keys (key, lead_id) VALUES (?, ?)");
      for (const k of new Set(keys)) stmt.run(k, rec.id);
      if (idemKey) this.db.prepare("INSERT OR IGNORE INTO idempotent_leads (idem_key, lead_id) VALUES (?, ?)").run(idemKey, rec.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      const existing = isConstraintError(err) ? this.findDuplicate(keys) : null;
      if (existing) return { duplicateOf: existing };
      throw err;
    }
    return { rec };
  }

  /** Was this lead created by a request carrying the same Idempotency-Key? */
  createdWithKey(leadId: string, idemKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM idempotent_leads WHERE idem_key = ? AND lead_id = ?").get(idemKey, leadId) !== undefined;
  }

  save(rec: LeadRecord) {
    rec.updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE leads SET data = ?, status = ?, error = ?, score = ?, tier = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(this.payload(rec)), rec.status, rec.error, rec.score?.score ?? null, rec.score?.tier ?? null, rec.updatedAt, rec.id);
  }

  get(id: string): LeadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(f: { tier?: string; minScore?: number; limit: number }): LeadRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.tier) {
      where.push("tier = ?");
      args.push(f.tier);
    }
    if (f.minScore !== undefined) {
      where.push("score >= ?");
      args.push(f.minScore);
    }
    const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY score IS NULL, score DESC, created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, f.limit) as Row[]).map((r) => this.hydrate(r));
  }

  private payload(r: LeadRecord) {
    return { lead: r.lead, enrichment: r.enrichment, signals: r.signals, score: r.score, outreach: r.outreach };
  }

  private hydrate(row: Row): LeadRecord {
    const p = JSON.parse(row.data) as ReturnType<LeadStore["payload"]>;
    return { id: row.id, ...p, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  close() {
    this.db.close();
  }
}

function isConstraintError(err: unknown) {
  const e = err as { code?: string; errcode?: number; message?: string };
  return e?.errcode === 1555 || e?.errcode === 2067 || /UNIQUE constraint failed/i.test(e?.message ?? "");
}
