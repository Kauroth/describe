// _worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/_sub/')) return handleSub(url, env);
    if (url.pathname === '/api/resolve' && request.method === 'POST') return handleResolve(request);
    if (url.pathname === '/api/convert' && request.method === 'POST') return handleConvert(request);

    return new Response(renderHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};

// ==================== 订阅端点（实时解析，零存储） ====================
async function handleSub(url, env) {
  const path = url.pathname.slice(6);
  let vlessRaw, resolveUrls, manualAddrs;

  if (path) {
    // URL 配置模式：从路径解码配置，每次访问实时解析
    try {
      const config = safeAtob(path);
      const parts = config.split('\n');
      vlessRaw = safeAtob(parts[0] || '');
      resolveUrls = parts[1] ? JSON.parse(safeAtob(parts[1])) : [];
      manualAddrs = parts[2] ? JSON.parse(safeAtob(parts[2])) : [];
    } catch {
      return new Response('Invalid subscription config', { status: 400 });
    }
  } else {
    // 环境变量模式
    if (env.VLESS_NODES) vlessRaw = safeAtob(env.VLESS_NODES);
    resolveUrls = env.RESOLVE_URLS
      ? JSON.parse(env.RESOLVE_URLS)
      : (env.RESOLVE_URL ? [env.RESOLVE_URL] : []);
    manualAddrs = env.MANUAL_ADDRS ? JSON.parse(env.MANUAL_ADDRS) : [];
  }

  if (!vlessRaw) return new Response('No nodes configured', { status: 404 });

  // 实时 fetch 所有解析链接
  const allAddrs = [...manualAddrs];
  for (const link of resolveUrls) {
    try {
      const addrs = await extractAddresses(link);
      addrs.forEach(a => { if (!allAddrs.includes(a)) allAddrs.push(a); });
    } catch { /* 单个链接失败不影响其他 */ }
  }

  if (allAddrs.length === 0) return new Response('No addresses resolved', { status: 502 });

  const lines = vlessRaw.split(/[\n\r]+/);
  const vlessList = lines.map(l => l.trim()).filter(l => l.startsWith('vless://'));
  const converted = [];
  vlessList.forEach(raw => {
    allAddrs.forEach(addr => {
      const r = replaceAddr(raw, addr);
      if (r) converted.push(r);
    });
  });

  if (converted.length === 0) return new Response('No valid nodes', { status: 500 });

  return new Response(btoa(converted.join('\n')), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sub"',
      'Profile-Web-Page-Url': url.origin,
      'Cache-Control': 'no-cache',
    }
  });
}

// ==================== 地址提取（共用） ====================
async function extractAddresses(link) {
  const resp = await fetch(link, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000)
  });
  const text = await resp.text();
  const addrs = [];

  const v4r = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
  for (const m of text.matchAll(v4r)) {
    const p = m[1].split('.').map(Number);
    if (p.every(v => v >= 0 && v <= 255) && p[0] !== 0 && p[0] !== 127 &&
      !(p[0] === 10) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
      !(p[0] === 192 && p[1] === 168)) addrs.push(m[1]);
  }
  if (addrs.length > 0) return [...new Set(addrs)];

  const v6r = /\b([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7})\b/g;
  const v6 = [...text.matchAll(v6r)].map(m => m[1]);
  if (v6.length > 0) return [...new Set(v6)];

  const skip = ['google.com', 'cloudflare.com', 'mozilla.org', 'github.com', 'w3.org',
    'jquery.com', 'example.com', 'apache.org', 'nginx.org', 'schema.org', 'json.org',
    'python.org', 'microsoft.com', 'apple.com', 'amazon.com', 'facebook.com', 'twitter.com',
    'youtube.com', 'googleapis.com', 'gstatic.com', 'google-analytics.com', 'doubleclick.net',
    'cloudflareinsights.com', 'cdnjs.cloudflare.com', 'jsdelivr.net', 'unpkg.com'];
  const dr = /\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.([a-zA-Z]{2,}))\b/g;
  const dm = [...text.matchAll(dr)].map(m => m[1].toLowerCase())
    .filter(d => !skip.some(s => d === s || d.endsWith('.' + s)));
  return [...new Set(dm)];
}

function addrType(a) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return 'IPv4';
  if (/^[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7}$/.test(a)) return 'IPv6';
  return '域名';
}

// ==================== 前端 API ====================
async function handleResolve(request) {
  try {
    const { link } = await request.json();
    if (!link) return jRes({ error: '请提供链接' }, 400);
    const addrs = await extractAddresses(link);
    if (addrs.length === 0) {
      try {
        const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
        return jRes({ error: '未能提取到有效地址', preview: (await r.text()).slice(0, 500) }, 400);
      } catch { return jRes({ error: '未能提取到有效地址' }, 400); }
    }
    return jRes({ addresses: addrs.map(a => ({ addr: a, type: addrType(a) })), count: addrs.length });
  } catch (err) { return jRes({ error: err.message }, 500); }
}

async function handleConvert(request) {
  try {
    const { input, resolveUrls, manualAddrs } = await request.json();
    if (!input) return jRes({ error: '缺少节点' }, 400);

    let lines;
    try { lines = atob(input.trim()).split(/[\n\r]+/); }
    catch { lines = input.split(/[\n\r]+/); }
    const vlessList = lines.map(l => l.trim()).filter(l => l.startsWith('vless://'));
    if (vlessList.length === 0) return jRes({ error: '未找到有效 VLESS 节点' }, 400);

    const allAddrs = [...(manualAddrs || [])];
    for (const u of (resolveUrls || [])) {
      try {
        const a = await extractAddresses(u);
        a.forEach(x => { if (!allAddrs.includes(x)) allAddrs.push(x); });
      } catch { /* 单个链接失败跳过 */ }
    }
    if (allAddrs.length === 0) return jRes({ error: '没有可用地址' }, 400);

    const converted = [];
    vlessList.forEach(raw => {
      allAddrs.forEach(addr => {
        const r = replaceAddr(raw, addr);
        if (r) converted.push(r);
      });
    });

    const base64 = btoa(converted.join('\n'));

    // 编码订阅配置（节点+解析链接+手动地址，每次访问实时解析）
    const parts = [
      btoa(vlessList.join('\n')),
      btoa(JSON.stringify(resolveUrls || [])),
      btoa(JSON.stringify(manualAddrs || []))
    ];
    const configB64 = btoa(parts.join('\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const subUrl = new URL(request.url).origin + '/_sub/' + configB64;

    return jRes({ nodesIn: vlessList.length, addrsOut: allAddrs.length, totalOut: converted.length, vless: converted.join('\n'), base64, subUrl });
  } catch (err) { return jRes({ error: err.message }, 500); }
}

// ==================== 工具 ====================
function replaceAddr(link, newAddr) {
  const u = new URL(link);
  if (u.protocol !== 'vless:' || !u.username || !u.hostname || !u.port) return null;
  let a = newAddr;
  if (newAddr.includes(':') && !newAddr.startsWith('[')) a = '[' + newAddr + ']';
  let r = 'vless://' + u.username + '@' + a + ':' + u.port + u.search;
  if (u.hash) r += u.hash;
  return r;
}
function safeAtob(s) { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); }
function jRes(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

// ==================== 页面 ====================
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VLESS 批量转换 & 订阅</title>
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
  background:radial-gradient(700px 500px at 10% 5%,rgba(0,230,138,.045),transparent),
  radial-gradient(600px 600px at 90% 90%,rgba(0,196,255,.035),transparent)}
.bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:radial-gradient(rgba(0,230,138,.06) 1px,transparent 1px);background-size:28px 28px}
.scan{position:fixed;left:0;right:0;height:1px;z-index:0;pointer-events:none;
  background:linear-gradient(90deg,transparent 5%,var(--aglow) 50%,transparent 95%);
  animation:scanY 7s linear infinite;opacity:.3}
@keyframes scanY{0%{top:-1px}100%{top:100vh}}
.wrap{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:32px 18px 60px}
header{text-align:center;margin-bottom:36px}
.logo{display:inline-flex;align-items:center;justify-content:center;width:54px;height:54px;
  border-radius:15px;background:linear-gradient(135deg,var(--adim),var(--cdim));
  border:1px solid var(--border);margin-bottom:14px;font-size:21px;color:var(--accent);
  animation:pulse 3s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 var(--aglow)}50%{box-shadow:0 0 24px 3px var(--aglow)}}
header h1{font-size:26px;font-weight:800;letter-spacing:-.4px;
  background:linear-gradient(135deg,var(--fg) 30%,var(--accent));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
header p{color:var(--muted);font-size:12.5px;font-weight:300;margin-top:4px}
header p b{color:var(--accent);font-weight:600}

.tip{display:flex;align-items:flex-start;gap:9px;padding:13px 15px;
  background:var(--cdim);border:1px solid rgba(0,196,255,.1);border-radius:var(--r);
  margin-bottom:18px;font-size:12px;color:var(--muted);line-height:1.7}
.tip i{color:var(--cyan);font-size:14px;margin-top:2px;flex-shrink:0}
.tip b{color:var(--fg);font-weight:600}

.env-box{display:flex;align-items:flex-start;gap:9px;padding:13px 15px;
  background:var(--adim2);border:1px solid rgba(255,190,64,.1);border-radius:var(--r);
  margin-bottom:18px;font-size:12px;color:var(--muted);line-height:1.7}
.env-box i{color:var(--amber);font-size:14px;margin-top:2px;flex-shrink:0}
.env-box b{color:var(--amber);font-weight:600}
.env-box code{font-family:'JetBrains Mono',monospace;font-size:11px;
  background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;color:var(--fg)}

.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);
  padding:22px;margin-bottom:14px;transition:border-color .3s,box-shadow .3s}
.card:hover{border-color:rgba(0,230,138,.1);box-shadow:0 4px 24px rgba(0,0,0,.25)}
.hd{display:flex;align-items:center;gap:9px;margin-bottom:13px}
.hd .ic{color:var(--accent);font-size:14px;width:27px;height:27px;
  display:flex;align-items:center;justify-content:center;
  background:var(--adim);border-radius:7px;flex-shrink:0}
.hd .ic.c{color:var(--cyan);background:var(--cdim)}
.hd .ic.a{color:var(--amber);background:var(--adim2)}
.hd span{font-size:13.5px;font-weight:600}
.bdg{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;
  min-width:21px;height:21px;padding:0 6px;border-radius:5px;
  font-size:10.5px;font-weight:800;font-family:'JetBrains Mono',monospace}
.bdg-s{background:var(--accent);color:var(--bg)}
.bdg-n{background:var(--adim);color:var(--accent);border:1px solid rgba(0,230,138,.12)}
.bdg-a{background:var(--cdim);color:var(--cyan);border:1px solid rgba(0,196,255,.12)}

textarea,input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--border);
  border-radius:9px;color:var(--fg);font-family:'JetBrains Mono',monospace;
  font-size:12px;padding:11px 13px;resize:vertical;outline:none;transition:border-color .25s,box-shadow .25s}
textarea:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--adim)}
textarea::placeholder,input::placeholder{color:var(--muted);opacity:.4}
textarea{min-height:100px;line-height:1.7}
input[type=text]{height:42px}

.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:9px;
  font-family:'Noto Sans SC',sans-serif;font-size:12.5px;font-weight:600;
  border:none;cursor:pointer;transition:all .2s;outline:none;white-space:nowrap}
.btn:active{transform:scale(.97)}
.btn-p{background:var(--accent);color:var(--bg);box-shadow:0 2px 12px var(--aglow)}
.btn-p:hover{box-shadow:0 4px 20px var(--aglow);filter:brightness(1.08)}
.btn-p:disabled{opacity:.3;cursor:not-allowed;filter:none;box-shadow:none}
.btn-s{background:var(--bg2);color:var(--fg);border:1px solid var(--border)}
.btn-s:hover{border-color:var(--accent);background:var(--card2)}
.btn-c{background:rgba(0,196,255,.1);color:var(--cyan);border:1px solid rgba(0,196,255,.18)}
.btn-c:hover{background:rgba(0,196,255,.16);border-color:var(--cyan)}
.btn-d{background:var(--rdim);color:var(--red);border:1px solid rgba(255,77,94,.15)}
.btn-d:hover{background:rgba(255,77,94,.15);border-color:var(--red)}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}

/* 地址区域 */
.section-label{font-size:11px;color:var(--muted);font-weight:700;margin-top:14px;
  margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;
  display:flex;align-items:center;gap:6px}
.section-label::after{content:'';flex:1;height:1px;background:var(--border)}

.addr-list{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
.addr-row{display:flex;align-items:center;gap:9px;padding:7px 12px;
  background:var(--bg2);border:1px solid var(--border);border-radius:7px;
  font-family:'JetBrains Mono',monospace;font-size:12px;transition:all .2s}
.addr-row:hover{border-color:rgba(0,196,255,.2);background:var(--card2)}
.at{display:inline-flex;align-items:center;justify-content:center;
  padding:1px 7px;border-radius:4px;font-size:9.5px;font-weight:700;flex-shrink:0}
.at.v4{background:var(--adim);color:var(--accent)}
.at.v6{background:var(--cdim);color:var(--cyan)}
.at.dm{background:var(--adim2);color:var(--amber)}
.av{flex:1;color:var(--fg);word-break:break-all}
.asrc{font-size:10px;color:var(--muted);flex-shrink:0;max-width:140px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ack{color:var(--accent);font-size:13px;flex-shrink:0}

.url-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.utag{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;
  background:var(--bg2);border:1px solid var(--border);border-radius:6px;
  font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--cyan);
  max-width:320px;overflow:hidden}
.utag span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.utag .x{cursor:pointer;color:var(--red);opacity:.6;flex-shrink:0;transition:opacity .2s}
.utag .x:hover{opacity:1}

.manual-row{display:flex;gap:7px;flex-wrap:wrap}
.manual-row input{flex:1;min-width:160px;font-size:12px;height:38px;padding:0 12px}
.manual-row .btn{height:38px;padding:0 14px;font-size:12px}
.mtags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.mt{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;
  background:var(--bg2);border:1px solid var(--border);border-radius:6px;
  font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--fg)}
.mt .x{cursor:pointer;color:var(--red);opacity:.5;font-size:10px;transition:opacity .2s}
.mt .x:hover{opacity:1}

.divider{display:flex;align-items:center;gap:12px;margin-top:12px;color:var(--muted);font-size:11px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}

.stats{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}
.st{display:flex;align-items:center;gap:6px;padding:8px 13px;border-radius:8px;
  font-size:12px;font-weight:600}
.st-in{background:var(--cdim);color:var(--cyan);border:1px solid rgba(0,196,255,.1)}
.st-addr{background:var(--adim);color:var(--accent);border:1px solid rgba(0,230,138,.1)}
.st-out{background:var(--adim2);color:var(--amber);border:1px solid rgba(255,190,64,.1)}
.st-ok{background:var(--adim);color:var(--accent);border:1px solid rgba(0,230,138,.1)}
.st-mul{font-size:10px;opacity:.65;font-weight:400;margin-left:2px}

.sub-box{margin-top:15px;padding:15px;
  background:linear-gradient(135deg,rgba(0,230,138,.03),rgba(0,196,255,.03));
  border:1px solid rgba(0,230,138,.12);border-radius:10px}
.sub-label{font-size:11px;font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--accent);margin-bottom:9px;
  display:flex;align-items:center;gap:6px}
.sub-url{display:flex;gap:7px;align-items:center}
.sub-url input{flex:1;height:40px;font-size:11.5px;
  background:var(--bg);border-color:rgba(0,230,138,.12);color:var(--cyan)}
.sub-url input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--adim)}
.sub-hint{font-size:11px;color:var(--muted);margin-top:7px;line-height:1.6}
.sub-hint b{color:var(--accent);font-weight:600}

.olbl{font-size:10.5px;color:var(--muted);margin-top:16px;margin-bottom:4px;
  font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.obox{position:relative;background:var(--bg2);border:1px solid var(--border);
  border-radius:9px;padding:11px 13px;font-family:'JetBrains Mono',monospace;
  font-size:11px;color:var(--muted);word-break:break-all;min-height:48px;
  max-height:220px;overflow-y:auto;line-height:1.7;transition:border-color .3s}
.obox.filled{color:var(--fg);border-color:rgba(0,230,138,.12)}

.tc{position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px}
.t{display:flex;align-items:center;gap:8px;padding:11px 15px;border-radius:9px;
  font-size:12.5px;font-weight:500;box-shadow:0 8px 28px rgba(0,0,0,.4);
  animation:ti .3s ease-out;max-width:340px}
.t.ok{background:rgba(0,230,138,.1);border:1px solid rgba(0,230,138,.18);color:var(--accent)}
.t.er{background:var(--rdim);border:1px solid rgba(255,77,94,.18);color:var(--red)}
.t.rm{animation:to .25s ease-in forwards}
@keyframes ti{from{opacity:0;transform:translateX(34px)}to{opacity:1;transform:translateX(0)}}
@keyframes to{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(34px)}}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--bg);
  border-top-color:transparent;border-radius:50%;animation:sp .6s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
footer{text-align:center;margin-top:40px;color:var(--muted);font-size:10.5px;opacity:.3}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
@media(max-width:640px){
  .wrap{padding:16px 10px 32px}header h1{font-size:20px}
  .card{padding:15px}.btn-row{flex-direction:column}.btn-row .btn{justify-content:center}
  .stats{flex-direction:column}.sub-url{flex-direction:column}.sub-url input{min-width:0}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<div class="bg-glow"></div><div class="bg-grid"></div><div class="scan"></div>
<div class="tc" id="tc"></div>

<div class="wrap">
  <header>
    <div class="logo"><i class="fas fa-layer-group"></i></div>
    <h1>VLESS 批量转换 & 订阅</h1>
    <p>每个解析地址生成独立节点，订阅链接<b>实时解析</b>，IP 变化自动同步</p>
  </header>

  <div class="tip">
    <i class="fas fa-lightbulb"></i>
    <span>输入 <b>N 个节点</b> + 解析出 <b>M 个地址</b> = 生成 <b>N×M 个节点</b>。订阅链接将配置编码在 URL 中，<b>零服务端存储</b>，每次客户端拉取订阅时实时重新解析链接获取最新 IP。</span>
  </div>

  <div class="env-box">
    <i class="fas fa-server"></i>
    <span>也可通过环境变量配置固定订阅（访问 <b>/_sub/</b> 即可）：
    <code>VLESS_NODES</code>=Base64节点，
    <code>RESOLVE_URLS</code>=<code>["url1","url2"]</code>，
    <code>MANUAL_ADDRS</code>=<code>["ip1"]</code></span>
  </div>

  <!-- 步骤1 -->
  <section class="card">
    <div class="hd">
      <div class="ic"><i class="fas fa-link"></i></div><span>输入 VLESS 节点</span>
      <span class="bdg bdg-n" id="nCnt">0</span><span class="bdg bdg-s">1</span>
    </div>
    <textarea id="nodeIn" placeholder="支持：&#10;1. 直接粘贴 Base64 订阅内容&#10;2. 每行一个 vless:// 链接&#10;3. 混合内容（自动识别 vless:// 行）" spellcheck="false"></textarea>
  </section>

  <!-- 步骤2 -->
  <section class="card">
    <div class="hd">
      <div class="ic c"><i class="fas fa-crosshairs"></i></div><span>提取目标地址</span>
      <span class="bdg bdg-a" id="aCnt">0</span><span class="bdg bdg-s">2</span>
    </div>
    <input type="text" id="linkIn" placeholder="输入解析链接，如 https://speed.cloudflare.com/cdn-cgi/trace" spellcheck="false">
    <div class="btn-row">
      <button class="btn btn-p" id="resBtn" onclick="doResolve()"><i class="fas fa-magnifying-glass"></i>解析链接</button>
      <button class="btn btn-d" onclick="clearAll()"><i class="fas fa-trash-can"></i>清空全部</button>
    </div>

    <div class="section-label">解析链接列表</div>
    <div class="url-tags" id="urlTags"></div>

    <div class="section-label">已提取地址</div>
    <div class="addr-list" id="addrList"></div>

    <div class="divider">或手动添加地址</div>
    <div class="manual-row">
      <input type="text" id="manIn" placeholder="输入 IP 或域名">
      <button class="btn btn-s" onclick="addManual()"><i class="fas fa-plus"></i>添加</button>
    </div>
    <div class="mtags" id="manTags"></div>
  </section>

  <!-- 步骤3 -->
  <section class="card">
    <div class="hd">
      <div class="ic a"><i class="fas fa-bolt"></i></div><span>批量转换 & 订阅</span>
      <span class="bdg bdg-s">3</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-p" id="cvBtn" onclick="doConvert()" disabled>
        <i class="fas fa-arrows-rotate"></i>执行批量转换
      </button>
    </div>
    <div class="stats" id="statsBar" style="display:none"></div>
    <div class="sub-box" id="subBox" style="display:none">
      <div class="sub-label"><i class="fas fa-rss"></i> 实时订阅链接</div>
      <div class="sub-url">
        <input type="text" id="subUrl" readonly>
        <button class="btn btn-c" onclick="copyEl('subUrl')"><i class="fas fa-copy"></i>复制</button>
      </div>
      <div class="sub-hint">将此链接粘贴到客户端订阅地址栏。每次拉取时<b>实时重新解析</b>源链接获取最新 IP，无需手动更新。</div>
    </div>
    <div class="olbl">VLESS 节点</div>
    <div class="obox" id="oV">转换结果将显示在这里</div>
    <div class="olbl">Base64 编码</div>
    <div class="obox" id="oB">Base64 结果将显示在这里</div>
    <div class="btn-row">
      <button class="btn btn-s" onclick="copyEl('oV')"><i class="fas fa-copy"></i>复制节点</button>
      <button class="btn btn-s" onclick="copyEl('oB')"><i class="fas fa-copy"></i>复制 Base64</button>
    </div>
  </section>

  <footer>VLESS Batch Converter &middot; 零存储 &middot; 实时解析</footer>
</div>

<script>
var resolveUrls = [];  // 已解析的链接列表
var manualAddrs = [];  // 手动地址列表
var addrPool = [];     // 所有地址（用于显示）

function toast(m,t){
  var c=document.getElementById('tc'),e=document.createElement('div');
  e.className='t '+(t||'ok');
  e.innerHTML='<i class="fas '+(t==='er'?'fa-circle-xmark':'fa-circle-check')+'"></i><span>'+m+'</span>';
  c.appendChild(e);setTimeout(function(){e.classList.add('rm');setTimeout(function(){e.remove()},250)},3200);
}

/* 节点计数 */
function countNodes(){
  var v=document.getElementById('nodeIn').value.trim(),n=0;
  if(v){try{var d=atob(v);n=d.split(/[\\n\\r]+/).filter(function(l){return l.trim().startsWith('vless://')}).length}catch(e){n=v.split(/[\\n\\r]+/).filter(function(l){return l.trim().startsWith('vless://')}).length}}
  document.getElementById('nCnt').textContent=n;checkReady();
}
document.getElementById('nodeIn').addEventListener('input',countNodes);

/* 刷新地址池 */
function refreshPool(){
  document.getElementById('aCnt').textContent=addrPool.length;
  var el=document.getElementById('addrList');el.innerHTML='';
  if(addrPool.length===0){el.innerHTML='<div style="font-size:11px;color:var(--muted);opacity:.5;padding:8px 0">暂无地址</div>';return}
  addrPool.forEach(function(item){
    var cls=item.type==='IPv4'?'v4':item.type==='IPv6'?'v6':'dm';
    var src=item.src?'<span class="asrc" title="'+esc(item.src)+'">'+esc(shorten(item.src,30))+'</span>':'';
    el.innerHTML+='<div class="addr-row"><span class="at '+cls+'">'+item.type+'</span><span class="av">'+esc(item.addr)+'</span>'+src+'<span class="ack"><i class="fas fa-circle-check"></i></span></div>';
  });
  checkReady();
}

function renderUrlTags(){
  var el=document.getElementById('urlTags');el.innerHTML='';
  resolveUrls.forEach(function(u,i){
    el.innerHTML+='<div class="utag"><span title="'+esc(u)+'">'+esc(shorten(u,40))+'</span><span class="x" onclick="rmUrl('+i+')"><i class="fas fa-xmark"></i></span></div>';
  });
}

function rmUrl(idx){
  var removed=resolveUrls.splice(idx,1)[0];
  // 从地址池移除该链接的地址
  addrPool=addrPool.filter(function(a){return a.src!==removed});
  renderUrlTags();refreshPool();
}

function renderManTags(){
  var el=document.getElementById('manTags');el.innerHTML='';
  manualAddrs.forEach(function(a,i){
    el.innerHTML+='<div class="mt"><span>'+esc(a)+'</span><span class="x" onclick="rmManual('+i+')"><i class="fas fa-xmark"></i></span></div>';
  });
}

function rmManual(idx){
  var removed=manualAddrs.splice(idx,1)[0];
  addrPool=addrPool.filter(function(a){return a.src!=='manual'||a.addr!==removed});
  renderManTags();refreshPool();
}

function clearAll(){
  resolveUrls=[];manualAddrs=[];addrPool=[];
  renderUrlTags();renderManTags();refreshPool();
  toast('已清空');
}

function shorten(s,n){return s.length>n?s.slice(0,n)+'...':s}

/* 解析链接 */
async function doResolve(){
  var link=document.getElementById('linkIn').value.trim();
  if(!link){toast('请输入链接','er');return}
  if(resolveUrls.indexOf(link)!==-1){toast('该链接已解析过','er');return}
  var btn=document.getElementById('resBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>解析中...';
  try{
    var r=await fetch('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({link:link})});
    var d=await r.json();
    if(d.error){toast(d.error,'er');return}
    resolveUrls.push(link);
    d.addresses.forEach(function(item){
      if(!addrPool.some(function(a){return a.addr===item.addr})){
        addrPool.push({addr:item.addr,type:item.type,src:link});
      }
    });
    renderUrlTags();refreshPool();
    toast('提取 '+d.count+' 个地址，共 '+addrPool.length+' 个');
    document.getElementById('linkIn').value='';
  }catch(e){toast('请求失败: '+e.message,'er')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-magnifying-glass"></i>解析链接'}
}

/* 手动添加 */
function addManual(){
  var v=document.getElementById('manIn').value.trim();
  if(!v){toast('请输入地址','er');return}
  var type='域名';
  if(/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(v))type='IPv4';
  else if(/^[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7}$/.test(v))type='IPv6';
  if(addrPool.some(function(a){return a.addr===v})){toast('地址已存在','er');return}
  if(manualAddrs.indexOf(v)===-1)manualAddrs.push(v);
  addrPool.push({addr:v,type:type,src:'manual'});
  renderManTags();refreshPool();
  document.getElementById('manIn').value='';
  toast('已添加: '+v);
}

function checkReady(){
  var raw=document.getElementById('nodeIn').value.trim(),hasN=false;
  if(raw){try{var d=atob(raw);hasN=d.split(/[\\n\\r]+/).some(function(l){return l.trim().startsWith('vless://')})}catch(e){hasN=raw.split(/[\\n\\r]+/).some(function(l){return l.trim().startsWith('vless://')})}}
  document.getElementById('cvBtn').disabled=!(hasN&&addrPool.length>0);
}

/* 批量转换 */
async function doConvert(){
  var raw=document.getElementById('nodeIn').value.trim();
  if(!raw||addrPool.length===0)return;
  var btn=document.getElementById('cvBtn');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>转换中...';
  try{
    var addrs=addrPool.map(function(a){return a.addr});
    var r=await fetch('/api/convert',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({input:raw,resolveUrls:resolveUrls,manualAddrs:manualAddrs})
    });
    var d=await r.json();
    if(d.error){toast(d.error,'er');return}

    var sb=document.getElementById('statsBar');sb.style.display='flex';
    sb.innerHTML=
      '<div class="st st-in"><i class="fas fa-link"></i>'+d.nodesIn+' 节点</div>'+
      '<div class="st st-addr"><i class="fas fa-crosshairs"></i>'+d.addrsOut+' 地址</div>'+
      '<div class="st st-out"><i class="fas fa-layer-group"></i>'+d.totalOut+' 节点<span class="st-mul">'+d.nodesIn+' x '+d.addrsOut+'</span></div>'+
      '<div class="st st-ok"><i class="fas fa-circle-check"></i>成功 '+d.totalOut+'</div>';

    var subBox=document.getElementById('subBox');
    if(d.subUrl){subBox.style.display='block';document.getElementById('subUrl').value=d.subUrl}
    else{subBox.style.display='none'}

    var ov=document.getElementById('oV');ov.textContent=d.vless;ov.classList.add('filled');
    var ob=document.getElementById('oB');ob.textContent=d.base64;ob.classList.add('filled');
    toast('完成！生成 '+d.totalOut+' 个节点，订阅已就绪');
  }catch(e){toast('转换失败: '+e.message,'er')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-arrows-rotate"></i>执行批量转换';checkReady()}
}

function copyEl(id){
  var el=document.getElementById(id);
  var t=el.value||el.textContent;
  if(!t||t.indexOf('将显示在这里')!==-1){toast('暂无内容','er');return}
  navigator.clipboard.writeText(t).then(function(){toast('已复制')}).catch(function(){
    var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;left:-9999px';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('已复制');
  });
}

function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
document.getElementById('linkIn').addEventListener('keydown',function(e){if(e.key==='Enter')doResolve()});
document.getElementById('manIn').addEventListener('keydown',function(e){if(e.key==='Enter')addManual()});

// 初始渲染
refreshPool();
</script>
</body>
</html>`;
}
