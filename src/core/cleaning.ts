import type { CleaningStep, DatasetVersion, RawRow, StandardRow } from './mvp-types.ts';
import { canonicalJson, sha256 } from './raw-evidence.ts';

type CleanOptions = {
  name: string;
  version: number;
  now: string;
  sourceAssetIds: string[];
  rawRows: RawRow[];
  entityAliases?: Record<string, string>;
};

export function standardizeDataset(options: CleanOptions): DatasetVersion {
  const aliases: Record<string, string> = { '华东区': '华东', '华南区': '华南', '西南区': '西南', ...options.entityAliases };
  const steps: CleaningStep[] = [];
  let rows = options.rawRows.map(mapRow);
  rows = applyStep(rows, steps, 'field_mapping', { fields: ['metric', 'entity', 'period', 'value', 'unit'] }, row => ({ ...row }));
  rows = applyStep(rows, steps, 'period_normalization', { timezone: 'Asia/Shanghai' }, normalizePeriod);
  rows = applyStep(rows, steps, 'unit_normalization', { '元': { unit: '万元', factor: 0.0001 }, '千元': { unit: '万元', factor: 0.1 } }, normalizeUnit);
  rows = applyStep(rows, steps, 'entity_alias', aliases, row => aliases[row.entity] ? { ...row, entity: aliases[row.entity]! } : { ...row });
  rows = applyStep(rows, steps, 'duplicate_isolation', { key: ['metricId', 'entity', 'period'] }, isolateDuplicates);
  rows = applyStep(rows, steps, 'quality_gate', { allowed: ['usable', 'blocked', 'needs_evidence'] }, row => ({ ...row }));
  const quality = {
    usable: rows.filter(row => row.quality === 'usable').length,
    blocked: rows.filter(row => row.quality === 'blocked').length,
    needsEvidence: rows.filter(row => row.quality === 'needs_evidence').length,
  };
  const fields = [...new Set(options.rawRows.flatMap(row => Object.keys(row.values)))];
  const fingerprint = canonicalJson({ name: options.name, version: options.version, sourceAssetIds: options.sourceAssetIds, rows, steps, quality });
  const hash = sha256(fingerprint);
  return {
    id: `dataset-${hash.slice(0, 16)}`,
    version: options.version,
    name: options.name,
    createdAt: options.now,
    sourceAssetIds: options.sourceAssetIds,
    rows,
    rawRows: options.rawRows,
    fields,
    steps,
    quality,
    sha256: hash,
  };
}

function mapRow(raw: RawRow): StandardRow {
  const text = String(raw.values.value ?? '').trim();
  const numeric = text === '' ? null : Number(text);
  const issues = [...raw.issues];
  if (numeric == null) issues.push('missing_value');
  else if (!Number.isFinite(numeric)) issues.push('invalid_value');
  const metricId = String(raw.values.metric ?? '').trim();
  const entity = String(raw.values.entity ?? '').trim();
  if (!metricId) issues.push('missing_metric');
  if (!entity) issues.push('missing_entity');
  const main = new Set(['metric', 'entity', 'period', 'value', 'unit']);
  const dimensions = Object.fromEntries(Object.entries(raw.values).filter(([key]) => !main.has(key)).map(([key, value]) => [key, String(value ?? '')]));
  return {
    rowId: `row-${sha256(`${raw.source.assetSha256}:${raw.source.locator}:${metricId}:${entity}:${String(raw.values.period ?? '').trim()}`).slice(0, 16)}`,
    metricId,
    entity,
    period: String(raw.values.period ?? '').trim(),
    value: numeric != null && Number.isFinite(numeric) ? numeric : null,
    unit: String(raw.values.unit ?? '').trim(),
    dimensions,
    quality: !metricId || !entity ? 'blocked' : 'usable',
    issues,
    source: raw.source,
  };
}

function normalizePeriod(row: StandardRow): StandardRow {
  const slash = /^(\d{4})\/(\d{1,2})$/.exec(row.period);
  const period = slash ? `${slash[1]}-${slash[2]!.padStart(2, '0')}` : row.period;
  if (!validPeriod(period)) return block({ ...row, period }, 'invalid_period');
  return { ...row, period };
}

function validPeriod(period: string): boolean {
  if (/^\d{4}Q[1-4]$/.test(period)) return true;
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(period);
  if (!match) return false;
  if (!match[3]) return true;
  const days = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return Number(match[3]) <= days;
}

function normalizeUnit(row: StandardRow): StandardRow {
  if (row.value == null) return block(row, row.issues.includes('missing_value') ? 'missing_value' : 'invalid_value');
  if (row.unit === '元') return { ...row, value: row.value / 10_000, unit: '万元' };
  if (row.unit === '千元') return { ...row, value: row.value / 1_000, unit: '万元' };
  if (['万元', '秒', '单', '%', '百分点'].includes(row.unit)) return { ...row };
  return block({ ...row, value: null }, 'unknown_unit');
}

function isolateDuplicates(row: StandardRow, _index: number, rows: StandardRow[]): StandardRow {
  const duplicates = rows.filter(other => other.metricId === row.metricId && other.entity === row.entity && other.period === row.period);
  return duplicates.length > 1 ? block(row, 'duplicate') : row;
}

function block(row: StandardRow, issue: string): StandardRow {
  return { ...row, quality: 'blocked', issues: [...new Set([...row.issues, issue])] };
}

function applyStep(rows: StandardRow[], steps: CleaningStep[], kind: string, params: Record<string, unknown>, change: (row: StandardRow, index: number, rows: StandardRow[]) => StandardRow): StandardRow[] {
  const before = rows;
  const inputHash = sha256(canonicalJson(before));
  const after = before.map((row, index) => {
    const next = change(row, index, before);
    if (next.issues.includes('cached_formula') || next.issues.includes('cached_formula_missing')) next.quality = next.quality === 'usable' ? 'needs_evidence' : next.quality;
    return next;
  });
  const affectedRows = before.flatMap((row, index) => canonicalJson(row) !== canonicalJson(after[index]) ? [row.rowId] : []);
  steps.push({ id: `step-${steps.length + 1}`, kind, version: 1, params, inputHash, outputHash: sha256(canonicalJson(after)), affectedRows });
  return after;
}
