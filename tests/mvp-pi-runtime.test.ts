import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { guardProviderPayload, PiAgentRuntime } from '../src/agent/pi-runtime.ts';
import { assertEgressAllowed, projectRowForModel, sanitizeEgressPayload } from '../src/agent/egress.ts';
import type { DatasetVersion, StandardRow } from '../src/core/mvp-types.ts';
import type { ExplorationTools } from '../src/agent/exploration-service.ts';
import { makeDataDir, repoRoot } from './helpers.ts';

const row: StandardRow = {
  rowId: 'row-1', metricId: 'revenue', entity: '华东', period: '2026-09', value: 880, unit: '万元', quality: 'usable', issues: [],
  dimensions: { label: '收入', secret: '内部秘密' }, source: { assetSha256: 'a'.repeat(64), kind: 'raw', locator: 'row:2' },
};
const dataset: DatasetVersion = {
  id: 'dataset-test', version: 1, name: '测试', createdAt: '2026-10-03', sourceAssetIds: [], rows: [row], rawRows: [], fields: [], steps: [],
  quality: { usable: 1, blocked: 0, needsEvidence: 0 }, sha256: 'hash',
};

test('SEC-01：模型行投影丢弃未批准字段，provider 请求禁止出现内部值', () => {
  const projected = projectRowForModel(row, { allowedDimensions: ['label'], forbiddenValues: ['内部秘密'] });
  assert.equal(JSON.stringify(projected).includes('内部秘密'), false);
  assert.deepEqual(projected.dimensions, { label: '收入' });
  assert.throws(() => assertEgressAllowed({ messages: [{ text: '值=内部秘密' }] }, { allowedDimensions: [], forbiddenValues: ['内部秘密'] }), /egress_blocked/);
  const sanitized = sanitizeEgressPayload({ messages: [{ role: 'user', text: '值=内部秘密' }] }, { allowedDimensions: [], forbiddenValues: ['内部秘密'] });
  assert.equal(sanitized.messages[0]!.text, '值=[REDACTED]');
  assert.equal(JSON.stringify(sanitized).includes('内部秘密'), false);
  const guarded = guardProviderPayload({ messages: [{ text: '内部秘密' }] }, { allowedDimensions: [], forbiddenValues: ['内部秘密'] });
  assert.equal(JSON.stringify(guarded).includes('内部秘密'), false);
});

test('真实 SDK 路径可注入受控会话：prompt 调用、工具白名单与资源清理', async () => {
  let prompt = '';
  let disposed = false;
  const captured: Record<string, unknown>[] = [];
  const runtime = new PiAgentRuntime({
    skillsDir: join(repoRoot, 'skills'), cwd: makeDataDir(), model: 'pi-test', egress: { allowedDimensions: ['label'], forbiddenValues: ['内部秘密'] },
    sessionFactory: async options => {
      captured.push(options);
      return { session: {
        prompt: async text => { prompt = text; },
        getLastAssistantText: () => '受控完成',
        subscribe: () => () => undefined,
        abort: async () => undefined,
        dispose: () => { disposed = true; },
        sessionManager: { getSessionId: () => 'session-test-1' },
        agent: { state: { model: { id: 'model-x', provider: 'test-provider' } } },
      } };
    },
  });
  const tools = {
    profile: async () => ({ rows: 1, quality: dataset.quality, fields: [], steps: 0 }),
    query: async () => [row],
    compare: async () => { throw new Error('not_used'); },
    propose: async () => { throw new Error('not_used'); },
    observe: async () => { throw new Error('not_used'); },
    setCoverage: async () => undefined,
  } as unknown as ExplorationTools;
  const outcome = await runtime.run({ tools, dataset });
  assert.equal(outcome.stopReason, '受控完成');
  assert.equal(outcome.model, 'test-provider:model-x');
  assert.equal(outcome.sessionId, 'session-test-1');
  assert.match(prompt, /只能使用 sentiscope_/);
  assert.equal(prompt.includes('内部秘密'), false);
  assert.equal(disposed, true);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!.tools, ['sentiscope_profile', 'sentiscope_query', 'sentiscope_clean', 'sentiscope_public_fetch', 'sentiscope_compare', 'sentiscope_propose', 'sentiscope_observe', 'sentiscope_coverage']);
});

test('失败会话仍保留身份，SDK 事件脱敏，空文本有安全回退', async () => {
  const events: Array<Record<string, unknown>> = [];
  const identities: Array<Record<string, unknown>> = [];
  const runtime = new PiAgentRuntime({
    skillsDir: join(repoRoot, 'skills'), cwd: makeDataDir(), egress: { allowedDimensions: [], forbiddenValues: ['内部秘密'] },
    sessionFactory: async () => {
      let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
      return { session: {
        prompt: async () => { listener?.({ type: 'secret', text: '内部秘密' }); const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
        getLastAssistantText: () => undefined,
        subscribe: callback => { listener = callback; return () => undefined; },
        abort: async () => undefined, dispose: () => undefined,
        sessionManager: { getSessionId: () => 'session-failed' },
        agent: { state: { model: { id: 'model-failed', provider: 'test' } } },
      } };
    },
  });
  const tools = { profile: async () => ({ rows: 0, quality: dataset.quality, fields: [], steps: 0 }) } as unknown as ExplorationTools;
  await assert.rejects(runtime.run({ tools, dataset, onSdkEvent: event => events.push(event), onSession: identity => identities.push(identity) }), /aborted/);
  assert.equal(identities[0]!.sessionId, 'session-failed');
  assert.equal(events[0]!.text, '[REDACTED]');
});
