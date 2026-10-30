import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuleConfig, SourceConfig } from './types.ts';

export type SentiscopeConfig = { sources: SourceConfig[]; rules: RuleConfig[] };

const SOURCE_KINDS = ['http'];
const PERIOD_KINDS = ['month', 'week'];
const DIRECTIONS = ['higher-better', 'lower-better'];

/** 声明式配置加载与校验：任何字段缺失、类型或枚举非法都拒绝，并给出原因。 */
export function loadConfig(configDir: string): SentiscopeConfig {
  const sources = parseJson(join(configDir, 'sources.json'));
  const rules = parseJson(join(configDir, 'rules.json'));
  const sourceErrors: string[] = [];
  const validatedSources: SourceConfig[] = [];
  if (!Array.isArray(sources.sources)) throw new ConfigError('sources.json: 缺少 sources 数组');
  for (const [i, s] of sources.sources.entries()) {
    const errs: string[] = [];
    if (typeof s?.id !== 'string' || !s.id.trim()) errs.push('id 必须为非空字符串');
    if (!SOURCE_KINDS.includes(s?.kind)) errs.push(`kind 必须为 ${SOURCE_KINDS.join('/')}`);
    if (typeof s?.baseUrl !== 'string' || !/^https?:\/\//.test(s.baseUrl)) errs.push('baseUrl 必须为 http(s) URL');
    if (s?.readOnly !== true) errs.push('readOnly 必须为 true（只读优先是硬边界）');
    if (typeof s?.scope?.dashboard !== 'string' || !Array.isArray(s?.scope?.entities)) errs.push('scope.dashboard 与 scope.entities 必填');
    if (errs.length) sourceErrors.push(`sources[${i}]: ${errs.join('；')}`);
    else validatedSources.push(s as SourceConfig);
  }
  if (sourceErrors.length) throw new ConfigError(sourceErrors.join('｜'));

  const ruleErrors: string[] = [];
  const validatedRules: RuleConfig[] = [];
  if (!Array.isArray(rules.rules)) throw new ConfigError('rules.json: 缺少 rules 数组');
  const sourceIds = new Set(validatedSources.map((s) => s.id));
  for (const [i, r] of rules.rules.entries()) {
    const errs: string[] = [];
    if (typeof r?.id !== 'string' || !r.id.trim()) errs.push('id 必须为非空字符串');
    if (!Number.isSafeInteger(r?.version) || r.version < 1) errs.push('version 必须为正整数');
    if (typeof r?.sourceId !== 'string' || !sourceIds.has(r.sourceId)) errs.push('sourceId 必须引用已定义来源');
    if (typeof r?.sourcePath !== 'string' || !r.sourcePath.startsWith('/')) errs.push('sourcePath 必须为以 / 开头的路径');
    if (typeof r?.metricId !== 'string' || !r.metricId.trim()) errs.push('metricId 必填');
    if (typeof r?.metricName !== 'string' || !r.metricName.trim()) errs.push('metricName 必填');
    if (typeof r?.entity !== 'string' || !r.entity.trim()) errs.push('entity 必填');
    if (!PERIOD_KINDS.includes(r?.periodKind)) errs.push(`periodKind 必须为 ${PERIOD_KINDS.join('/')}`);
    if (!DIRECTIONS.includes(r?.direction)) errs.push(`direction 必须为 ${DIRECTIONS.join('/')}`);
    if (typeof r?.unit !== 'string' || !r.unit.trim()) errs.push('unit 必填');
    if (typeof r?.target !== 'number' || !Number.isFinite(r.target)) errs.push('target 必须为有限数值');
    if (typeof r?.thresholdPct !== 'number' || !(r.thresholdPct > 0)) errs.push('thresholdPct 必须为正数');
    if (typeof r?.maxStalenessDays !== 'number' || !(r.maxStalenessDays > 0)) errs.push('maxStalenessDays 必须为正数');
    if (typeof r?.requiresClosedPeriod !== 'boolean') errs.push('requiresClosedPeriod 必须为布尔值');
    if (typeof r?.hasTrajectory !== 'boolean') errs.push('hasTrajectory 必须为布尔值');
    if (r?.expectedFilters != null && typeof r.expectedFilters !== 'object') errs.push('expectedFilters 必须为对象');
    if (r?.denominatorMetric != null && typeof r.denominatorMetric !== 'boolean') errs.push('denominatorMetric 必须为布尔值');
    if (errs.length) ruleErrors.push(`rules[${i}]: ${errs.join('；')}`);
    else validatedRules.push(r as RuleConfig);
  }
  if (ruleErrors.length) throw new ConfigError(ruleErrors.join('｜'));

  const ruleIds = new Set<string>();
  for (const r of validatedRules) {
    if (ruleIds.has(r.id)) throw new ConfigError(`rules.json: 规则身份重复 ${r.id}`);
    ruleIds.add(r.id);
  }
  return { sources: validatedSources, rules: validatedRules };
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

function parseJson(file: string): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch { throw new ConfigError(`无法读取配置文件 ${file}`); }
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch (e) { throw new ConfigError(`${file}: JSON 解析失败（${(e as Error).message}）`); }
}
