import { existsSync, readFileSync } from 'node:fs';
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

export type BenchmarkOverride = {
  id: string;
  threshold: number;
  version: number;
  reason?: string;
  approvedAt?: string;
};

export type BenchmarkConfig = {
  loaded: boolean;
  overrides: BenchmarkOverride[];
};

const DEFAULTS: BenchmarkDefinition[] = [
  { id: 'revenue-target', comparisonType: 'target', direction: 'higher-better', threshold: 10, thresholdVersion: 'revenue-target@v1', actualMetric: 'revenue', benchmarkMetric: 'revenue.target', periodRule: 'same', label: '内部目标' },
  { id: 'revenue-history', comparisonType: 'history', direction: 'higher-better', threshold: 5, thresholdVersion: 'revenue-history@v1', actualMetric: 'revenue', benchmarkMetric: 'revenue', periodRule: 'previous-year', label: '去年同期' },
  { id: 'growth-competitor', comparisonType: 'competitor', direction: 'higher-better', threshold: 8, thresholdVersion: 'growth-competitor@v1', actualMetric: 'revenue', actualEntity: '自身', benchmarkMetric: 'revenue', benchmarkEntity: '竞对A', periodRule: 'same', label: '竞对A公开披露' },
  { id: 'growth-industry', comparisonType: 'industry', direction: 'higher-better', threshold: 8, thresholdVersion: 'growth-industry@v1', actualMetric: 'revenue', actualEntity: '自身', benchmarkMetric: 'revenue', benchmarkEntity: '行业', periodRule: 'same', label: '行业公开统计' },
  { id: 'wait-target', comparisonType: 'target', direction: 'lower-better', threshold: 20, thresholdVersion: 'wait-target@v1', actualMetric: 'support.wait_seconds', benchmarkMetric: 'support.target', periodRule: 'same', label: '目标等待时长' },
];

const DEFINITIONS: BenchmarkDefinition[] = DEFAULTS.map(item => ({ ...item }));

let configOverrides: BenchmarkOverride[] = [];
let configLoaded = false;

export function rememberBenchmarkConfig(config: BenchmarkConfig): void {
  configOverrides = [...config.overrides];
  configLoaded = config.loaded;
}

export function benchmarkConfigStatus(): { defaults: BenchmarkDefinition[]; current: BenchmarkDefinition[]; overrides: BenchmarkOverride[]; loaded: boolean } {
  return { defaults: defaultBenchmarkDefinitions(), current: listBenchmarkDefinitions(), overrides: configOverrides.map(item => ({ ...item })), loaded: configLoaded };
}

export function getBenchmarkDefinition(id: string): BenchmarkDefinition {
  const definition = DEFINITIONS.find(item => item.id === id);
  if (!definition) throw new Error(`benchmark_definition_rejected:${id}；可用 definitionId=${DEFINITIONS.map(item => item.id).join(', ')}`);
  return definition;
}

export function listBenchmarkDefinitions(): BenchmarkDefinition[] {
  return DEFINITIONS.map(item => ({ ...item }));
}

export function defaultBenchmarkDefinitions(): BenchmarkDefinition[] {
  return DEFAULTS.map(item => ({ ...item }));
}

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  if (!existsSync(path)) return { loaded: false, overrides: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('invalid_benchmark_config:文件不是合法 JSON'); }
  const record = parsed as Record<string, unknown>;
  const entries = Array.isArray(record?.definitions) ? record.definitions : null;
  if (!entries) throw new Error('invalid_benchmark_config:缺少 definitions 数组');
  const overrides: BenchmarkOverride[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const invalid = (detail: string): never => { throw new Error(`invalid_benchmark_config:${detail}`); };
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalid('条目必须是对象');
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || !DEFAULTS.some(def => def.id === item.id)) invalid(`未知基准 id=${String(item.id)}`);
    if (seen.has(String(item.id))) invalid(`重复基准 id=${String(item.id)}`);
    seen.add(String(item.id));
    const threshold = item.threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) invalid(`${String(item.id)} 阈值必须为正数`);
    const version = item.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) invalid(`${String(item.id)} version 必须为正整数`);
    if (item.reason !== undefined && typeof item.reason !== 'string') invalid(`${String(item.id)} reason 必须为字符串`);
    if (item.approvedAt !== undefined && typeof item.approvedAt !== 'string') invalid(`${String(item.id)} approvedAt 必须为字符串`);
    overrides.push({ id: String(item.id), threshold: threshold as number, version: version as number, ...(typeof item.reason === 'string' ? { reason: item.reason as string } : {}), ...(typeof item.approvedAt === 'string' ? { approvedAt: item.approvedAt as string } : {}) });
  }
  return { loaded: true, overrides };
}

export function applyBenchmarkConfig(config: BenchmarkConfig): void {
  DEFAULTS.forEach((def, index) => { DEFINITIONS[index] = { ...def }; });
  for (const override of config.overrides) {
    const definition = DEFINITIONS.find(item => item.id === override.id);
    if (!definition) throw new Error(`invalid_benchmark_config:未知基准 id=${override.id}`);
    definition.threshold = override.threshold;
    definition.thresholdVersion = `${override.id}@v${override.version}`;
  }
  rememberBenchmarkConfig(config);
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
