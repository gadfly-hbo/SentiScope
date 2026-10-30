import type { Reading, SourceConfig } from '../core/types.ts';

export class SourceError extends Error {
  readonly kind: 'timeout' | 'http' | 'parse';
  readonly statusCode?: number;
  constructor(kind: 'timeout' | 'http' | 'parse', message: string, statusCode?: number) {
    super(message); this.name = 'SourceError'; this.kind = kind; this.statusCode = statusCode;
  }
}

/** 只读适配器：按规则配置从来源读取一次原始数据。超时/HTTP/解析失败都是一等失败结果。 */
export async function fetchReading(source: SourceConfig, sourcePath: string, timeoutMs: number): Promise<Reading> {
  const url = new URL(sourcePath, source.baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new SourceError('timeout', `读取超时（${timeoutMs}ms）：${url}`);
    throw new SourceError('http', `读取失败：${err.message}`);
  }
  if (!response.ok) throw new SourceError('http', `来源返回 ${response.status}`, response.status);
  let body: unknown;
  try { body = await response.json(); }
  catch (e) { throw new SourceError('parse', `响应不是有效 JSON：${(e as Error).message}`); }
  const r = body as Partial<Reading>;
  if (typeof r.metricId !== 'string' || typeof r.entity !== 'string' || typeof r.unit !== 'string'
    || typeof r.refreshedAt !== 'string' || r.period == null || typeof r.value !== 'number') {
    throw new SourceError('parse', '响应缺少必要字段（metricId/entity/unit/refreshedAt/period/value）');
  }
  return body as Reading;
}
