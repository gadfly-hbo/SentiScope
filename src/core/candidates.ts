import type { CandidateInput, CaseCandidate } from './mvp-types.ts';
import { canonicalJson, sha256 } from './raw-evidence.ts';

export function createCandidate(input: CandidateInput, now: string): CaseCandidate {
  if (input.comparison.status !== 'qualified') throw new Error('not_qualified');
  if (!input.refutation.trim()) throw new Error('refutation_required');
  if (/导致|根因|预测|将(?:会)?(?:下降|下滑|增长)/.test(input.title)) throw new Error('non_descriptive_title');
  if (!input.unknown.trim() || !input.support.trim() || !input.nextStep.trim() || !input.interpretation.trim()) throw new Error('candidate_context_required');
  if (!input.thresholdVersion.trim() || !input.comparison.formula.trim() || !input.comparison.selectionContext.trim()) throw new Error('candidate_provenance_required');
  if (input.comparison.evidence.length < 2) throw new Error('candidate_evidence_required');
  const fingerprint = sha256(canonicalJson({
    definitionId: input.comparison.definitionId ?? input.thresholdVersion,
    metricId: input.comparison.metricId,
    entity: input.comparison.entity,
    period: input.comparison.period,
    thresholdVersion: input.thresholdVersion,
  }));
  const calculationEvidence = {
    assetSha256: sha256(canonicalJson({ comparison: input.comparison, thresholdVersion: input.thresholdVersion, calculationVersion: input.comparison.calculationVersion ?? 'compare-v2' })),
    kind: 'calculation' as const,
    locator: input.calculationLocator ?? `${input.runId}/${input.comparison.definitionId ?? input.comparison.comparisonType}/${fingerprint}/revision:1`,
    note: `${input.comparison.calculationVersion ?? 'compare-v2'} · ${input.comparison.formula}`,
  };
  return {
    ...input,
    comparison: { ...input.comparison, evidence: [...input.comparison.evidence, calculationEvidence] },
    id: `cand-${fingerprint.slice(0, 16)}`,
    fingerprint,
    status: 'review',
    revision: 1,
    revisions: [],
    createdAt: now,
    updatedAt: now,
    reviews: [],
  };
}
