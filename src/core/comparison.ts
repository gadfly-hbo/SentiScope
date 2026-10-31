import type { ComparisonInput, ComparisonResult } from './mvp-types.ts';

export function compareDescriptive(input: ComparisonInput): ComparisonResult {
  if (!Number.isFinite(input.actual) || !Number.isFinite(input.benchmark) || !Number.isFinite(input.threshold) || input.threshold < 0) throw new Error('invalid_comparison_numbers');
  const gap = round(input.actual - input.benchmark);
  const growthGap = input.comparisonType === 'competitor' || input.comparisonType === 'industry';
  const canUseRate = input.benchmark > 0;
  const gapRate = !growthGap && canUseRate ? round(gap / Math.abs(input.benchmark) * 100) : null;
  const directionGap = input.direction === 'higher-better' ? -gap : gap;
  const score = growthGap ? directionGap : gapRate == null ? null : input.direction === 'higher-better' ? -gapRate : gapRate;
  const periodComparable = input.comparisonType === 'history' || !input.benchmarkPeriod || input.benchmarkPeriod === input.period;
  const comparable = input.comparable && input.periodClosed && periodComparable && input.evidence.length > 0 && input.selectionContext.trim().length > 0;
  const rateRequired = !growthGap && !canUseRate;
  const qualified = comparable && !rateRequired && score != null && score > input.threshold;
  const status = !comparable || rateRequired ? 'needs_evidence' : qualified ? 'qualified' : 'observation';
  const gapDisplay = growthGap ? `${signed(gap)} 个百分点` : `${signed(gap)} ${input.unit}${gapRate == null ? '' : `（${signed(gapRate)}%）`}`;
  const reason = !input.comparable ? '比较口径不一致'
    : !input.periodClosed || !periodComparable ? '比较期间未结期或不一致'
    : !input.evidence.length ? '缺少证据引用'
    : !input.selectionContext.trim() ? '缺少搜索覆盖与选择上下文'
    : rateRequired ? '基准为零或负数，普通差率不可计算'
    : qualified ? '差距超过该指标重要性阈值'
    : '差距未达到候选重要性阈值';
  return {
    comparisonType: input.comparisonType,
    metricId: input.metricId,
    entity: input.entity,
    period: input.period,
    status,
    actual: input.actual,
    benchmark: input.benchmark,
    unit: input.unit,
    benchmarkLabel: input.benchmarkLabel,
    benchmarkPeriod: input.benchmarkPeriod,
    actualLabel: input.actualLabel,
    gap,
    gapRate,
    gapDisplay,
    direction: input.direction,
    formula: growthGap
      ? `增速差 = ${input.actual}% − ${input.benchmark}% = ${signed(gap)} 个百分点；阈值 > ${input.threshold} 个百分点`
      : `差额 = ${input.actual} − ${input.benchmark} = ${signed(gap)} ${input.unit}${gapRate == null ? '' : `；差率 = ${signed(gap)} ÷ ${input.benchmark} = ${signed(gapRate)}%`}；阈值 > ${input.threshold}%`,
    reason,
    evidence: input.evidence,
    selectionContext: input.selectionContext,
  };
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function signed(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : value > 0 ? `+${value}` : '0';
}
