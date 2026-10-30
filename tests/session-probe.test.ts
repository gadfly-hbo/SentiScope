import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeSession } from '../src/host/session-probe.ts';
import { repoRoot } from './helpers.ts';

test('会话探针：skill 发现、自定义工具注册、事件订阅、正常结束（不调用模型）', async () => {
  const result = await probeSession(join(repoRoot, 'skills'));
  assert.equal(result.ok, true);
  assert.ok(result.skills.some((s) => s.name === 'caliber-validation'), '应发现口径校验 skill');
  assert.ok(result.activeTools.includes('read'), '只读工具集应激活');
  assert.equal(result.customToolActive, true);
  assert.equal(result.eventSubscription, 'installed');
  assert.equal(result.sessionDisposed, true);
  assert.ok(result.log.some((l) => l.includes('会话创建成功')));
});
