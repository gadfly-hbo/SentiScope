import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importFile } from '../src/core/import.ts';
import { standardizeDataset } from '../src/core/cleaning.ts';
import { makeDataDir } from './helpers.ts';

const NOW = '2026-10-03T01:42:00.000Z';

async function raw(csv: string) {
  return (await importFile({ rootDir: makeDataDir(), name: '经营.csv', bytes: Buffer.from(csv), now: NOW })).rawRows;
}

test('CLN-01/02：画像、单位、别名、重复隔离、行级血缘与可重放', () => {
  const rawRows = [
    ...rawRowsSync('revenue,华东区,2026/09,8800000,元\nrevenue,华东,2026-09,880,万元\nrevenue,华东,2026-09,880,万元\nwait,华南,2026-09,46,秒\n'),
  ];
  const options = { name: '经营数据集', version: 3, now: NOW, sourceAssetIds: ['asset-a'], rawRows };
  const first = standardizeDataset(options);
  const second = standardizeDataset(options);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.id, second.id);
  assert.equal(first.rows[0]!.value, 880);
  assert.equal(first.rows[0]!.unit, '万元');
  assert.equal(first.rows[0]!.entity, '华东');
  assert.equal(first.rows[0]!.period, '2026-09');
  assert.equal(first.rows.filter(row => row.quality === 'blocked' && row.issues.includes('duplicate')).length, 3);
  assert.equal(first.rows[3]!.quality, 'usable');
  assert.ok(first.steps.length >= 4);
  assert.ok(first.steps.every(step => step.inputHash && step.outputHash && step.version === 1));
  assert.notEqual(first.rows[0]!.source.locator, first.rows[1]!.source.locator);
  assert.equal(rawRows[0]!.values.value, '8800000', '原始行不得被修改');
});

test('CLN-03：未知单位、缺失值和非法期间被隔离，不猜值', () => {
  const dataset = standardizeDataset({
    name: '异常', version: 1, now: NOW, sourceAssetIds: ['asset-a'],
    rawRows: rawRowsSync('revenue,华东,2026-09,880,不明\nrevenue,华南,2026-09,,万元\nrevenue,西南,九月,938,万元\nrevenue,华北,2026-09,900,万元\n'),
  });
  assert.equal(dataset.rows[0]!.quality, 'blocked');
  assert.equal(dataset.rows[0]!.value, null);
  assert.ok(dataset.rows[0]!.issues.includes('unknown_unit'));
  assert.equal(dataset.rows[1]!.quality, 'blocked');
  assert.equal(dataset.rows[2]!.quality, 'blocked');
  assert.equal(dataset.rows[3]!.quality, 'usable');
  assert.equal(dataset.quality.blocked, 3);
  assert.equal(dataset.quality.usable, 1);
});

function rawRowsSync(csv: string) {
  const lines = csv.trim().split('\n');
  return lines.map((line, index) => {
    const [metric, entity, period, value, unit] = line.split(',');
    return {
      rowNumber: index + 2,
      values: { metric, entity, period, value, unit },
      issues: [],
      source: { assetSha256: 'a'.repeat(64), kind: 'raw' as const, locator: `row:${index + 2}` },
    };
  });
}

test('CLN-02：亿元按确定性换算进入万元标准单位', () => {
  const rawRows = [{ rowNumber: 2, values: { metric: 'revenue', entity: '行业', period: '2026Q3', value: '375367', unit: '亿元', closed: 'true', comparable: 'true', scope: '同一细分市场', currency: 'CNY', region: '同一地域' }, issues: [], source: { assetSha256: 'b'.repeat(64), kind: 'web' as const, locator: 'snapshot:snap-1:quote:0-10' } }];
  const dataset = standardizeDataset({ name: '外部基准', version: 1, now: NOW, sourceAssetIds: ['asset-b'], rawRows });
  assert.equal(dataset.rows[0]!.value, 3753670000);
  assert.equal(dataset.rows[0]!.unit, '万元');
  assert.equal(dataset.rows[0]!.quality, 'usable');
  assert.equal(dataset.rows[0]!.issues.includes('unknown_unit'), false);
});
