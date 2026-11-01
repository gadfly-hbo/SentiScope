#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadWebResearchConfig } from '../src/source/web-research.ts';

const dataDir = process.env.SENTISCOPE_HOME ?? join(homedir(), '.sentiscope', 'mvp');
const pin = process.env.SENTISCOPE_MODEL ?? '';
const forbiddenValues = (process.env.SENTISCOPE_EGRESS_BLOCK ?? '').split('\n').filter(Boolean);
let failures = 0;
const fail = message => { failures += 1; console.log(`  ✗ ${message}`); };
const ok = message => console.log(`  ✓ ${message}`);

console.log('SentiScope 授权预检（只读本地配置，不调用模型、不访问公网）');
console.log(`数据目录：${dataDir}\n`);

console.log('一、真实模型授权（尚未执行任何模型调用）');
try {
  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailable();
  if (available.length) ok(`本地 Pi 配置可用模型 ${available.length} 个：${available.map(model => `${model.provider}/${model.id}`).join('、')}`);
  else console.log('  ! 本地 Pi 配置没有可用模型（请先在 Pi 中配置 provider 与密钥）。');
  if (pin) {
    const [provider, ...rest] = pin.split(':');
    const model = runtime.getModel(provider, rest.join(':'));
    if (model) ok(`请求固定模型 ${pin} 可解析；运行时将只使用该模型`);
    else fail(`请求固定模型 ${pin} 无法解析（未在 Pi 配置中注册或缺少密钥）`);
  } else console.log('  ! 未设置 SENTISCOPE_MODEL：将使用 Pi 默认模型。验收建议固定 provider:model-id。');
} catch (error) {
  fail(`读取 Pi 模型配置失败：${error.message}`);
}
console.log(`  出口策略：允许进入模型的维度字段 = closed/comparable/label；禁止值 ${forbiddenValues.length} 条（SENTISCOPE_EGRESS_BLOCK，按行提供）`);
console.log(`  工具预算上限：${process.env.SENTISCOPE_MAX_TOOL_CALLS ?? 40} 次工具调用（SENTISCOPE_MAX_TOOL_CALLS）\n`);

console.log('二、真实搜索 Provider 授权（尚未执行任何搜索或页面读取）');
const configPath = join(dataDir, 'search.json');
if (!existsSync(configPath)) {
  console.log(`  ! 未找到 ${configPath}；未配置时探索只使用导入数据。可参考 config/search.example.json 创建。`);
} else {
  try {
    const config = loadWebResearchConfig(configPath);
    if (!config.providers.length) console.log('  ! search.json 没有 providers。');
    for (const provider of config.providers) {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      const entry = (raw.providers ?? []).find(item => item.name === provider.name) ?? {};
      const endpoint = new URL(entry.endpoint);
      if (endpoint.protocol === 'https:') ok(`Provider ${provider.name} 端点 https：${endpoint.origin}`);
      else fail(`Provider ${provider.name} 端点不是 https：${endpoint.origin}`);
      if (entry.apiKeyEnv) {
        if (process.env[entry.apiKeyEnv]) ok(`密钥环境变量 ${entry.apiKeyEnv} 已设置（仅检查存在性，不读取值）`);
        else fail(`密钥环境变量 ${entry.apiKeyEnv} 未设置`);
      } else console.log(`  ! Provider ${provider.name} 未声明 apiKeyEnv（如该服务无需密钥可忽略）`);
    }
    ok(`优先域：${config.preferredDomains.join('、') || '未设置（全部按域名规则分级）'}`);
    ok(`配额：${JSON.stringify(config.budget ?? { maxSearches: 8, maxFetches: 6, maxSnapshotReads: 20 })}`);
  } catch (error) {
    fail(`search.json 无效：${error.message}`);
  }
}

console.log('\n三、仍需你逐项确认的授权决定（两项授权分别记录，互不能推导）');
console.log('  [ ] 真实模型：固定 provider:model-id、工具预算、允许进入模型的数据字段与出口、用于验收的数据范围（合成 fixture 或明确授权的导入数据）。');
console.log('  [ ] 真实搜索 Provider：endpoint 与字段映射、密钥只经环境变量、搜索/抓取/快照读取配额、优先来源域名、允许检索的业务范围（不得包含内部数据）。');
console.log('  确认后按 openspec/changes/slice2-exploration-candidates/authorization.md 记录，再分别执行真实验收。');
if (failures) { console.log(`\n预检未通过：${failures} 项需要处理。`); process.exit(1); }
console.log('\n预检完成：未执行任何真实调用。');
