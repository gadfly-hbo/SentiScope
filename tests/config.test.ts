import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { join } from 'node:path';
import { baseRule, baseSource, makeDataDir, repoRoot, writeConfigFiles } from './helpers.ts';

test('仓库默认配置可加载：1 来源 9 规则', () => {
  const config = loadConfig(join(repoRoot, 'config'));
  assert.equal(config.sources.length, 1);
  assert.equal(config.rules.length, 9);
  assert.equal(config.sources[0]?.readOnly, true);
});

test('readOnly 非只读被拒绝并给出原因', () => {
  const dir = makeDataDir();
  writeConfigFiles(dir, { sources: [{ ...baseSource, readOnly: false }] }, { rules: [baseRule()] });
  assert.throws(() => loadConfig(dir), /readOnly/);
});

test('缺失或非法字段被拒绝并给出原因', () => {
  const dir = makeDataDir();
  const { thresholdPct: _drop, ...missingThreshold } = baseRule();
  writeConfigFiles(dir, { sources: [baseSource] }, { rules: [missingThreshold] });
  assert.throws(() => loadConfig(dir), /thresholdPct/);

  const dir2 = makeDataDir();
  writeConfigFiles(dir2, { sources: [baseSource] }, { rules: [baseRule({ direction: 'sideways' as never })] });
  assert.throws(() => loadConfig(dir2), /direction/);
});

test('规则身份重复被拒绝', () => {
  const dir = makeDataDir();
  writeConfigFiles(dir, { sources: [baseSource] }, { rules: [baseRule(), baseRule()] });
  assert.throws(() => loadConfig(dir), /重复/);
});

test('sourceId 引用未定义来源被拒绝', () => {
  const dir = makeDataDir();
  writeConfigFiles(dir, { sources: [baseSource] }, { rules: [baseRule({ sourceId: 'no-such' })] });
  assert.throws(() => loadConfig(dir), /sourceId/);
});

test('JSON 解析失败给出文件级原因', () => {
  const dir = makeDataDir();
  writeConfigFiles(dir, { sources: [baseSource] }, { rules: [baseRule()] });
  writeFileSync(join(dir, 'sources.json'), '{ not json');
  assert.throws(() => loadConfig(dir), /解析失败/);
});
