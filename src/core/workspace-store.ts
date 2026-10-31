import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseCandidate, CandidateStatus, DatasetVersion, ExplorationRun, Observation, SourceAsset } from './mvp-types.ts';
import { canonicalJson } from './raw-evidence.ts';

export class WorkspaceStore {
  readonly rootDir: string;
  private readonly db: DatabaseSync;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
    this.db = new DatabaseSync(join(rootDir, 'workspace.sqlite3'));
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(run_id, created_at);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status, updated_at);
      CREATE TABLE IF NOT EXISTS reviews (candidate_id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_reviews_candidate ON reviews(candidate_id, created_at);
    `);
  }

  insertAsset(asset: SourceAsset): void {
    this.db.prepare('INSERT OR IGNORE INTO assets (id, sha256, kind, payload) VALUES (?, ?, ?, ?)').run(asset.id, asset.sha256, asset.kind, JSON.stringify(asset));
  }

  listAssets(): SourceAsset[] {
    return rows(this.db.prepare('SELECT payload FROM assets ORDER BY rowid DESC').all());
  }

  insertDataset(dataset: DatasetVersion): void {
    this.db.prepare('INSERT OR IGNORE INTO datasets (id, sha256, version, payload) VALUES (?, ?, ?, ?)').run(dataset.id, dataset.sha256, dataset.version, JSON.stringify(dataset));
  }

  getDataset(id: string): DatasetVersion | null {
    const row = this.db.prepare('SELECT payload FROM datasets WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as DatasetVersion : null;
  }

  listDatasets(): DatasetVersion[] {
    return rows(this.db.prepare('SELECT payload FROM datasets ORDER BY rowid DESC').all());
  }

  createRun(run: ExplorationRun): void {
    this.db.prepare('INSERT INTO runs (id, dataset_id, status, started_at, payload) VALUES (?, ?, ?, ?, ?)').run(run.id, run.datasetId, run.status, run.startedAt, JSON.stringify(run));
  }

  saveRun(run: ExplorationRun): void {
    this.db.prepare('UPDATE runs SET status = ?, payload = ? WHERE id = ?').run(run.status, JSON.stringify(run), run.id);
  }

  getRun(id: string): ExplorationRun | null {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ExplorationRun : null;
  }

  listRuns(): ExplorationRun[] {
    return rows(this.db.prepare('SELECT payload FROM runs ORDER BY started_at DESC').all());
  }

  appendObservations(observations: Observation[]): void {
    this.db.exec('BEGIN');
    try {
      for (const observation of observations) this.insertObservation(observation);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listObservations(runId?: string): Observation[] {
    return runId
      ? rows(this.db.prepare('SELECT payload FROM observations WHERE run_id = ? ORDER BY created_at, id').all(runId))
      : rows(this.db.prepare('SELECT payload FROM observations ORDER BY created_at, id').all());
  }

  commitCandidate(candidate: CaseCandidate, observation: Observation): CaseCandidate {
    this.assertCandidateEvidence(candidate);
    const refutation = this.db.prepare('SELECT payload FROM observations WHERE id = ? AND run_id = ?').get(candidate.refutationObservationId, candidate.runId) as { payload: string } | undefined;
    const refutationObservation = refutation ? JSON.parse(refutation.payload) as Observation : null;
    if (!refutationObservation || refutationObservation.role !== 'refutation' || refutationObservation.comparisonId !== observation.comparisonId || !refutationObservation.evidence.length) throw new Error('refutation_observation_required');
    this.assertEvidenceReferences(refutationObservation.evidence, candidate.datasetId, false);
    this.db.exec('BEGIN');
    try {
      this.insertObservation(observation);
      const existing = this.getCandidate(candidate.id);
      if (existing && comparisonMaterial(existing.comparison) !== comparisonMaterial(candidate.comparison)) {
        const comparison = {
          ...candidate.comparison,
          evidence: candidate.comparison.evidence.map(ref => ref.kind === 'calculation' ? { ...ref, locator: ref.locator.replace(/revision:\d+/, `revision:${existing.revision + 1}`) } : ref),
        };
        const updated: CaseCandidate = {
          ...candidate,
          comparison,
          status: existing.status,
          revision: existing.revision + 1,
          revisions: [...existing.revisions, { comparison: existing.comparison, createdAt: existing.updatedAt }],
          reviews: existing.reviews,
          createdAt: existing.createdAt,
        };
        this.db.prepare('UPDATE candidates SET run_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?')
          .run(updated.runId, updated.status, updated.updatedAt, JSON.stringify(updated), updated.id);
      } else if (!existing) {
        this.db.prepare('INSERT INTO candidates (id, fingerprint, run_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(candidate.id, candidate.fingerprint, candidate.runId, candidate.status, candidate.createdAt, candidate.updatedAt, JSON.stringify(candidate));
      }
      this.db.exec('COMMIT');
      return this.getCandidate(candidate.id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private assertCandidateEvidence(candidate: CaseCandidate): void {
    const unique = new Set(candidate.comparison.evidence.map(ref => `${ref.assetSha256}:${ref.locator}`));
    if (unique.size !== candidate.comparison.evidence.length) throw new Error('duplicate_evidence_reference');
    this.assertEvidenceReferences(candidate.comparison.evidence, candidate.datasetId);
  }

  private assertEvidenceReferences(references: CaseCandidate['comparison']['evidence'], datasetId: string, allowCalculation = true): void {
    const dataset = this.getDataset(datasetId);
    if (!dataset) throw new Error('evidence_dataset_not_found');
    for (const ref of references) {
      if (ref.kind === 'calculation') {
        if (allowCalculation) continue;
        throw new Error('calculation_evidence_not_allowed');
      }
      const exists = this.db.prepare('SELECT 1 AS found FROM assets WHERE sha256 = ?').get(ref.assetSha256);
      if (!exists) throw new Error('evidence_not_found');
      const located = dataset.rawRows.some(row => row.source.assetSha256 === ref.assetSha256 && row.source.locator === ref.locator)
        || dataset.rows.some(row => row.source.assetSha256 === ref.assetSha256 && row.source.locator === ref.locator);
      if (!located) throw new Error('evidence_locator_not_found');
    }
  }

  listCandidates(): CaseCandidate[] {
    return rows(this.db.prepare('SELECT payload FROM candidates ORDER BY updated_at DESC, id').all());
  }

  getCandidate(id: string): CaseCandidate | null {
    const row = this.db.prepare('SELECT payload FROM candidates WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as CaseCandidate : null;
  }

  reviewCandidate(id: string, status: CandidateStatus, note: string, now: string): CaseCandidate {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error('candidate_not_found');
    const review = { status, note, createdAt: now };
    const updated = { ...candidate, status, updatedAt: now, reviews: [review, ...candidate.reviews] };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO reviews (candidate_id, created_at, status, note) VALUES (?, ?, ?, ?)').run(id, now, status, note);
      this.db.prepare('UPDATE candidates SET status = ?, updated_at = ?, payload = ? WHERE id = ?').run(status, now, JSON.stringify(updated), id);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private insertObservation(observation: Observation): void {
    this.db.prepare('INSERT INTO observations (id, run_id, kind, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(observation.id, observation.runId, observation.kind, observation.status, observation.createdAt, JSON.stringify(observation));
  }
}

function comparisonMaterial(comparison: CaseCandidate['comparison']): string {
  const { selectionContext: _selectionContext, reason: _reason, ...material } = comparison;
  return canonicalJson({ ...material, evidence: material.evidence.filter(ref => ref.kind !== 'calculation') });
}

function rows<T>(result: unknown[]): T[] {
  return result.map(row => JSON.parse((row as { payload: string }).payload) as T);
}
