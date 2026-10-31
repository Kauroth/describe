// 本地自测：node test_worker.mjs
// 不依赖 Cloudflare 运行时，用假的 fetch 打桩。
// _worker.js 不在 package.json 的 module 范围里，直接 import 会被当 CJS，
// 所以用 data: URL 当 ESM 加载，仓库里不用多塞一个 package.json。
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./_worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
const worker = mod.default;

const ADDR = [
  '移动优选|https://pool.test/nope-404.txt,https://pool.test/cmcc.txt',
  '电信优选|https://pool.test/ctcc.txt',
  '死链测试|https://pool.test/dead.txt'
].join('\n');

const POOLS = {
  'https://pool.test/cmcc.txt': '104.18.11.217#移动\n104.18.12.5#移动2\n172.64.1.1:8443#带端口',
  'https://pool.test/ctcc.txt': '104.19.1.1#电信',
  'https://pool.test/dead.txt': '' // 404
};

const VLESS_TPL = 'vless://ca7428e0-8e96-4a55-b1fe-118773809060@104.17.151.9:8443?encryption=none&security=tls&sni=1panel.kauroth.top&type=xhttp&host=1panel.kauroth.top&path=%2Fde-xhttp#DE';

const VMESS_TPL = 'vmess://' + Buffer.from(JSON.stringify({
  v: '2', ps: 'VM', add: '104.17.151.9', port: 443, id: 'ca7428e0-8e96-4a55-b1fe-118773809060',
  aid: 0, scy: 'auto', net: 'ws', type: 'none', host: 'vm.example.com', path: '/ws', tls: 'tls', sni: 'vm.example.com'
}), 'utf8').toString('base64');

const SS_TPL = 'ss://' + Buffer.from('aes-256-gcm:pass123', 'utf8').toString('base64url') + '@104.17.151.9:8388#SS';

const TROJAN_TPL = 'trojan://pw123@104.17.151.9:443?security=tls&sni=t.example.com&type=ws&host=t.example.com&path=%2Ft#TJ';

const HY2_TPL = 'hysteria2://auth123@104.17.151.9:443/?sni=h.example.com&obfs=salamander&obfs-password=xyz&alpn=h3#HY2';

const env = { ADDR };
const base = 'https://describe.example.workers.dev/';

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' → ' + extra : ''}`); }
}
function line(t) { console.log('\n' + t + '\n' + '-'.repeat(72)); }

// ---- 假 fetch ----
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u in POOLS) {
    const body = POOLS[u];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

async function call(u) {
  const res = await worker.fetch(new Request(u), env);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// ============ 1. 页面 ============
line('1) 页面渲染 + 内联脚本语法');
let r = await call(base);
ok('200', r.status === 200, String(r.status));
ok('含编辑器标题', r.text.includes('节点编辑器'));
ok('含协议下拉 5 项', ['vless', 'vmess', 'trojan', 'ss', 'hysteria2'].every(p => r.text.includes(`value="${p}"`)));
ok('含分享按钮', r.text.includes('生成分享链接'));
const script = (r.text.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
ok('内联脚本非空', script.length > 1000, String(script.length));
try {
  new Function(script);
  ok('内联脚本语法合法', true);
} catch (e) {
  ok('内联脚本语法合法', false, e.message);
}

// ============ 2. ADDR 解析 ============
line('2) ?sources=1');
r = await call(base + '?sources=1');
const srcJson = JSON.parse(r.text);
ok('3 个源', srcJson.count === 3, String(srcJson.count));
ok('候选地址 2 条', srcJson.sources[0].urls.length === 2);

line('2b) ADDR 为空时页面仍可打开');
r = await worker.fetch(new Request(base), {}).then(x => x.text());
ok('无 ADDR 也出页面', r.includes('节点编辑器'));
ok('无 ADDR 有提示', r.includes('ADDR 为空'));
const r2 = await worker.fetch(new Request(base + '?sources=1'), {});
ok('无 ADDR 时 ?sources=1 报 500', r2.status === 500, String(r2.status));

// ============ 3. probe ============
line('3) ?probe=1 候选回退');
r = await call(base + '?probe=1');
const probe = JSON.parse(r.text);
const first = probe.results[0];
ok('第一源首个候选 404', first.attempts[0].status === 404);
ok('第一源回退到第二个候选', first.attempts.length === 2 && first.attempts[1].ok === true);

// ============ 4. vless 订阅 ============
line('4) vless 单源 base64');
r = await call(base + '?source=0&format=base64&template=' + encodeURIComponent(VLESS_TPL));
ok('200', r.status === 200);
ok('CORS', r.headers.get('Access-Control-Allow-Origin') === '*');
const nodes = Buffer.from(r.text, 'base64').toString('utf8').split('\n').filter(Boolean);
ok('3 个节点', nodes.length === 3, String(nodes.length));
ok('IP 已换', nodes[0].includes('@104.18.11.217:'), nodes[0].slice(0, 80));
ok('池子端口优先', nodes[2].includes(':8443?'), nodes[2]);
ok('host/sni/path 保留', nodes[0].includes('sni=1panel.kauroth.top') && nodes[0].includes('path=%2Fde-xhttp'));
ok('备注被池子覆盖', nodes[0].endsWith('#移动'), nodes[0].slice(-20));

line('4b) 端口为 443 时按地址哈希，稳定');
const vless443 = VLESS_TPL.replace(':8443', ':443');
const a1 = await call(base + '?source=0&format=base64&template=' + encodeURIComponent(vless443));
const a2 = await call(base + '?source=0&format=base64&template=' + encodeURIComponent(vless443));
ok('两次结果完全一致', a1.text === a2.text);
const p1 = Buffer.from(a1.text, 'base64').toString('utf8').split('\n')[0].match(/@104\.18\.11\.217:(\d+)\?/)[1];
ok('端口落在 CF 端口表内', ['443', '2053', '2083', '2087', '2096', '8443'].includes(p1), p1);

// ============ 5. 越界 / 死链 ============
line('5) 越界与死链');
r = await call(base + '?source=7&template=' + encodeURIComponent(VLESS_TPL));
ok('越界 400', r.status === 400, String(r.status));
ok('越界列出真实源名', r.text.includes('0=移动优选'), r.text);
r = await call(base + '?source=2&template=' + encodeURIComponent(VLESS_TPL));
ok('死链 400', r.status === 400);
ok('错误里带具体 URL', r.text.includes('https://pool.test/dead.txt'), r.text.slice(0, 120));

// ============ 6. 多协议换址 ============
line('6) 多协议换址');
for (const [name, tpl, check] of [
  ['vmess', VMESS_TPL, (n) => {
    const o = JSON.parse(Buffer.from(n.slice(8), 'base64').toString('utf8'));
    return o.add === '104.18.11.217' && o.ps === '移动' && o.net === 'ws' && o.host === 'vm.example.com' && o.tls === 'tls';
  }],
  ['ss', SS_TPL, (n) => n.startsWith('ss://') && n.includes('@104.18.11.217:8388') && Buffer.from(n.slice(5).split('@')[0], 'base64url').toString('utf8') === 'aes-256-gcm:pass123'],
  ['trojan', TROJAN_TPL, (n) => n.startsWith('trojan://pw123@104.18.11.217:') && n.includes('sni=t.example.com') && n.includes('path=%2Ft')],
  ['hysteria2', HY2_TPL, (n) => n.startsWith('hysteria2://auth123@104.18.11.217:') && n.includes('obfs=salamander') && n.includes('alpn=h3')]
]) {
  const rr = await call(base + '?source=0&format=plain&template=' + encodeURIComponent(tpl));
  const firstNode = rr.text.split('\n')[0];
  ok(`${name} 换址正确`, rr.status === 200 && check(firstNode), firstNode.slice(0, 110));
}

// ============ 7. all=true ============
line('7) ?all=true');
r = await call(base + '?all=true&template=' + encodeURIComponent(VLESS_TPL));
const all = JSON.parse(r.text);
ok('protocol 字段', all.protocol === 'vless');
ok('3 个结果', all.results.length === 3);
ok('死链源带错误', all.results[2].error && all.results[2].error.includes('dead.txt'));
ok('预览上限 50', all.results[0].preview.length <= 50);
ok('订阅链接带 format=base64', all.results[0].subscribeLink.includes('format=base64'));

// ============ 8. 分享链接 ============
line('8) ?share= 分享链接往返');
for (const [name, node] of [['vless', nodes[0]], ['vmess', (await call(base + '?source=0&format=plain&template=' + encodeURIComponent(VMESS_TPL))).text.split('\n')[0]],
  ['ss', 'ss://' + Buffer.from('aes-256-gcm:pass123', 'utf8').toString('base64url') + '@1.2.3.4:8388#节点A'],
  ['trojan', 'trojan://pw@1.2.3.4:443?security=tls#TJ'],
  ['hysteria2', 'hysteria2://auth@1.2.3.4:443/?sni=a.com#HY']]) {
  const payload = Buffer.from(node, 'utf8').toString('base64url');
  const rr = await call(base + '?share=' + payload);
  const back = Buffer.from(rr.text, 'base64').toString('utf8');
  ok(`${name} 往返一致`, back === node, back.slice(0, 80));
}
const multi = 'vless://a@1.1.1.1:443#A\nvmess://xx\nss://yy@2.2.2.2:8388#B';
const mp = Buffer.from(multi, 'utf8').toString('base64url');
const mr = await call(base + '?share=' + mp);
ok('多节点保留换行', Buffer.from(mr.text, 'base64').toString('utf8').split('\n').length === 3);
ok('坏 share 参数 400', (await call(base + '?share=%%%')).status === 400);
ok('空 share 参数 400', (await call(base + '?share=')).status === 400);

// ============ 9. 不支持的模板 ============
line('9) 非法模板');
r = await call(base + '?template=' + encodeURIComponent('http://example.com'));
ok('非节点模板 400', r.status === 400, String(r.status));

globalThis.fetch = realFetch;
console.log('\n' + '='.repeat(72));
console.log(`通过 ${pass}　失败 ${fail}`);
process.exit(fail ? 1 : 0);
