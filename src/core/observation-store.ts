import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation, ObservationStatus, RunSummary } from './types.ts';

/**
 * 观察存储：SQLite（node:sqlite），append-only。观察身份＝来源＋指标＋实体＋周期＋规则身份，
 * 重复运行只追加新行，不更新旧行；稳定查询供后续切片做发现级去重。
 */
export class ObservationStore {
  private readonly db: DatabaseSync;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.db = new DatabaseSync(join(rootDir, 'observations.sqlite3'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        identity TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        metric_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        entity TEXT NOT NULL,
        period_label TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        checks TEXT NOT NULL,
        facts TEXT NOT NULL,
        evidence_sha256 TEXT,
        locator TEXT,
        captured_at TEXT NOT NULL,
        source_refreshed_at TEXT,
        unknown_note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observations_identity ON observations(identity);
      CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(run_id);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
    `);
  }

  append(observations: Observation[]): void {
    if (!observations.length) return;
    const insert = this.db.prepare(`INSERT INTO observations
      (run_id, seq, identity, rule_id, rule_version, metric_id, metric_name, entity, period_label,
       status, reason, checks, facts, evidence_sha256, locator, captured_at, source_refreshed_at, unknown_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      const counts = new Map<string, number>();
      const countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE run_id = ?');
      const bump = (id: string) => {
        const next = (counts.get(id) ?? (countStmt.get(id) as { n: number }).n);
        counts.set(id, next + 1);
        return next;
      };
      for (const o of observations) {
        insert.run(o.runId, bump(o.runId), o.identity, o.ruleId, o.ruleVersion, o.metricId, o.metricName,
          o.entity, o.periodLabel, o.status, o.reason, JSON.stringify(o.checks), JSON.stringify(o.facts),
          o.evidenceSha256, o.locator, o.capturedAt, o.sourceRefreshedAt, o.unknownNote, o.capturedAt);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listRuns(): { runId: string; startedAt: string; count: number }[] {
    const rows = this.db.prepare(`SELECT run_id, MIN(captured_at) AS started, COUNT(*) AS n FROM observations GROUP BY run_id ORDER BY started DESC`).all() as { run_id: string; started: string; n: number }[];
    return rows.map((r) => ({ runId: r.run_id, startedAt: r.started, count: r.n }));
  }

  listObservations(runId: string): Observation[] {
    const rows = this.db.prepare(`SELECT * FROM observations WHERE run_id = ? ORDER BY seq`).all(runId) as Row[];
    return rows.map(rowToObservation);
  }

  latestObservations(limit: number): Observation[] {
    const rows = this.db.prepare(`SELECT * FROM observations ORDER BY rowid DESC LIMIT ?`).all(limit) as Row[];
    return rows.map(rowToObservation).reverse();
  }

  statusCounts(): Record<ObservationStatus, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM observations GROUP BY status`).all() as { status: string; n: number }[];
    const counts: Record<ObservationStatus, number> = { ok: 0, gap: 0, insufficient: 0, failed: 0 };
    for (const r of rows) counts[r.status as ObservationStatus] = r.n;
    return counts;
  }

  close(): void { this.db.close(); }
}

type Row = {
  run_id: string; seq: number; identity: string; rule_id: string; rule_version: number;
  metric_id: string; metric_name: string; entity: string; period_label: string; status: string;
  reason: string; checks: string; facts: string; evidence_sha256: string | null; locator: string | null;
  captured_at: string; source_refreshed_at: string | null; unknown_note: string; created_at: string;
};

function rowToObservation(r: Row): Observation {
  return {
    runId: r.run_id, identity: r.identity, ruleId: r.rule_id, ruleVersion: r.rule_version,
    metricId: r.metric_id, metricName: r.metric_name, entity: r.entity, periodLabel: r.period_label,
    status: r.status as ObservationStatus, reason: r.reason,
    checks: JSON.parse(r.checks) as Observation['checks'], facts: JSON.parse(r.facts) as Observation['facts'],
    evidenceSha256: r.evidence_sha256, locator: r.locator, capturedAt: r.captured_at,
    sourceRefreshedAt: r.source_refreshed_at, unknownNote: r.unknown_note,
  };
}

export function summarizeRun(runId: string, observations: Observation[]): RunSummary {
  const counts: Record<ObservationStatus, number> = { ok: 0, gap: 0, insufficient: 0, failed: 0 };
  for (const o of observations) counts[o.status] += 1;
  const times = observations.map((o) => o.capturedAt).sort();
  return {
    runId,
    startedAt: times[0] ?? '',
    finishedAt: times[times.length - 1] ?? '',
    counts,
    observations,
  };
}
