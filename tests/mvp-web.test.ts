import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { defaultTransport, isPublicIp, secureGet, validatePublicUrl, WebError, type Lookup, type Transport, type WebResponse } from '../src/source/public-web.ts';

const PUBLIC_IP = '93.184.216.34';
const lookup: Lookup = async () => [{ address: PUBLIC_IP, family: 4 }];
const response = (body: string, overrides: Partial<WebResponse> = {}): WebResponse => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body), remoteAddress: PUBLIC_IP, ...overrides });
const get = (url: string, transport: Transport, allowedHosts: string[] = [], checkRobots = false) => secureGet(validatePublicUrl(url), allowedHosts, lookup, transport, 2 * 1024 * 1024, 5000, checkRobots);

test('WEB-04：协议、端口、凭据与私网地址 fail-closed，搜索查询串保留', () => {
  assert.throws(() => validatePublicUrl('file:///etc/passwd'), /scheme_rejected/);
  assert.throws(() => validatePublicUrl('https://user:pass@example.com/a'), /credentials_rejected/);
  assert.throws(() => validatePublicUrl('https://example.com:8443/a'), /port_rejected/);
  assert.throws(() => validatePublicUrl('https://example.com/a#frag'), /fragment_rejected/);
  assert.equal(validatePublicUrl('https://example.com/search?q=2026Q2+行业增速&num=10').search, '?q=2026Q2+%E8%A1%8C%E4%B8%9A%E5%A2%9E%E9%80%9F&num=10');
  assert.throws(() => validatePublicUrl('https://other.com/a', ['example.com']), /host_rejected/);
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:7f00:1', '0064:ff9b:0:0:0:0:7f00:1']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp(PUBLIC_IP), true);
});

test('WEB-04：DNS 与实际对端都必须是公网地址，重定向后重新解析', async () => {
  const privateLookup: Lookup = async hostname => hostname === 'cdn.example' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: PUBLIC_IP, family: 4 }];
  await assert.rejects(secureGet(new URL('https://cdn.example/report'), [], privateLookup, async () => response(''), 2 * 1024 * 1024, 5000), /private_ip_rejected/);
  const paths: string[] = [];
  await assert.rejects(secureGet(new URL('https://example.com/report'), [], privateLookup, async url => {
    paths.push(url.pathname);
    if (url.pathname === '/robots.txt') return response('');
    return response('', { status: 302, headers: { location: 'https://cdn.example/private' } });
  }, 2 * 1024 * 1024, 5000, true), /private_ip_rejected/);
  assert.deepEqual(paths, ['/robots.txt', '/report']);
  await assert.rejects(get('https://example.com/report', async () => response('', { remoteAddress: '10.0.0.1' })), /private_ip_rejected/);
});

test('WEB-02：robots 禁止时不读取目标页面，403 与重定向后的禁止路径同样 fail-closed', async () => {
  const paths: string[] = [];
  await assert.rejects(get('https://example.com/private/report', async url => {
    paths.push(url.pathname);
    return response('User-agent: *\nDisallow: /private');
  }, [], true), (error: unknown) => error instanceof WebError && error.code === 'robots_rejected');
  assert.deepEqual(paths, ['/robots.txt']);
  await assert.rejects(get('https://example.com/public', async () => response('', { status: 403 }), [], true), /robots_unavailable/);
  await assert.rejects(get('https://example.com/public', async url => url.pathname === '/robots.txt'
    ? response('User-agent: *\nDisallow: /private')
    : response('', { status: 302, headers: { location: '/private' } }), [], true), /robots_rejected/);
});

test('WEB-02：SentiScope 专属组优先于通配组，行内注释与通配 disallow 均生效', async () => {
  await assert.rejects(get('https://example.com/private/report', async url => url.pathname === '/robots.txt'
    ? response('User-agent: *\nAllow: /private\nUser-agent: SentiScope\nDisallow: /private\nUser-agent: Other\nAllow: /private/report')
    : response('<html></html>'), [], true), /robots_rejected/);
  for (const disallow of ['/private#comment', '/private/*']) {
    await assert.rejects(get('https://example.com/private/report', async url => url.pathname === '/robots.txt'
      ? response(`User-agent: *\nDisallow: ${disallow}`)
      : response('<html></html>'), [], true), /robots_rejected/);
  }
});

test('WEB-04：重定向超过 3 次或无 Location 时拒绝，robots.txt 自身不再递归检查', async () => {
  await assert.rejects(get('https://example.com/report', async () => response('', { status: 302, headers: { location: '/next' } }), [], true), /redirect_rejected/);
  await assert.rejects(get('https://example.com/report', async () => response('', { status: 301 }), [], true), /redirect_rejected/);
  const paths: string[] = [];
  const result = await get('https://example.com/robots.txt', async url => { paths.push(url.pathname); return response('User-agent: *\nDisallow: /'); }, [], true);
  assert.deepEqual(paths, ['/robots.txt']);
  assert.equal(result.response.status, 200);
});

test('WEB-04：defaultTransport 在 Node all:true lookup 下仍按固定 IP 建立连接', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await defaultTransport(new URL(`http://127.0.0.1:${port}/`), '127.0.0.1', 1024, 2000);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString('utf8'), 'ok');
  } finally {
    server.close();
  }
});

test('WEB-04：首个地址连接失败回退后续公网地址，策略错误不重试', async () => {
  const attempts: string[] = [];
  const multiLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }];
  const result = await secureGet(new URL('https://example.com/'), [], multiLookup, async (_url, address) => {
    attempts.push(address);
    if (address.endsWith('.34')) throw new Error('socket disconnected');
    return response('ok');
  }, 1024, 1000);
  assert.equal(result.response.status, 200);
  assert.deepEqual(attempts, ['93.184.216.34', '93.184.216.35']);
  await assert.rejects(secureGet(new URL('https://example.com/'), [], multiLookup, async () => { throw new WebError('too_large'); }, 1024, 1000), /too_large/);
});
