import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'sentiscope-test-'));
}
