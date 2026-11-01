export type ComparisonType = 'target' | 'history' | 'competitor' | 'industry' | 'mom' | 'peer';
export type CandidateStatus = 'review' | 'retained' | 'excluded';
export type QualityState = 'usable' | 'blocked' | 'needs_evidence';

export type EvidenceRef = {
  assetSha256: string;
  kind: 'raw' | 'web' | 'standard' | 'calculation';
  locator: string;
  note?: string;
};

export type SourceAsset = {
  id: string;
  kind: 'file' | 'web';
  name: string;
  sha256: string;
  mediaType: string;
  bytes: number;
  importedAt: string;
  publishedAt: string | null;
  capturedAt: string | null;
  locator: string;
  path: string;
  metadata: Record<string, unknown>;
};

export type RawRow = {
  rowNumber: number;
  values: Record<string, unknown>;
  issues: string[];
  source: EvidenceRef;
};

export type StandardRow = {
  rowId: string;
  metricId: string;
  entity: string;
  period: string;
  value: number | null;
  unit: string;
  dimensions: Record<string, string>;
  quality: QualityState;
  issues: string[];
  source: EvidenceRef;
};

export type CleaningStep = {
  id: string;
  kind: string;
  version: number;
  params: Record<string, unknown>;
  inputHash: string;
  outputHash: string;
  affectedRows: string[];
};

export type DatasetVersion = {
  id: string;
  version: number;
  name: string;
  createdAt: string;
  sourceAssetIds: string[];
  rows: StandardRow[];
  rawRows: RawRow[];
  fields: string[];
  steps: CleaningStep[];
  quality: { usable: number; blocked: number; needsEvidence: number };
  sha256: string;
};

export type ComparisonInput = {
  comparisonType: ComparisonType;
  metricId: string;
  entity: string;
  period: string;
  actual: number;
  benchmark: number;
  unit: string;
  direction: 'higher-better' | 'lower-better';
  threshold: number;
  periodClosed: boolean;
  comparable: boolean;
  benchmarkLabel: string;
  benchmarkPeriod?: string;
  actualLabel?: string;
  evidence: EvidenceRef[];
  selectionContext: string;
};

export type ComparisonResult = {
  comparisonType: ComparisonType;
  metricId: string;
  entity: string;
  period: string;
  status: 'qualified' | 'observation' | 'needs_evidence';
  actual: number;
  benchmark: number;
  unit: string;
  benchmarkLabel: string;
  benchmarkPeriod?: string;
  actualLabel?: string;
  gap: number | null;
  gapRate: number | null;
  gapDisplay: string;
  direction: 'higher-better' | 'lower-better';
  formula: string;
  reason: string;
  evidence: EvidenceRef[];
  selectionContext: string;
  definitionId?: string;
  thresholdVersion?: string;
  calculationVersion?: string;
};

export type Observation = {
  id: string;
  runId: string;
  kind: 'profile' | 'comparison' | 'quality' | 'decision';
  status: 'observed' | 'needs_evidence' | 'rejected' | 'candidate';
  summary: string;
  comparison?: ComparisonResult;
  comparisonId?: string;
  role?: 'support' | 'refutation' | 'quality';
  evidence: EvidenceRef[];
  createdAt: string;
};

export type CandidateInput = {
  runId: string;
  datasetId: string;
  comparison: ComparisonResult;
  title: string;
  interpretation: string;
  nextStep: string;
  unknown: string;
  support: string;
  refutation: string;
  refutationObservationId: string;
  thresholdVersion: string;
  calculationLocator?: string;
  singleSourceLimitation?: string;
};

export type CaseCandidate = CandidateInput & {
  id: string;
  fingerprint: string;
  status: CandidateStatus;
  revision: number;
  revisions: Array<{ comparison: ComparisonResult; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
  reviews: ReviewRecord[];
};

export type ReviewRecord = {
  status: CandidateStatus;
  note: string;
  createdAt: string;
  reason?: string;
};

export const EXCLUSION_REASONS = ['口径不符', '证据不足', '重复', '其他'] as const;
export type ExclusionReason = typeof EXCLUSION_REASONS[number];

export type SourceTier = 'A' | 'B' | 'C';

export type SearchHit = {
  url: string;
  title: string;
  snippet: string;
  tier?: SourceTier;
  status?: 'hit' | 'fetched' | 'abandoned';
};

export type SearchEventRecord = {
  id: string;
  runId: string;
  kind: 'search' | 'selection';
  query: string;
  provider: string;
  callKey: string;
  hits: SearchHit[];
  createdAt: string;
  error?: string;
  attempts?: Array<{ provider: string; error: string }>;
};

export type WebSnapshotRecord = {
  id: string;
  runId: string;
  assetId: string;
  assetSha256: string;
  url: string;
  finalUrl: string;
  title: string;
  publishedAt: string | null;
  capturedAt: string;
  contentType: string;
  sourceTier: SourceTier;
  callKey: string;
  text: string;
  excerpt: string;
  parseStatus: 'parsed' | 'needs_review';
  pdfPages?: { count: number; offsets: number[] };
};

export type SnapshotReadRecord = {
  id: string;
  runId: string;
  snapshotId: string;
  offset: number;
  length: number;
  text: string;
  callKey: string;
  createdAt: string;
};

export type ResearchBudget = {
  maxSearches: number;
  maxFetches: number;
  maxSnapshotReads: number;
  usedSearches: number;
  usedFetches: number;
  usedSnapshotReads: number;
};

export type RunEvent = {
  type: string;
  at: string;
  summary: string;
  details?: Record<string, unknown>;
};

export type RunUsage = {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costTotal: number | null;
};

export type ExplorationRun = {
  id: string;
  datasetId: string;
  model: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  budget: { maxToolCalls: number; usedToolCalls: number } & ResearchBudget;
  coverage: string[];
  candidateIds: string[];
  stopReason: string;
  events: RunEvent[];
  usage?: RunUsage;
};

export type ImportResult = {
  asset: SourceAsset;
  rawRows: RawRow[];
  alreadyPresent: boolean;
};
