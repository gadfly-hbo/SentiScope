import type { CaseCandidate, DatasetVersion, Observation } from '../core/mvp-types.ts';

export type EvidenceLinkLookup = {
  dataset: DatasetVersion | null;
  assetExists: (sha256: string) => boolean;
  observations: Observation[];
};

export function verifyEvidenceLink(candidate: CaseCandidate, lookup: EvidenceLinkLookup): string[] {
  const failures: string[] = [];
  if (!lookup.dataset) return [`数据集 ${candidate.datasetId} 不存在`];
  for (const ref of candidate.comparison.evidence) {
    if (ref.kind === 'calculation') {
      const comparisonId = ref.locator.startsWith('comparison:') ? ref.locator.slice('comparison:'.length).split(';')[0] : null;
      const found = comparisonId && lookup.observations.some(observation => observation.comparisonId === comparisonId && observation.comparison);
      if (!found) failures.push(`计算事件 ${ref.locator} 未找到`);
    } else {
      if (!lookup.assetExists(ref.assetSha256)) failures.push(`资产 ${ref.assetSha256.slice(0, 12)}… 不存在`);
      else if (!lookup.dataset.rawRows.some(row => row.source.assetSha256 === ref.assetSha256 && row.source.locator === ref.locator)
        && !lookup.dataset.rows.some(row => row.source.assetSha256 === ref.assetSha256 && row.source.locator === ref.locator)) failures.push(`定位 ${ref.locator} 不在候选数据集行中`);
    }
  }
  return failures;
}
