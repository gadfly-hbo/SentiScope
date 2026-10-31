import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { parse } from 'node-html-parser';
import type { RawRow, SourceAsset } from '../core/mvp-types.ts';
import { storeRawBytes } from '../core/raw-evidence.ts';

export class WebError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'WebError';
    this.code = code;
  }
}

export type WebResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  remoteAddress: string;
};

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
type Transport = (url: URL, address: string, maxBytes: number, timeoutMs: number) => Promise<WebResponse>;

type WebOptions = {
  rootDir: string;
  url: string;
  allowedHosts: string[];
  termsConfirmed: boolean;
  now: string;
  maxBytes?: number;
  timeoutMs?: number;
  lookup?: Lookup;
  transport?: Transport;
};

export function validatePublicUrl(raw: string, allowedHosts: string[]): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new WebError('scheme_rejected');
  if (url.username || url.password) throw new WebError('credentials_rejected');
  if (url.port && !['80', '443'].includes(url.port)) throw new WebError('port_rejected');
  if (!allowedHosts.includes(url.hostname)) throw new WebError('host_rejected');
  if (url.search) throw new WebError('query_rejected');
  if (url.hash) throw new WebError('fragment_rejected');
  return url;
}

export function isPublicIp(address: string): boolean {
  if (isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 168].includes(b))
      || (a === 198 && [18, 19, 51].includes(b))
      || (a === 203 && b === 0));
  }
  if (isIP(address) !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.every(value => value === 0)) return false;
  if (bytes.slice(0, 15).every(value => value === 0) && bytes[15] === 1) return false;
  const mapped = bytes.slice(0, 10).every(value => value === 0) && bytes[10] === 255 && bytes[11] === 255;
  const compatible = bytes.slice(0, 12).every(value => value === 0);
  const nat64 = bytes[0] === 0 && bytes[1] === 100 && bytes[2] === 255 && bytes[3] === 155 && bytes.slice(4, 12).every(value => value === 0);
  if (mapped || compatible || nat64) return isPublicIp(bytes.slice(12).join('.'));
  const first = bytes[0]! * 256 + bytes[1]!, second = bytes[2]! * 256 + bytes[3]!;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  return true;
}

function ipv6Bytes(address: string): number[] | null {
  const normalized = address.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  const withoutDotted = dotted ? normalized.slice(0, -dotted.length - 1) : normalized;
  const [head = '', tail = ''] = withoutDotted.split('::');
  if (withoutDotted.split('::').length > 2) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length - (dotted ? 2 : 0))).fill('0'), ...right];
  if (dotted) groups.push('0', '0');
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = groups.flatMap(group => { const value = Number.parseInt(group, 16); return [value >> 8, value & 255]; });
  if (dotted) {
    const parts = dotted.split('.').map(Number);
    if (parts.some(part => part < 0 || part > 255)) return null;
    bytes.splice(12, 4, ...parts);
  }
  return bytes;
}

export async function fetchPublicSnapshot(options: WebOptions): Promise<{ asset: SourceAsset; tables: string[][][] }> {
  if (!options.termsConfirmed) throw new WebError('terms_required');
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 5000;
  const lookup = options.lookup ?? (async hostname => dnsLookup(hostname, { all: true, verbatim: true }));
  const transport = options.transport ?? defaultTransport;
  const pageUrl = validatePublicUrl(options.url, options.allowedHosts);
  const result = await secureGet(pageUrl, options.allowedHosts, lookup, transport, maxBytes, timeoutMs, true);
  if (result.response.status !== 200) throw new WebError('http_error');
  const contentType = result.response.headers['content-type'] ?? '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new WebError('content_type_rejected');
  const stored = storeRawBytes(options.rootDir, result.response.body, 'html');
  const html = result.response.body.toString('utf8');
  const document = parse(html);
  const publishedAt = document.querySelector('time')?.getAttribute('datetime') ?? null;
  const tables = document.querySelectorAll('table').map(table => table.querySelectorAll('tr').map(row => row.querySelectorAll('th,td').map(cell => cell.text.trim())));
  const asset: SourceAsset = {
    id: `asset-${stored.sha256.slice(0, 16)}`,
    kind: 'web',
    name: document.querySelector('title')?.text.trim() || result.url.hostname,
    sha256: stored.sha256,
    mediaType: 'text/html',
    bytes: result.response.body.length,
    importedAt: options.now,
    publishedAt,
    capturedAt: options.now,
    locator: result.url.toString(),
    path: stored.path,
    metadata: { finalUrl: result.url.toString(), allowedHost: result.url.hostname, termsConfirmed: true, parser: 'node-html-parser@v1' },
  };
  return { asset, tables };
}

export type PublicTableMapping = {
  metricId: string;
  entity: string;
  period: string;
  unit: string;
  valueHeader: string;
  periodClosed: boolean;
  scope: string;
  currency: string;
  region: string;
  sourceType: 'primary' | 'secondary';
};

export function publicTableToRawRows(tables: string[][][], asset: SourceAsset, mapping: PublicTableMapping): RawRow[] {
  const rows: RawRow[] = [];
  tables.forEach((table, tableIndex) => {
    const headers = table[0] ?? [];
    const valueColumn = headers.findIndex(header => header.trim() === mapping.valueHeader);
    if (valueColumn < 0) return;
    table.slice(1).forEach((cells, rowIndex) => {
      const rawValue = cells[valueColumn]?.replace(/[%\s,]/g, '') ?? '';
      if (!rawValue) return;
      rows.push({
        rowNumber: rows.length + 2,
        values: {
          metric: mapping.metricId, entity: cells[0]?.trim() || mapping.entity, period: mapping.period, value: rawValue, unit: mapping.unit,
          label: cells[0] ?? mapping.entity, closed: String(mapping.periodClosed), scope: mapping.scope, currency: mapping.currency, region: mapping.region, sourceType: mapping.sourceType, publishedAt: asset.publishedAt ?? '',
        },
        issues: mapping.sourceType === 'secondary' ? ['secondary_source'] : [],
        source: { assetSha256: asset.sha256, kind: 'web', locator: `table:${tableIndex + 1}:row:${rowIndex + 2}` },
      });
    });
  });
  return rows;
}

async function secureGet(initial: URL, allowedHosts: string[], lookup: Lookup, transport: Transport, maxBytes: number, timeoutMs: number, checkRobots = false): Promise<{ url: URL; response: WebResponse }> {
  let url = initial;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    url = validatePublicUrl(url.toString(), allowedHosts);
    if (checkRobots && url.pathname !== '/robots.txt') {
      const robots = await secureGet(new URL('/robots.txt', url.origin), allowedHosts, lookup, transport, maxBytes, timeoutMs);
      if (robots.response.status === 200 && !robotsAllowed(robots.response.body.toString('utf8'), url.pathname)) throw new WebError('robots_rejected');
      if (![200, 404, 410].includes(robots.response.status)) throw new WebError('robots_unavailable');
    }
    const addresses = await lookup(url.hostname);
    if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) throw new WebError('private_ip_rejected');
    const response = await transport(url, addresses[0]!.address, maxBytes, timeoutMs);
    if (!isPublicIp(response.remoteAddress)) throw new WebError('private_ip_rejected');
    if (response.body.length > maxBytes) throw new WebError('too_large');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || redirects === 3) throw new WebError('redirect_rejected');
      url = new URL(location, url);
      continue;
    }
    return { url, response };
  }
  throw new WebError('redirect_rejected');
}

function robotsAllowed(content: string, path: string): boolean {
  const groups = new Map<string, Array<{ allow: boolean; prefix: string }>>();
  let agents: string[] = [], sawRule = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (/^user-agent\s*:/i.test(line)) {
      const agent = line.slice(line.indexOf(':') + 1).trim().toLowerCase();
      if (sawRule) { agents = [agent]; sawRule = false; }
      else if (!agents.includes(agent)) agents.push(agent);
      groups.set(agent, groups.get(agent) ?? []);
      continue;
    }
    if (!/^(?:disallow|allow)\s*:/i.test(line)) continue;
    const prefix = line.slice(line.indexOf(':') + 1).trim();
    if (!prefix) continue;
    sawRule = true;
    for (const agent of agents) groups.get(agent)?.push({ allow: /^allow\s*:/i.test(line), prefix });
  }
  const specific = groups.get('sentiscope');
  const rules = specific ?? groups.get('*') ?? [];
  const matching = rules.filter(rule => robotsPathMatches(rule.prefix, path)).sort((a, b) => b.prefix.length - a.prefix.length || Number(a.allow) - Number(b.allow));
  return matching.length ? matching[0]!.allow : true;
}

function robotsPathMatches(prefix: string, path: string): boolean {
  const anchored = prefix.endsWith('$');
  const normalized = anchored ? prefix.slice(0, -1) : prefix;
  const pattern = normalized.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
}

function defaultTransport(url: URL, address: string, maxBytes: number, timeoutMs: number): Promise<WebResponse> {
  return new Promise((resolve, reject) => {
    const call = url.protocol === 'https:' ? httpsRequest : request;
    const req = call({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
      headers: { host: url.host, accept: 'text/html,text/plain', 'user-agent': 'SentiScope/0.2 (+local authorized analysis)' },
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new WebError('too_large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
        body: Buffer.concat(chunks),
        remoteAddress: response.socket.remoteAddress ?? '',
      }));
    });
    req.on('timeout', () => req.destroy(new WebError('timeout')));
    req.on('error', reject);
    req.end();
  });
}
