import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuleConfig, SourceConfig } from '../src/core/types.ts';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'sentiscope-test-'));
}

/** 临时配置目录：sources.json 指向给定 baseUrl，rules.json 复用仓库合成规则。 */
export function makeConfigDir(baseUrl: string): string {
  const dir = makeDataDir();
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({
    sources: [{ id: 'synthetic-a', kind: 'http', baseUrl, readOnly: true, scope: { dashboard: 'dash-east-ops', entities: ['华东', '华南', '华中', '华北', '西南', '全公司'] } }],
  }, null, 2));
  writeFileSync(join(dir, 'rules.json'), readFileSync(join(repoRoot, 'config', 'rules.json'), 'utf8'));
  return dir;
}

export function writeConfigFiles(dir: string, sources: unknown, rules: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sources.json'), JSON.stringify(sources));
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules));
  return dir;
}

export const baseSource: SourceConfig = { id: 'synthetic-a', kind: 'http', baseUrl: 'http://127.0.0.1:4181', readOnly: true, scope: { dashboard: 'dash-east-ops', entities: ['华东'] } };

export function baseRule(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    id: 'rule-east-revenue',
    version: 1,
    sourceId: 'synthetic-a',
    sourcePath: '/dashboards/dash-east-ops/metrics/obs02-gap-revenue',
    metricId: 'metric.revenue.monthly',
    metricName: '月收入',
    entity: '华东',
    periodKind: 'month',
    direction: 'higher-better',
    unit: '万元',
    target: 1000,
    thresholdPct: 10,
    maxStalenessDays: 3,
    requiresClosedPeriod: true,
    hasTrajectory: false,
    expectedFilters: { region: ['华东'] },
    ...overrides,
  };
}

export const NOW = new Date('2026-10-02T08:10:00+08:00');
