export type Direction = 'higher-better' | 'lower-better';

export type ObservationStatus = 'ok' | 'gap' | 'insufficient' | 'failed';

export type CheckMark = 'pass' | 'block' | 'hold';

export type CheckResult = { mark: CheckMark; name: string; note: string };

export type PeriodInfo = { kind: 'month' | 'week'; label: string; closed: boolean };

/** One read from a source, before any caliber validation. */
export type Reading = {
  metricId: string;
  entity: string;
  period: PeriodInfo;
  value: number | null;
  unit: string;
  filters: Record<string, string[]>;
  refreshedAt: string;
  denominator?: number | null;
};

export type SourceConfig = {
  id: string;
  kind: 'http';
  baseUrl: string;
  readOnly: true;
  scope: { dashboard: string; entities: string[] };
};

export type RuleConfig = {
  id: string;
  version: number;
  sourceId: string;
  sourcePath: string;
  metricId: string;
  metricName: string;
  entity: string;
  periodKind: 'month' | 'week';
  direction: Direction;
  unit: string;
  target: number;
  /** 触发阈值：差距百分比超过该值形成合格差距 */
  thresholdPct: number;
  /** 数据最大可滞留天数：业务刷新时间早于 now - maxStalenessDays 视为过期 */
  maxStalenessDays: number;
  /** 触发判定是否要求已结期 */
  requiresClosedPeriod: boolean;
  /** 未结期时是否存在认可的目标轨迹；无轨迹只记现状 */
  hasTrajectory: boolean;
  /** 期望的过滤条件；来源快照漂移即暂停比较 */
  expectedFilters?: Record<string, string[]>;
  /** 比率类指标分母为零时的处理（当前固定 not_computable） */
  denominatorMetric?: boolean;
};

export type Observation = {
  runId: string;
  identity: string;
  ruleId: string;
  ruleVersion: number;
  metricId: string;
  metricName: string;
  entity: string;
  periodLabel: string;
  status: ObservationStatus;
  reason: string;
  checks: CheckResult[];
  facts: Record<string, string>;
  evidenceSha256: string | null;
  locator: string | null;
  capturedAt: string;
  sourceRefreshedAt: string | null;
  unknownNote: string;
};

export type RunSummary = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  counts: Record<ObservationStatus, number>;
  observations: Observation[];
};
