import { randomUUID } from 'node:crypto';
import type { SentiscopeConfig } from '../core/config.ts';
import { EvidenceStore } from '../core/evidence.ts';
import { observationIdentity, runPipeline } from '../core/pipeline.ts';
import { ObservationStore, summarizeRun } from '../core/observation-store.ts';
import type { Observation, Reading, RuleConfig, RunSummary } from '../core/types.ts';
import { fetchReading, SourceError } from '../source/adapter.ts';

export type RoundOptions = {
  config: SentiscopeConfig;
  dataDir: string;
  now: Date;
  runId?: string;
  timeoutMs?: number;
};

/** 一轮观察：逐条规则读取 → 存证 → 口径校验 → 四态观察落库。采集失败也是一等结果。 */
export async function runObservationRound(options: RoundOptions): Promise<RunSummary> {
  const { config, dataDir, now } = options;
  const timeoutMs = options.timeoutMs ?? 2000;
  const runId = options.runId ?? `run-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const evidence = new EvidenceStore(dataDir);
  const store = new ObservationStore(dataDir);
  const observations: Observation[] = [];
  try {
    for (const rule of config.rules) {
      const source = config.sources.find((s) => s.id === rule.sourceId);
      if (!source) throw new Error(`规则 ${rule.id} 引用了未定义来源 ${rule.sourceId}`);
      const locator = `${source.scope.dashboard}${rule.sourcePath}`;
      const capturedAt = now.toISOString();
      try {
        const reading = await fetchReading(source, rule.sourcePath, timeoutMs);
        const record = evidence.append(reading, locator, capturedAt);
        observations.push(buildObservation({ runId, rule, reading, capturedAt, evidenceSha256: record.sha256, locator }));
      } catch (e) {
        if (e instanceof SourceError) {
          observations.push(failedObservation({ runId, rule, capturedAt, locator, cause: `${e.kind === 'timeout' ? '读取超时' : e.kind === 'http' ? `来源返回异常（${e.statusCode ?? e.message}）` : '响应解析失败'}` }));
          continue;
        }
        throw e;
      }
    }
  } finally {
    store.append(observations);
    store.close();
  }
  return summarizeRun(runId, observations);
}

function buildObservation(args: { runId: string; rule: RuleConfig; reading: Reading; capturedAt: string; evidenceSha256: string; locator: string }): Observation {
  const { runId, rule, reading, capturedAt, evidenceSha256, locator } = args;
  const result = runPipeline(reading, rule, { now: new Date(capturedAt) });
  return {
    runId,
    identity: observationIdentity(rule, reading.period.label),
    ruleId: rule.id,
    ruleVersion: rule.version,
    metricId: rule.metricId,
    metricName: rule.metricName,
    entity: reading.entity,
    periodLabel: reading.period.label,
    status: result.status,
    reason: result.reason,
    checks: result.checks,
    facts: result.facts,
    evidenceSha256,
    locator,
    capturedAt,
    sourceRefreshedAt: reading.refreshedAt,
    unknownNote: result.unknownNote,
  };
}

function failedObservation(args: { runId: string; rule: RuleConfig; capturedAt: string; locator: string; cause: string }): Observation {
  const { runId, rule, capturedAt, locator, cause } = args;
  return {
    runId,
    identity: `failed-${randomUUID().slice(0, 16)}`,
    ruleId: rule.id,
    ruleVersion: rule.version,
    metricId: rule.metricId,
    metricName: rule.metricName,
    entity: rule.entity,
    periodLabel: '—',
    status: 'failed',
    reason: `采集失败：${cause}`,
    checks: [{ mark: 'block', name: '读取', note: cause }, { mark: 'hold', name: '后续环节', note: '不判定、不猜测数值' }],
    facts: { 读取结果: '失败，无有效响应', 规则: `${rule.id}@v${rule.version}` },
    evidenceSha256: null,
    locator,
    capturedAt,
    sourceRefreshedAt: null,
    unknownNote: '采集失败为一等结果；恢复后按原观察身份重读，不生成差距。',
  };
}
