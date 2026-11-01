import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunUsage } from '../core/mvp-types.ts';

export function readSessionUsage(sessionsDir: string, sessionId: string | undefined): RunUsage | null {
  if (!sessionId || !existsSync(sessionsDir)) return null;
  const file = readdirSync(sessionsDir).find(name => name.endsWith(`_${sessionId}.jsonl`));
  if (!file) return null;
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costTotal: 0 };
  let sawUsage = false, costTotal = 0, sawCost = false;
  for (const line of readFileSync(join(sessionsDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: Record<string, unknown> } };
      const message = entry.message;
      if (entry.type !== 'message' || message?.role !== 'assistant' || !message.usage) continue;
      const block = message.usage;
      sawUsage = true;
      usage.modelCalls += 1;
      usage.inputTokens += Number(block.input ?? 0) || 0;
      usage.outputTokens += Number(block.output ?? 0) || 0;
      usage.cacheReadTokens += Number(block.cacheRead ?? 0) || 0;
      usage.totalTokens += Number(block.totalTokens ?? 0) || 0;
      const cost = Number((block.cost as Record<string, unknown> | undefined)?.total);
      if (Number.isFinite(cost)) { sawCost = true; costTotal += cost; }
    } catch {
      // 会话文件中的坏行跳过；读取失败按"不可得"处理，不阻塞运行结果
    }
  }
  if (!sawUsage) return null;
  return { ...usage, costTotal: sawCost ? costTotal : null };
}
