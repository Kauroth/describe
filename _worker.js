// _worker.js
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/resolve' && request.method === 'POST') {
      return handleResolve(request);
    }
    if (url.pathname === '/api/convert' && request.method === 'POST') {
      return handleConvert(request);
    }
    // 订阅链接
    if (url.pathname.startsWith('/_sub/')) {
      return handleSub(url);
    }

    return new Response(renderHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// ============ 内存订阅存储（带自动过期） ============
const subStore = new Map();
const SUB_TTL = 24 * 60 * 60 * 1000; // 24小时

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of subStore) {
    if (now - v.ts > SUB_TTL) subStore.delete(k);
  }
}, 60000);

function saveSub(base64) {
  const token = crypto.randomUUID().replace(/-/g, '');
  subStore.set(token, { data: base64, ts: Date.now() });
  return token;
}

async function handleSub(url) {
  const token = url.pathname.slice(6); // 去掉 '/_sub/'
  const entry = subStore.get(token);
  if (!entry) {
    return new Response('Subscription not found or expired', { status: 410 });
  }
  // 返回标准订阅格式
  return new Response(entry.data, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sub"',
      'Profile-Web-Page-Url': 'https://github.com',
      'Support-URL': 'https://github.com',
      'Cache-Control': 'no-cache',
    }
  });
}

// ============ 解析链接提取地址 ============
async function handleResolve(request) {
  try {
    const { link } = await request.json();
    if (!link) return json({ error: '请提供链接' }, 400);

    const resp = await fetch(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await resp.text();
    const allAddrs = [];

    // IPv4（排除内网/特殊）
    const ipv4Re = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
    for (const m of text.matchAll(ipv4Re)) {
      const p = m[1].split('.').map(Number);
      if (p.every(v => v >= 0 && v <= 255) && p[0] !== 0 && p[0] !== 127 &&
        !(p[0] === 10) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
        !(p[0] === 192 && p[1] === 168)) {
        allAddrs.push({ addr: m[1], type: 'IPv4' });
      }
    }

    // IPv6
    const ipv6Re = /\b([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7})\b/g;
    for (const m of text.matchAll(ipv6Re)) {
      allAddrs.push({ addr: m[1], type: 'IPv6' });
    }

    // 域名
    const skip = ['google.com', 'cloudflare.com', 'mozilla.org', 'github.com', 'w3.org',
      'jquery.com', 'example.com', 'apache.org', 'nginx.org', 'schema.org', 'json.org',
      'python.org', 'microsoft.com', 'apple.com', 'amazon.com', 'facebook.com', 'twitter.com',
      'youtube.com', 'googleapis.com', 'gstatic.com', 'google-analytics.com', 'doubleclick.net',
      'cloudflareinsights.com', 'cdnjs.cloudflare.com', 'jsdelivr.net', 'unpkg.com'];
    const domRe = /\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.([a-zA-Z]{2,}))\b/g;
    for (const m of text.matchAll(domRe)) {
      const d = m[1].toLowerCase();
      if (!skip.some(s => d === s || d.endsWith('.' + s))) {
        allAddrs.push({ addr: d, type: '域名' });
      }
    }

    // 去重，保留顺序
    const seen = new Set();
    const unique = [];
    for (const item of allAddrs) {
      if (!seen.has(item.addr)) {
        seen.add(item.addr);
        unique.push(item);
      }
    }

    if (unique.length === 0) {
      return json({ error: '未能提取到有效地址', preview: text.slice(0, 500) }, 400);
    }

    return json({ addresses: unique, count: unique.length });
  } catch (err) {
    return json({ error: '请求失败: ' + err.message }, 500);
  }
}

// ============ 批量转换（每个地址 × 每个节点） ============
async function handleConvert(request) {
  try {
    const { input, addresses, host } = await request.json();
    if (!input || !addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return json({ error: '缺少参数' }, 400);
    }

    // 解析输入节点
    let lines;
    try { lines = atob(input.trim()).split(/[\n\r]+/); }
    catch { lines = input.split(/[\n\r]+/); }

    const vlessList = lines.map(l => l.trim()).filter(l => l.startsWith('vless://'));
    if (vlessList.length === 0) {
      return json({ error: '未找到有效 VLESS 节点' }, 400);
    }

    const converted = [];
    const failed = [];

    vlessList.forEach((raw, idx) => {
      addresses.forEach(targetAddr => {
        try {
          const result = replaceAddr(raw, targetAddr);
          if (result) {
            converted.push(result);
          } else {
            failed.push({ line: idx + 1, addr: targetAddr, reason: '格式无效' });
          }
        } catch (e) {
          failed.push({ line: idx + 1, addr: targetAddr, reason: e.message });
        }
      });
    });

    const base64 = btoa(converted.join('\n'));

    // 生成订阅链接
    let subUrl = '';
    if (host) {
      const token = saveSub(base64);
      subUrl = (host.replace(/\/$/, '') + '/_sub/' + token);
    }

    return json({
      nodesIn: vlessList.length,
      addrsOut: addresses.length,
      totalOut: converted.length,
      failed: failed.length,
      failedDetails: failed,
      vless: converted.join('\n'),
      base64: base64,
      subUrl: subUrl
    });
  } catch (err) {
    return json({ error: '转换失败: ' + err.message }, 500);
  }
}

function replaceAddr(link, newAddr) {
  const u = new URL(link);
  if (u.protocol !== 'vless:') return null;
  if (!u.username || !u.hostname || !u.port) return null;
  let a = newAddr;
  if (newAddr.includes(':') && !newAddr.startsWith('[')) a = '[' + newAddr + ']';
  let r = 'vless://' + u.username + '@' + a + ':' + u.port + u.search;
  if (u.hash) r += u.hash;
  return r;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

// ============ 前端页面 ============
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VLESS 批量转换 & 订阅生成</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@300;400;600;800&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
:root{
  --bg:#080c14;--bg2:#0d1320;--card:#121a2a;--card2:#172034;
  --border:#1c2b44;--fg:#e2e8f4;--muted:#586d8e;
  --accent:#00e68a;--accent2:#00c4ff;
  --adim:rgba(0,230,138,.08);--aglow:rgba(0,230,138,.22);
  --red:#ff4d5e;--rdim:rgba(255,77,94,.08);
  --amber:#ffbe40;--adim2:rgba(255,190,64,.08);
  --cyan:#00c4ff;--cdim:rgba(0,196,255,.08);
  --r:12px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans SC',sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;overflow-x:hidden}

.bg-glow{position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(700px 500px at 10% 5%,rgba(0,230,138,.045),transparent),
    radial-gradient(600px 600px at 90% 90%,rgba(0,196,255,.035),transparent)}
.bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:radial-gradient(rgba(0,230,138,.06) 1px,transparent 1px);
  background-size:28px 28px}
.scan{position:fixed;left:0;right:0;height:1px;z-index:0;pointer-events:none;
  background:linear-gradient(90deg,transparent 5%,var(--aglow) 50%,transparent 95%);
  animation:scanY 7s linear infinite;opacity:.35}
@keyframes scanY{0%{top:-1px}100%{top:100vh}}

.wrap{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:32px 18px 60px}

header{text-align:center;margin-bottom:40px}
.logo{display:inline-flex;align-items:center;justify-content:center;
  width:56px;height:56px;border-radius:15px;
  background:linear-gradient(135deg,var(--adim),var(--cdim));
  border:1px solid var(--border);margin-bottom:16px;
  font-size:22px;color:var(--accent);animation:pulse 3s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 var(--aglow)}50%{box-shadow:0 0 26px 4px var(--aglow)}}
header h1{font-size:28px;font-weight:800;letter-spacing:-.4px;
  background:linear-gradient(135deg,var(--fg) 30%,var(--accent));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
header p{color:var(--muted);font-size:13px;font-weight:300;margin-top:5px}
header p b{color:var(--accent);font-weight:600}

.tip{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;
  background:var(--cdim);border:1px solid rgba(0,196,255,.12);border-radius:var(--r);
  margin-bottom:20px;font-size:12.5px;color:var(--muted);line-height:1.7}
.tip i{color:var(--cyan);font-size:15px;margin-top:2px;flex-shrink:0}
.tip b{color:var(--fg);font-weight:600}

.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);
  padding:24px;margin-bottom:16px;transition:border-color .3s,box-shadow .3s}
.card:hover{border-color:rgba(0,230,138,.12);box-shadow:0 4px 28px rgba(0,0,0,.3)}
.hd{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.hd .ic{color:var(--accent);font-size:15px;width:28px;height:28px;
  display:flex;align-items:center;justify-content:center;
  background:var(--adim);border-radius:7px;flex-shrink:0}
.hd .ic.cyan{color:var(--cyan);background:var(--cdim)}
.hd .ic.amber{color:var(--amber);background:var(--adim2)}
.hd span{font-size:14px;font-weight:600}
.bdg{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;
  min-width:22px;height:22px;padding:0 7px;border-radius:6px;
  font-size:11px;font-weight:800;font-family:'JetBrains Mono',monospace}
.bdg-step{background:var(--accent);color:var(--bg)}
.bdg-n{background:var(--adim);color:var(--accent);border:1px solid rgba(0,230,138,.15)}
.bdg-addr{background:var(--cdim);color:var(--cyan);border:1px solid rgba(0,196,255,.15)}

textarea,input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--border);
  border-radius:10px;color:var(--fg);font-family:'JetBrains Mono',monospace;
  font-size:12.5px;padding:12px 14px;resize:vertical;outline:none;
  transition:border-color .25s,box-shadow .25s}
textarea:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--adim)}
textarea::placeholder,input::placeholder{color:var(--muted);opacity:.45}
textarea{min-height:110px;line-height:1.7}
input[type=text]{height:44px}

.btn{display:inline-flex;align-items:center;gap:7px;padding:10px 20px;border-radius:10px;
  font-family:'Noto Sans SC',sans-serif;font-size:13px;font-weight:600;
  border:none;cursor:pointer;transition:all .2s;outline:none;white-space:nowrap}
.btn:active{transform:scale(.97)}
.btn-p{background:var(--accent);color:var(--bg);box-shadow:0 2px 14px var(--aglow)}
.btn-p:hover{box-shadow:0 4px 22px var(--aglow);filter:brightness(1.08)}
.btn-p:disabled{opacity:.3;cursor:not-allowed;filter:none;box-shadow:none}
.btn-s{background:var(--bg2);color:var(--fg);border:1px solid var(--border)}
.btn-s:hover{border-color:var(--accent);background:var(--card2)}
.btn-c{background:rgba(0,196,255,.1);color:var(--cyan);border:1px solid rgba(0,196,255,.2)}
.btn-c:hover{background:rgba(0,196,255,.18);border-color:var(--cyan)}
.btn-row{display:flex;gap:9px;margin-top:13px;flex-wrap:wrap}

/* 地址列表 */
.addr-list{margin-top:14px;max-height:220px;overflow-y:auto;
  display:flex;flex-direction:column;gap:5px}
.addr-row{display:flex;align-items:center;gap:10px;padding:9px 14px;
  background:var(--bg2);border:1px solid var(--border);border-radius:8px;
  font-family:'JetBrains Mono',monospace;font-size:12.5px;transition:all .2s}
.addr-row:hover{border-color:rgba(0,196,255,.25);background:var(--card2)}
.addr-type{display:inline-flex;align-items:center;justify-content:center;
  padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;flex-shrink:0}
.addr-type.v4{background:var(--adim);color:var(--accent)}
.addr-type.v6{background:var(--cdim);color:var(--cyan)}
.addr-type.dm{background:var(--adim2);color:var(--amber)}
.addr-val{flex:1;color:var(--fg);word-break:break-all}
.addr-check{color:var(--accent);font-size:14px;flex-shrink:0}

/* 手动 */
.divider{display:flex;align-items:center;gap:12px;margin-top:14px;color:var(--muted);font-size:11px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.manual-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.manual-row input{flex:1;min-width:180px;font-size:12.5px;height:40px;padding:0 13px}
.manual-row .btn{height:40px;padding:0 15px;font-size:12.5px}
.manual-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.mtag{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;
  background:var(--bg2);border:1px solid var(--border);border-radius:7px;
  font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--fg);
  cursor:default;transition:all .2s}
.mtag .del{color:var(--red);cursor:pointer;font-size:11px;opacity:.6;transition:opacity .2s}
.mtag .del:hover{opacity:1}

/* 统计 */
.stats{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.st{display:flex;align-items:center;gap:7px;padding:9px 15px;border-radius:9px;
  font-size:12.5px;font-weight:600}
.st-in{background:var(--cdim);color:var(--cyan);border:1px solid rgba(0,196,255,.12)}
.st-addr{background:var(--adim);color:var(--accent);border:1px solid rgba(0,230,138,.12)}
.st-out{background:var(--adim2);color:var(--amber);border:1px solid rgba(255,190,64,.12)}
.st-ok{background:var(--adim);color:var(--accent);border:1px solid rgba(0,230,138,.12)}
.st-fail{background:var(--rdim);color:var(--red);border:1px solid rgba(255,77,94,.12)}
.st-mul{font-size:11px;opacity:.7;font-weight:400;margin-left:2px}

/* 订阅链接 */
.sub-box{margin-top:16px;padding:16px;
  background:linear-gradient(135deg,rgba(0,230,138,.04),rgba(0,196,255,.04));
  border:1px solid rgba(0,230,138,.15);border-radius:10px}
.sub-box .sub-label{font-size:11px;font-weight:700;text-transform:uppercase;
  letter-spacing:.6px;color:var(--accent);margin-bottom:10px}
.sub-url{display:flex;gap:8px;align-items:center}
.sub-url input{flex:1;height:42px;font-size:12px;
  background:var(--bg);border-color:rgba(0,230,138,.15);color:var(--cyan)}
.sub-url input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--adim)}
.sub-hint{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6}

/* 输出 */
.olbl{font-size:11px;color:var(--muted);margin-top:18px;margin-bottom:5px;
  font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.obox{position:relative;background:var(--bg2);border:1px solid var(--border);
  border-radius:10px;padding:12px 14px;
  font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--muted);
  word-break:break-all;min-height:52px;max-height:240px;overflow-y:auto;
  line-height:1.7;transition:border-color .3s}
.obox.filled{color:var(--fg);border-color:rgba(0,230,138,.15)}

.fail-list{margin-top:10px;max-height:110px;overflow-y:auto}
.fail-i{display:flex;gap:8px;padding:5px 10px;font-size:11.5px;
  font-family:'JetBrains Mono',monospace;color:var(--red);
  border-radius:6px;background:var(--rdim);margin-bottom:3px}

/* Toast */
.tc{position:fixed;top:18px;right:18px;z-index:9999;display:flex;flex-direction:column;gap:9px}
.t{display:flex;align-items:center;gap:9px;padding:12px 16px;border-radius:10px;
  font-size:13px;font-weight:500;box-shadow:0 8px 30px rgba(0,0,0,.45);
  animation:ti .3s ease-out;max-width:350px}
.t.ok{background:rgba(0,230,138,.1);border:1px solid rgba(0,230,138,.2);color:var(--accent)}
.t.er{background:var(--rdim);border:1px solid rgba(255,77,94,.2);color:var(--red)}
.t.rm{animation:to .25s ease-in forwards}
@keyframes ti{from{opacity:0;transform:translateX(36px)}to{opacity:1;transform:translateX(0)}}
@keyframes to{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(36px)}}

.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--bg);
  border-top-color:transparent;border-radius:50%;animation:sp .6s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}

footer{text-align:center;margin-top:44px;color:var(--muted);font-size:11px;opacity:.35}

::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}

@media(max-width:640px){
  .wrap{padding:18px 10px 36px}
  header h1{font-size:21px}
  .card{padding:16px}
  .btn-row{flex-direction:column}
  .btn-row .btn{justify-content:center}
  .stats{flex-direction:column}
  .sub-url{flex-direction:column}
  .sub-url input{min-width:0}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<div class="bg-glow"></div>
<div class="bg-grid"></div>
<div class="scan"></div>
<div class="tc" id="tc"></div>

<div class="wrap">
  <header>
    <div class="logo"><i class="fas fa-layer-group"></i></div>
    <h1>VLESS 批量转换 & 订阅生成</h1>
    <p>解析链接提取所有地址，<b>每个地址生成独立节点</b>，输出可订阅的 Base64</p>
  </header>

  <div class="tip">
    <i class="fas fa-lightbulb"></i>
    <span>输入 <b>N 个 VLESS 节点</b> + 解析出 <b>M 个地址</b>，将生成 <b>N x M 个节点</b>并打包为 Base64 订阅。订阅链接有效期 24 小时。</span>
  </div>

  <!-- 步骤1：节点 -->
  <section class="card">
    <div class="hd">
      <div class="ic"><i class="fas fa-link"></i></div>
      <span>输入 VLESS 节点</span>
      <span class="bdg bdg-n" id="nCnt">0</span>
      <span class="bdg bdg-step">1</span>
    </div>
    <textarea id="nodeIn" placeholder="支持格式：&#10;&#10;1. 直接粘贴 Base64 订阅内容&#10;2. 每行一个 vless:// 链接&#10;3. 混合内容（自动识别 vless:// 行）" spellcheck="false"></textarea>
  </section>

  <!-- 步骤2：地址 -->
  <section class="card">
    <div class="hd">
      <div class="ic cyan"><i class="fas fa-crosshairs"></i></div>
      <span>提取目标地址</span>
      <span class="bdg bdg-addr" id="aCnt">0</span>
      <span class="bdg bdg-step">2</span>
    </div>
    <input type="text" id="linkIn" placeholder="输入解析链接，如 https://speed.cloudflare.com/cdn-cgi/trace" spellcheck="false">
    <div class="btn-row">
      <button class="btn btn-p" id="resBtn" onclick="doResolve()">
        <i class="fas fa-magnifying-glass"></i>解析链接
      </button>
      <button class="btn btn-s" onclick="clearAddrs()">
        <i class="fas fa-trash-can"></i>清空地址
      </button>
    </div>
    <div class="addr-list" id="addrList"></div>
    <div class="divider">或手动添加</div>
    <div class="manual-row">
      <input type="text" id="manIn" placeholder="输入 IP 或域名后回车">
      <button class="btn btn-s" onclick="addManual()"><i class="fas fa-plus"></i>添加</button>
    </div>
    <div class="manual-tags" id="manTags"></div>
  </section>

  <!-- 步骤3：转换 -->
  <section class="card">
    <div class="hd">
      <div class="ic amber"><i class="fas fa-bolt"></i></div>
      <span>批量转换 & 订阅</span>
      <span class="bdg bdg-step">3</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-p" id="cvBtn" onclick="doConvert()" disabled>
        <i class="fas fa-arrows-rotate"></i>执行批量转换
      </button>
    </div>

    <div class="stats" id="statsBar" style="display:none"></div>
    <div class="fail-list" id="failBox"></div>

    <!-- 订阅链接 -->
    <div class="sub-box" id="subBox" style="display:none">
      <div class="sub-label"><i class="fas fa-rss"></i> 订阅链接</div>
      <div class="sub-url">
        <input type="text" id="subUrl" readonly>
        <button class="btn btn-c" onclick="copyEl('subUrl')"><i class="fas fa-copy"></i>复制</button>
      </div>
      <div class="sub-hint">可直接粘贴到 v2rayN / Nekoray / Clash Verge / Shadowrocket 等客户端的订阅地址栏。链接 24 小时内有效。</div>
    </div>

    <div class="olbl">VLESS 节点（全部）</div>
    <div class="obox" id="oVless">转换结果将显示在这里</div>

    <div class="olbl">Base64 编码</div>
    <div class="obox" id="oB64">Base64 结果将显示在这里</div>

    <div class="btn-row">
      <button class="btn btn-s" onclick="copyEl('oVless')"><i class="fas fa-copy"></i>复制节点</button>
      <button class="btn btn-s" onclick="copyEl('oB64')"><i class="fas fa-copy"></i>复制 Base64</button>
    </div>
  </section>

  <footer>VLESS Batch Converter &middot; 订阅数据仅存于内存，24h 自动清除</footer>
</div>

<script>
// 全局地址池
var addrPool = [];

/* ===== Toast ===== */
function toast(m,t){
  var c=document.getElementById('tc'),e=document.createElement('div');
  e.className='t '+(t||'ok');
  e.innerHTML='<i class="fas '+(t==='er'?'fa-circle-xmark':'fa-circle-check')+'"></i><span>'+m+'</span>';
  c.appendChild(e);
  setTimeout(function(){e.classList.add('rm');setTimeout(function(){e.remove()},250)},3200);
}

/* ===== 节点计数 ===== */
function countNodes(){
  var v=document.getElementById('nodeIn').value.trim(),n=0;
  if(v){
    try{var d=atob(v);n=d.split(/[\\n\\r]+/).filter(function(l){return l.trim().startsWith('vless://')}).length}
    catch(e){n=v.split(/[\\n\\r]+/).filter(function(l){return l.trim().startsWith('vless://')}).length}
  }
  document.getElementById('nCnt').textContent=n;
  checkReady();
}
document.getElementById('nodeIn').addEventListener('input',countNodes);

/* ===== 地址管理 ===== */
function updAddrUI(){
  document.getElementById('aCnt').textContent=addrPool.length;
  renderAddrList();
  checkReady();
}

function renderAddrList(){
  var el=document.getElementById('addrList');el.innerHTML='';
  if(addrPool.length===0){el.style.display='none';return}
  el.style.display='flex';
  addrPool.forEach(function(item,i){
    var cls=item.type==='IPv4'?'v4':item.type==='IPv6'?'v6':'dm';
    el.innerHTML+='<div class="addr-row">'+
      '<span class="addr-type '+cls+'">'+item.type+'</span>'+
      '<span class="addr-val">'+esc(item.addr)+'</span>'+
      '<span class="addr-check"><i class="fas fa-circle-check"></i></span>'+
      '</div>';
  });
}

function clearAddrs(){
  addrPool=[];updAddrUI();
  document.getElementById('manTags').innerHTML='';
  toast('地址已清空');
}

function addManual(){
  var v=document.getElementById('manIn').value.trim();
  if(!v){toast('请输入地址','er');return}
  // 判断类型
  var type='域名';
  if(/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(v)) type='IPv4';
  else if(/^[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7}$/.test(v)) type='IPv6';
  // 去重
  if(!addrPool.some(function(a){return a.addr===v})){
    addrPool.push({addr:v,type:type});
    updAddrUI();
    renderManTag(v);
    toast('已添加: '+v);
  }else{toast('地址已存在','er')}
  document.getElementById('manIn').value='';
}

function renderManTag(addr){
  var box=document.getElementById('manTags');
  // 检查是否已有
  if(box.querySelector('[data-a="'+addr+'"]')) return;
  var tag=document.createElement('div');tag.className='mtag';tag.setAttribute('data-a',addr);
  tag.innerHTML='<span>'+esc(addr)+'</span><span class="del" onclick="rmManual(this,\\''+addr.replace(/'/g,"\\\\'")+'\\')"><i class="fas fa-xmark"></i></span>';
  box.appendChild(tag);
}

function rmManual(el,addr){
  addrPool=addrPool.filter(function(a){return a.addr!==addr});
  el.parentElement.remove();updAddrUI();
}

/* ===== 解析链接 ===== */
async function doResolve(){
  var link=document.getElementById('linkIn').value.trim();
  if(!link){toast('请输入链接','er');return}
  var btn=document.getElementById('resBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>解析中...';
  try{
    var r=await fetch('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({link:link})});
    var d=await r.json();
    if(d.error){toast(d.error,'er');return}
    // 合并去重
    d.addresses.forEach(function(item){
      if(!addrPool.some(function(a){return a.addr===item.addr})){
        addrPool.push(item);
      }
    });
    updAddrUI();
    toast('已提取 '+d.count+' 个地址，当前共 '+addrPool.length+' 个');
  }catch(e){toast('请求失败: '+e.message,'er')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-magnifying-glass"></i>解析链接'}
}

/* ===== 就绪检查 ===== */
function checkReady(){
  var raw=document.getElementById('nodeIn').value.trim();
  var hasN=false;
  if(raw){
    try{var d=atob(raw);hasN=d.split(/[\\n\\r]+/).some(function(l){return l.trim().startsWith('vless://')})}
    catch(e){hasN=raw.split(/[\\n\\r]+/).some(function(l){return l.trim().startsWith('vless://')})}
  }
  document.getElementById('cvBtn').disabled=!(hasN&&addrPool.length>0);
}

/* ===== 批量转换 ===== */
async function doConvert(){
  var raw=document.getElementById('nodeIn').value.trim();
  if(!raw||addrPool.length===0)return;
  var btn=document.getElementById('cvBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>转换中...';
  try{
    var addrs=addrPool.map(function(a){return a.addr});
    var r=await fetch('/api/convert',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({input:raw,addresses:addrs,host:location.origin})
    });
    var d=await r.json();
    if(d.error){toast(d.error,'er');return}

    // 统计
    var sb=document.getElementById('statsBar');sb.style.display='flex';
    sb.innerHTML=
      '<div class="st st-in"><i class="fas fa-link"></i>输入 '+d.nodesIn+' 节点</div>'+
      '<div class="st st-addr"><i class="fas fa-crosshairs"></i>'+d.addrsOut+' 地址</div>'+
      '<div class="st st-out"><i class="fas fa-layer-group"></i>生成 '+d.totalOut+' 节点<span class="st-mul">'+d.nodesIn+' x '+d.addrsOut+'</span></div>'+
      '<div class="st st-ok"><i class="fas fa-circle-check"></i>成功 '+d.totalOut+'</div>';
    if(d.failed>0){
      sb.innerHTML+='<div class="st st-fail"><i class="fas fa-circle-xmark"></i>失败 '+d.failed+'</div>';
    }

    // 失败
    var fl=document.getElementById('failBox');fl.innerHTML='';
    if(d.failedDetails&&d.failedDetails.length>0){
      d.failedDetails.forEach(function(f){
        fl.innerHTML+='<div class="fail-i"><span>L'+f.line+' / '+esc(f.addr)+'</span><span>'+esc(f.reason)+'</span></div>';
      });
    }

    // 订阅链接
    var subBox=document.getElementById('subBox');
    if(d.subUrl){
      subBox.style.display='block';
      document.getElementById('subUrl').value=d.subUrl;
    }else{subBox.style.display='none'}

    // 输出
    var ov=document.getElementById('oVless');ov.textContent=d.vless;ov.classList.add('filled');
    var ob=document.getElementById('oB64');ob.textContent=d.base64;ob.classList.add('filled');
    toast('完成！生成 '+d.totalOut+' 个节点');
  }catch(e){toast('转换失败: '+e.message,'er')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-arrows-rotate"></i>执行批量转换';checkReady()}
}

/* ===== 复制 ===== */
function copyEl(id){
  var t=document.getElementById(id).textContent||document.getElementById(id).value;
  if(!t||t.indexOf('将显示在这里')!==-1){toast('暂无内容','er');return}
  navigator.clipboard.writeText(t).then(function(){toast('已复制到剪贴板')}).catch(function(){
    var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;left:-9999px';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    toast('已复制到剪贴板');
  });
}

function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}

/* 回车 */
document.getElementById('linkIn').addEventListener('keydown',function(e){if(e.key==='Enter')doResolve()});
document.getElementById('manIn').addEventListener('keydown',function(e){if(e.key==='Enter')addManual()});
</script>
</body>
</html>`;
}
