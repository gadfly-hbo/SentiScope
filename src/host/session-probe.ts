import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  loadSkillsFromDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export type ProbeResult = {
  ok: boolean;
  skills: { name: string; description: string }[];
  skillDiagnostics: Array<Record<string, unknown>>;
  activeTools: string[];
  customToolActive: boolean;
  eventSubscription: 'installed' | 'failed';
  sessionDisposed: boolean;
  log: string[];
};

/**
 * 会话探针（不调用真实模型）：验证 headless pi-coding-agent 宿主的真实集成路径——
 * skill 发现与注入、自定义工具注册、只读工具集、事件订阅、正常结束。
 */
export async function probeSession(skillsDir: string): Promise<ProbeResult> {
  const log: string[] = [];
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: 'sentiscope' });
  log.push(`loadSkillsFromDir: 发现 ${skills.length} 个 skill（${skills.map((s) => s.name).join(', ') || '无'}），${diagnostics.length} 条诊断`);

  const cwd = mkdtempSync(join(tmpdir(), 'sentiscope-probe-cwd-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'sentiscope-probe-agent-'));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    skillsOverride: (current) => ({
      skills: [...current.skills, ...skills],
      diagnostics: [...current.diagnostics, ...diagnostics],
    }),
  });
  await loader.reload();

  const probeTool = defineTool({
    name: 'sentiscope_probe',
    label: 'SentiScope 会话探针',
    description: '切片一会话探针工具：返回固定结果证明自定义工具注册可用，不访问任何外部系统。',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'sentiscope-probe-ok' }], details: undefined }),
  });

  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(),
    tools: ['read', 'grep', 'find', 'ls', 'sentiscope_probe'],
    customTools: [probeTool],
    resourceLoader: loader,
  });
  log.push('会话创建成功：inMemory 会话 + 只读工具集');

  let eventSubscription: ProbeResult['eventSubscription'] = 'failed';
  try {
    const unsubscribe = session.subscribe((event) => { log.push(`事件: ${event.type}`); });
    eventSubscription = 'installed';
    unsubscribe();
  } catch { /* 订阅失败即如实记录 */ }

  const activeTools = session.getActiveToolNames();
  const customToolActive = activeTools.includes('sentiscope_probe');
  log.push(`活动工具：${activeTools.join(', ')}`);

  session.dispose();
  log.push('会话已正常结束（dispose）');

  return {
    ok: true,
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
    skillDiagnostics: diagnostics as unknown as Array<Record<string, unknown>>,
    activeTools,
    customToolActive,
    eventSubscription,
    sessionDisposed: true,
    log,
  };
}
