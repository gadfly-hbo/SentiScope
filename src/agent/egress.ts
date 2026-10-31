import type { DatasetVersion, StandardRow } from '../core/mvp-types.ts';

export type EgressPolicy = {
  allowedDimensions: string[];
  forbiddenValues: string[];
};

export const DEFAULT_EGRESS: EgressPolicy = {
  allowedDimensions: ['closed', 'comparable', 'label'],
  forbiddenValues: [],
};

export function projectRowForModel(row: StandardRow, policy: EgressPolicy = DEFAULT_EGRESS): Record<string, unknown> {
  return {
    rowId: row.rowId,
    metricId: row.metricId,
    entity: row.entity,
    period: row.period,
    value: row.value,
    unit: row.unit,
    quality: row.quality,
    dimensions: Object.fromEntries(Object.entries(row.dimensions).filter(([key]) => policy.allowedDimensions.includes(key))),
    source: { assetSha256: row.source.assetSha256, kind: row.source.kind, locator: row.source.locator },
  };
}

export function projectDatasetForModel(dataset: DatasetVersion): Record<string, unknown> {
  return {
    id: dataset.id,
    version: dataset.version,
    rowCount: dataset.rows.length,
    quality: dataset.quality,
    stepCount: dataset.steps.length,
    sourceAssetCount: dataset.sourceAssetIds.length,
    sha256: dataset.sha256,
  };
}

export function assertEgressAllowed(payload: unknown, policy: EgressPolicy = DEFAULT_EGRESS): void {
  const serialized = JSON.stringify(payload);
  for (const value of policy.forbiddenValues) {
    if (value && serialized.includes(value)) throw new Error('egress_blocked');
  }
}

export function sanitizeEgressPayload<T>(payload: T, policy: EgressPolicy = DEFAULT_EGRESS): T {
  return redact(payload, policy.forbiddenValues.filter(Boolean)) as T;
}

function redact(value: unknown, forbidden: string[]): unknown {
  if (typeof value === 'string') {
    let output = value;
    for (const secret of forbidden) output = output.split(secret).join('[REDACTED]');
    return output;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, forbidden));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item, forbidden)]));
  return value;
}
