#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../src/host/server.ts';
import { probeSession } from '../src/host/session-probe.ts';
import { PiAgentRuntime } from '../src/agent/pi-runtime.ts';
import { createDemoResearch, createDemoRuntime } from '../src/host/demo.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const dataDir = process.env.SENTISCOPE_HOME ?? join(homedir(), '.sentiscope', 'mvp');
mkdirSync(dataDir, { recursive: true });
const hostPort = Number(process.env.SENTISCOPE_HOST_PORT ?? 4180);
const realModel = process.env.SENTISCOPE_REAL_MODEL === '1';
const forbiddenValues = (process.env.SENTISCOPE_EGRESS_BLOCK ?? '').split('\n').filter(Boolean);

const host = await startHost({
  port: hostPort,
  dataDir,
  skillsDir: join(root, 'skills'),
  fixturesDir: join(root, 'fixtures', 'mvp'),
  seedDemo: !realModel,
  forbiddenValues,
  maxToolCalls: Number(process.env.SENTISCOPE_MAX_TOOL_CALLS ?? 40),
  runtimeFactory: realModel
    ? () => new PiAgentRuntime({ skillsDir: join(root, 'skills'), cwd: dataDir, model: process.env.SENTISCOPE_MODEL ?? 'pi-configured', egress: { allowedDimensions: ['closed', 'comparable', 'label'], forbiddenValues } })
    : (dataset, mode) => createDemoRuntime(dataset, mode),
  researchFactory: realModel
    ? undefined
    : ({ store, mode }) => mode === 'zero' ? undefined : createDemoResearch(store, join(root, 'fixtures', 'mvp'), mode === 'limited' ? { maxSearches: 1, maxFetches: 1, maxSnapshotReads: 2 } : undefined),
});

console.log(`[SentiScope] 数据目录：${dataDir}`);
console.log(`[SentiScope] 管理界面：${host.url}`);
console.log(`[SentiScope] 探索模式：${realModel ? '真实模型（使用已保存的 Pi 配置）' : '合成受控演示（不调用模型）'}`);
console.log(`[SentiScope] 公网检索：${host.research.enabled
  ? `启用，Provider=${host.research.providers.join(',')}，优先域=${host.research.preferredDomains.join(',') || '空'}，预算=${JSON.stringify(host.research.budget)}`
  : `未配置（${join(dataDir, 'search.json')}），探索只使用导入数据`}${realModel ? '' : '；演示 limited 运行使用本地 fixture Provider，不出网'}`);

try {
  const probe = await probeSession(join(root, 'skills'));
  console.log(`[SentiScope] 会话探针：${probe.ok ? '通过' : '失败'}；skills=${probe.skills.map(skill => skill.name).join(',') || '无'}；活动工具=${probe.activeTools.join(',')}`);
} catch (error) {
  console.warn(`[SentiScope] 会话探针失败：${error.message ?? error}`);
}

console.log('[SentiScope] Ctrl+C 停止（非常驻，阶段 1）。');
if (process.platform === 'darwin' && process.env.SENTISCOPE_NO_OPEN !== '1') {
  execFile('open', [host.url], error => {
    if (error) console.warn(`[SentiScope] 浏览器唤起失败：${error.message}`);
  });
}
const shutdown = () => {
  host.server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
