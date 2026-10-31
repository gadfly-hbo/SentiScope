import type { ComparisonType } from './mvp-types.ts';

export type BenchmarkDefinition = {
  id: string;
  comparisonType: ComparisonType;
  direction: 'higher-better' | 'lower-better';
  threshold: number;
  thresholdVersion: string;
  actualMetric: string;
  actualEntity?: string;
  benchmarkMetric: string;
  benchmarkEntity?: string;
  periodRule: 'same' | 'previous-year';
  label: string;
};

const DEFINITIONS: BenchmarkDefinition[] = [
  { id: 'revenue-target', comparisonType: 'target', direction: 'higher-better', threshold: 10, thresholdVersion: 'revenue-target@v1', actualMetric: 'revenue', benchmarkMetric: 'revenue.target', periodRule: 'same', label: '内部目标' },
  { id: 'revenue-history', comparisonType: 'history', direction: 'higher-better', threshold: 5, thresholdVersion: 'revenue-history@v1', actualMetric: 'revenue', benchmarkMetric: 'revenue', periodRule: 'previous-year', label: '去年同期' },
  { id: 'growth-competitor', comparisonType: 'competitor', direction: 'higher-better', threshold: 8, thresholdVersion: 'growth-competitor@v1', actualMetric: 'revenue', actualEntity: '自身', benchmarkMetric: 'revenue', benchmarkEntity: '竞对A', periodRule: 'same', label: '竞对A公开披露' },
  { id: 'growth-industry', comparisonType: 'industry', direction: 'higher-better', threshold: 8, thresholdVersion: 'growth-industry@v1', actualMetric: 'revenue', actualEntity: '自身', benchmarkMetric: 'revenue', benchmarkEntity: '行业', periodRule: 'same', label: '行业公开统计' },
  { id: 'wait-target', comparisonType: 'target', direction: 'lower-better', threshold: 20, thresholdVersion: 'wait-target@v1', actualMetric: 'support.wait_seconds', benchmarkMetric: 'support.target', periodRule: 'same', label: '目标等待时长' },
];

export function getBenchmarkDefinition(id: string): BenchmarkDefinition {
  const definition = DEFINITIONS.find(item => item.id === id);
  if (!definition) throw new Error('benchmark_definition_rejected');
  return definition;
}

export function previousYearPeriod(period: string): boolean {
  const match = /^(\d{4})(?:-(\d{2})|Q([1-4]))$/.exec(period);
  if (!match) return false;
  const year = Number(match[1]);
  if (!Number.isInteger(year) || year < 1) return false;
  return true;
}

export function isPreviousYear(actualPeriod: string, benchmarkPeriod: string): boolean {
  const actual = /^(\d{4})(.*)$/.exec(actualPeriod);
  const benchmark = /^(\d{4})(.*)$/.exec(benchmarkPeriod);
  return Boolean(actual && benchmark && Number(actual[1]) - Number(benchmark[1]) === 1 && actual[2] === benchmark[2]);
}
