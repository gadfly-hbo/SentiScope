import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { importFile, ImportError } from '../src/core/import.ts';
import { makeDataDir } from './helpers.ts';

const NOW = '2026-10-03T01:42:00.000Z';
const CSV = '\uFEFFmetric,entity,period,value,unit,note\nrevenue,华东,2026-09,8800000,元,"=<b>text</b>"\nwait,华南,2026-09,46,秒,正常\n';

test('IMP-01：CSV 原始字节、解析、同内容幂等与文件名解耦', async () => {
  const root = makeDataDir();
  const first = await importFile({ rootDir: root, name: '经营.csv', bytes: Buffer.from(CSV), now: NOW });
  const second = await importFile({ rootDir: root, name: '改名.csv', bytes: Buffer.from(CSV), now: NOW });
  assert.equal(first.alreadyPresent, false);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(first.rawRows.length, 2);
  assert.equal(first.rawRows[0]!.values.note, '=<b>text</b>');
  assert.equal(first.rawRows[0]!.source.locator, 'row:2');
  assert.ok(readFileSync(first.asset.path).equals(Buffer.from(CSV)), '必须保留含 BOM 的原始字节');
});

test('IMP-02：空文件、重复表头、非法 UTF-8 与大小限制 fail-closed', async () => {
  const root = makeDataDir();
  await assert.rejects(importFile({ rootDir: root, name: '空.csv', bytes: Buffer.alloc(0), now: NOW }), ImportError);
  await assert.rejects(importFile({ rootDir: root, name: '重复.csv', bytes: Buffer.from('a,a\n1,2\n'), now: NOW }), /duplicate_header/);
  await assert.rejects(importFile({ rootDir: root, name: '坏编码.csv', bytes: Buffer.from([0xff, 0xfe, 0xfd]), now: NOW }), /invalid_utf8/);
  await assert.rejects(importFile({ rootDir: root, name: '大.csv', bytes: Buffer.from('a\n1\n'), now: NOW, maxBytes: 3 }), /too_large/);
});

test('IMP-03：XLSX 公式不执行，缓存值与公式来源同时保留', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('经营');
  sheet.addRow(['metric', 'entity', 'period', 'value', 'unit']);
  sheet.addRow(['revenue', '华东', '2026-09', 880, '万元']);
  sheet.getCell('D3').value = { formula: 'D2*2', result: 1760 } as ExcelJS.CellValue;
  sheet.getCell('E3').value = '万元';
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await importFile({ rootDir: makeDataDir(), name: '经营.xlsx', bytes, now: NOW });
  assert.equal(result.rawRows.length, 2);
  assert.equal(result.rawRows[1]!.values.value, 1760);
  assert.ok(result.rawRows[1]!.issues.includes('cached_formula'));
  assert.equal(result.rawRows[1]!.source.locator, '经营!3:3');
});

test('IMP-04：data descriptor 下的外部关系仍被拒绝，多 sheet 不静默截断', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="externalWorkbook" Target="https://example.com/private.xlsx" TargetMode="External"/></Relationships>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', streamFiles: true });
  await assert.rejects(importFile({ rootDir: makeDataDir(), name: 'external.xlsx', bytes, now: NOW }), /external_xml_content/);

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('one').addRow(['a']);
  workbook.addWorksheet('two').addRow(['b']);
  const multi = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(importFile({ rootDir: makeDataDir(), name: 'multi.xlsx', bytes: multi, now: NOW }), /multiple_sheets_unsupported/);
});
