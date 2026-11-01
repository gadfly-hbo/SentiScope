import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { WorkspaceStore } from '../src/core/workspace-store.ts';
import { WebResearchService } from '../src/source/web-research.ts';

const PUBLIC_IP = '93.184.216.34';
const lookup = async () => [{ address: PUBLIC_IP, family: 4 }];

async function pdfBytes(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = doc.addPage([420, 300]);
    if (line) page.drawText(line, { x: 30, y: 240, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

function service(store: WorkspaceStore, body: () => Buffer, contentType = 'application/pdf') {
  return new WebResearchService({
    store, rootDir: store.rootDir, providers: [], lookup,
    transport: async (url: URL) => url.pathname === '/robots.txt'
      ? { status: 200, headers: {}, body: Buffer.from('User-agent: *\nAllow: /'), remoteAddress: PUBLIC_IP }
      : { status: 200, headers: { 'content-type': contentType }, body: body(), remoteAddress: PUBLIC_IP },
  });
}

test('SRC-01/02：PDF 文本层入快照，逐字引用与页码偏移可用', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'pdf-src-')));
  const body = await pdfBytes(['Quarterly synthetic statistics', 'Growth was 3.2 percent in 2026Q3.', 'Base period 2025Q3 value 100.']);
  const research = service(store, () => body);
  const fetched = await research.fetchPage('run-pdf', 'https://stats.synthetic.example/report.pdf', 'call-1');
  if (!fetched.ok) throw new Error('fetch failed');
  assert.equal(fetched.contentType, 'application/pdf');
  const snapshot = store.getSnapshot(fetched.snapshotId)!;
  assert.equal(snapshot.pdfPages?.count, 3);
  assert.equal(snapshot.pdfPages?.offsets.length, 3);
  assert.equal(snapshot.parseStatus, 'parsed');
  assert.match(snapshot.text, /Growth was 3\.2 percent in 2026Q3\./);
  const read = await research.readSnapshot('run-pdf', fetched.snapshotId, 0, 4000);
  if (!read.ok) throw new Error('read failed');
  const fact = await research.recordWebFact('run-pdf', {
    snapshotId: fetched.snapshotId, quote: 'Growth was 3.2 percent in 2026Q3.', valueText: '3.2', metricId: 'revenue', entity: '行业', period: '2026Q3', unit: '%',
    dimensions: { scope: '同一细分市场', currency: 'CNY', region: '同一地域', sourceType: 'primary', publishedAt: '2026-10-18', closed: 'true', comparable: 'true' },
  });
  if (!fact.ok) throw new Error('fact failed');
  assert.equal(fact.rawRow.values.value, '3.2');
  assert.match(fact.rawRow.source.locator, /^snapshot:/);
  store.close();
});

test('SRC-04：损坏／无文本层／超页数 PDF 一律 fail-closed', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'pdf-fail-')));
  const junk = service(store, () => Buffer.from('%PDF-1.7 not really a pdf'));
  await assert.rejects(junk.fetchPage('run-fail', 'https://example.com/a.pdf', 'c1'), /pdf_parse_failed/);
  const scannedBody = await pdfBytes(['', '', '']);
  const scanned = service(store, () => scannedBody);
  await assert.rejects(scanned.fetchPage('run-fail', 'https://example.com/b.pdf', 'c2'), /pdf_no_text_layer/);
  const pages: string[] = Array.from({ length: 61 }, (_, index) => `page ${index + 1} with text`);
  const hugeBody = await pdfBytes(pages);
  const huge = service(store, () => hugeBody);
  await assert.rejects(huge.fetchPage('run-fail', 'https://example.com/c.pdf', 'c3'), /pdf_too_large/);
  assert.equal(store.listSnapshots('run-fail').length, 0, '被拒 PDF 不留快照');
  store.close();
});

test('SRC-04：含 /OpenAction JavaScript 的 PDF 仍只做文本提取，不执行不报错', async () => {
  const store = new WorkspaceStore(mkdtempSync(join(tmpdir(), 'pdf-js-')));
  const { PDFDocument: Doc, StandardFonts: Fonts, PDFName } = await import('pdf-lib');
  const doc = await Doc.create();
  const font = await doc.embedFont(Fonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText('JavaScript marker page text.', { x: 30, y: 240, size: 10, font });
  const action = doc.context.obj({ Type: 'Action', S: 'JavaScript', JS: 'app.alert(1)' });
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(action));
  const patched = Buffer.from(await doc.save());
  const research = service(store, () => patched);
  const fetched = await research.fetchPage('run-js', 'https://example.com/with-js.pdf', 'call-1');
  if (!fetched.ok) throw new Error('fetch failed');
  const snapshot = store.getSnapshot(fetched.snapshotId)!;
  assert.match(snapshot.text, /JavaScript marker page text\./);
  store.close();
});
