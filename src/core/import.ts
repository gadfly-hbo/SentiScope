import ExcelJS from 'exceljs';
import { basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { ImportResult, RawRow, SourceAsset } from './mvp-types.ts';
import { storeRawBytes } from './raw-evidence.ts';

export class ImportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ImportError';
    this.code = code;
  }
}

type ImportOptions = {
  rootDir: string;
  name: string;
  bytes: Buffer;
  now: string;
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
};

export async function importFile(options: ImportOptions): Promise<ImportResult> {
  const { rootDir, name, bytes, now } = options;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  if (!bytes.length) throw new ImportError('empty_file');
  if (bytes.length > maxBytes) throw new ImportError('too_large');
  const extension = name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : name.toLowerCase().endsWith('.csv') ? 'csv' : null;
  if (!extension) throw new ImportError('unsupported_format');
  const stored = storeRawBytes(rootDir, bytes, extension);
  const asset: SourceAsset = {
    id: `asset-${stored.sha256.slice(0, 16)}`,
    kind: 'file',
    name: basename(name),
    sha256: stored.sha256,
    mediaType: extension === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: bytes.length,
    importedAt: now,
    publishedAt: null,
    capturedAt: null,
    locator: `file://${basename(name)}`,
    path: stored.path,
    metadata: { parser: extension === 'csv' ? 'sentiscope-csv@v1' : 'exceljs@v1', formulasExecuted: false },
  };
  const rawRows = extension === 'csv'
    ? parseCsv(bytes, stored.sha256, options.maxRows ?? 50_000)
    : await parseXlsx(bytes, stored.sha256, options.maxRows ?? 50_000, options.maxColumns ?? 256);
  return { asset, rawRows, alreadyPresent: stored.alreadyPresent };
}

function parseCsv(bytes: Buffer, hash: string, maxRows: number): RawRow[] {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ImportError('invalid_utf8'); }
  const records = csvRecords(text);
  if (!records.length || records.every(row => row.every(cell => !cell.trim()))) throw new ImportError('empty_file');
  const headers = records[0]!.map((cell, index) => index === 0 ? cell.replace(/^\uFEFF/, '').trim() : cell.trim());
  validateHeaders(headers);
  const rows = records.slice(1).filter(row => row.some(cell => cell.trim() !== ''));
  if (rows.length > maxRows) throw new ImportError('too_many_rows');
  return rows.map((values, index) => {
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']));
    const issues = Object.values(record).some(value => /^[=+@]/.test(value)) ? ['formula_like_text'] : [];
    return { rowNumber: index + 2, values: record, issues, source: { assetSha256: hash, kind: 'raw', locator: `row:${index + 2}` } };
  });
}

function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (quoted) throw new ImportError('unclosed_quote');
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  const width = records[0]?.length ?? 0;
  if (records.some(record => record.length !== width)) throw new ImportError('inconsistent_columns');
  return records;
}

async function parseXlsx(bytes: Buffer, hash: string, maxRows: number, maxColumns: number): Promise<RawRow[]> {
  inspectXlsxArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ArrayBuffer); }
  catch { throw new ImportError('invalid_xlsx'); }
  if (workbook.worksheets.length > 1) throw new ImportError('multiple_sheets_unsupported');
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ImportError('empty_file');
  if (sheet.actualRowCount > maxRows + 1) throw new ImportError('too_many_rows');
  const headerRow = sheet.getRow(1);
  if (headerRow.cellCount > maxColumns) throw new ImportError('too_many_columns');
  const headers = Array.from({ length: headerRow.cellCount }, (_, index) => String(headerRow.getCell(index + 1).value ?? '').trim());
  validateHeaders(headers);
  const rows: RawRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, unknown> = {};
    const issues: string[] = [];
    headers.forEach((header, column) => {
      const cell = row.getCell(column + 1);
      const formula = cell.formula;
      values[header] = cellValue(cell.value);
      if (formula) issues.push(cell.result === undefined ? 'cached_formula_missing' : 'cached_formula');
      if (cell.value && typeof cell.value === 'object' && 'error' in cell.value) issues.push('cell_error');
    });
    if (Object.values(values).every(value => value === '' || value == null)) return;
    rows.push({ rowNumber, values, issues, source: { assetSha256: hash, kind: 'raw', locator: `${sheet.name}!${rowNumber}:${rowNumber}` } });
  });
  if (!rows.length) throw new ImportError('empty_file');
  return rows;
}

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
  if ('error' in value) return `#${value.error}`;
  return String(value);
}

function validateHeaders(headers: string[]): void {
  if (headers.length > 256) throw new ImportError('too_many_columns');
  if (!headers.length || headers.some(header => !header)) throw new ImportError('missing_header');
  if (new Set(headers).size !== headers.length) throw new ImportError('duplicate_header');
}

type ZipEntry = { name: string; method: number; compressed: number; uncompressed: number; localOffset: number };

function inspectXlsxArchive(bytes: Buffer): void {
  const entries = centralEntries(bytes);
  let totalBytes = 0, totalCompressed = 0;
  for (const entry of entries.values()) {
    totalBytes += entry.uncompressed; totalCompressed += entry.compressed;
    if (totalBytes > 100 * 1024 * 1024 || (entry.uncompressed > 1024 * 1024 && entry.uncompressed / Math.max(1, entry.compressed) > 200)) throw new ImportError('archive_expansion_limit');
    if (/vbaProject|externalLink/i.test(entry.name)) throw new ImportError('external_or_macro_content');
  }
  if (totalBytes > 100 * 1024 * 1024 || (totalBytes > 1024 * 1024 && totalBytes / Math.max(1, totalCompressed) > 200)) throw new ImportError('archive_expansion_limit');
  for (const entry of entries.values()) {
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue;
    const content = readArchiveText(bytes, entry);
    if (/<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(content)) throw new ImportError('external_xml_content');
  }
}

function centralEntries(bytes: Buffer): Map<string, ZipEntry> {
  if (bytes.length < 22) throw new ImportError('invalid_xlsx');
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new ImportError('invalid_xlsx');
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  let offset = bytes.readUInt32LE(eocd + 16);
  if (count > 2048 || centralSize > 4 * 1024 * 1024 || offset >= bytes.length) throw new ImportError('archive_limit');
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new ImportError('invalid_xlsx');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if ([compressed, uncompressed, localOffset].includes(0xffffffff) || (flags & 1)) throw new ImportError('unsupported_archive');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, { name, method, compressed, uncompressed, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readArchiveText(bytes: Buffer, entry: ZipEntry): string {
  const offset = entry.localOffset;
  if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new ImportError('invalid_xlsx');
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const payload = bytes.subarray(start, start + entry.compressed);
  try {
    if (entry.method === 0) return payload.toString('utf8');
    if (entry.method === 8) return inflateRawSync(payload, { maxOutputLength: 100 * 1024 * 1024 }).toString('utf8');
    throw new ImportError('unsupported_archive');
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('invalid_xlsx');
  }
}
