#!/usr/bin/env node
// SentiScope 切片一启动入口：合成 BI 模拟源 + loopback 管理宿主 + 会话探针。
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.ts';
import { startHost } from '../src/host/server.ts';
import { probeSession } from '../src/host/session-probe.ts';
import { startSyntheticSource } from '../src/source/synthetic-server.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const dataDir = process.env.SENTISCOPE_HOME ?? join(homedir(), '.sentiscope', 'slice1');
mkdirSync(dataDir, { recursive: true });

const sourcePort = Number(process.env.SENTISCOPE_SOURCE_PORT ?? 4181);
const hostPort = Number(process.env.SENTISCOPE_HOST_PORT ?? 4180);

const { server: sourceServer, url: sourceUrl } = await startSyntheticSource(sourcePort, join(root, 'fixtures'));
const config = loadConfig(join(root, 'config'));
if (!config.sources[0]) throw new Error('config/sources.json 未定义来源');
config.sources[0].baseUrl = sourceUrl;

const host = await startHost({ port: hostPort, dataDir, config, skillsDir: join(root, 'skills') });

console.log(`[SentiScope] 数据目录：${dataDir}`);
console.log(`[SentiScope] 合成 BI 模拟源：${sourceUrl}（只读，全部为合成数据）`);
console.log(`[SentiScope] 管理界面：${host.url}`);

try {
  const probe = await probeSession(join(root, 'skills'));
  console.log(`[SentiScope] 会话探针：${probe.ok ? '通过' : '失败'}；skills=${probe.skills.map((s) => s.name).join(',') || '无'}；活动工具=${probe.activeTools.join(',')}`);
  for (const line of probe.log) console.log(`[probe] ${line}`);
} catch (e) {
  console.warn(`[SentiScope] 会话探针失败：${(e).message ?? e}`);
}

console.log('[SentiScope] Ctrl+C 停止（非常驻，阶段 1）。');
const shutdown = () => {
  host.server.close();
  sourceServer.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
