// _worker.js
// 多协议优选转换器 + 节点编辑器
// 支持 vless / vmess / trojan / ss / hysteria2
//
// ADDR 环境变量：每行一个源，名称可省略
//   名称|地址1,地址2,地址3
//   多个候选地址按顺序尝试，第一个 HTTP 200 生效，全挂才报错。
//
// 路由
//   /                                    节点编辑器 + 批量优选页面
//   /?sources=1                          看 ADDR 解析结果
//   /?probe=1                            逐个候选地址实测
//   /?source=N&template=..&format=base64 单源订阅（Sub-Store 在用这条）
//   /?all=true&template=..               所有源一起出，给页面用
//   /?share=<b64url>                     把编辑器里的节点编码成订阅

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 单次尝试上限。Sub-Store 拉订阅的超时是 8s，这里必须留出余量，
// 否则候选地址还没试完，对方就先报超时了。
const FETCH_TIMEOUT = 5000;

// 模板端口为 443 时，按地址哈希从这里挑一个，保证同一 IP 每次拿到的端口不变
// （以前用 Math.random，订阅每刷新一次端口就跳，节点反复重连）。
const CF_TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

const SHARE_LIMIT = 16384;
const PREVIEW_LIMIT = 50;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = url.searchParams;

    // 分享链接不依赖 ADDR，先处理
    if (q.has('share')) return handleShare(q);

    const sources = parseSources(env && env.ADDR);

    if (q.get('sources') === '1') {
      if (!sources.length) return plain('错误：环境变量 ADDR 未配置或格式不正确。', 500);
      return json({
        success: true,
        count: sources.length,
        sources: sources.map((s, i) => ({ index: i, name: s.name, urls: s.urls }))
      });
    }

    if (q.get('probe') === '1') {
      if (!sources.length) return plain('错误：环境变量 ADDR 未配置或格式不正确。', 500);
      const rows = await Promise.all(sources.map(async (src, idx) => {
        const attempts = [];
        for (const u of src.urls) {
          const r = await tryFetch(u);
          attempts.push({
            url: u,
            ok: r.ok,
            status: r.status,
            lines: r.text ? r.text.split(/\r?\n/).filter(Boolean).length : 0,
            sample: r.text ? r.text.slice(0, 100) : '',
            error: r.error
          });
          if (r.ok) break;
        }
        return { index: idx, name: src.name, attempts };
      }));
      return json({ success: true, count: sources.length, results: rows });
    }

    if (q.has('template')) return handleTemplate(q, sources, url);

    return new Response(renderPage(sources), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
};

// ==========================================
// 订阅：模板 + 优选地址
// ==========================================

async function handleTemplate(q, sources, url) {
  const template = (q.get('template') || '').trim();
  const info = templateInfo(template);
  if (!info) {
    return plain('错误：模板节点无法解析。支持 vless:// vmess:// trojan:// ss:// hysteria2://', 400);
  }
  if (!sources.length) return plain('错误：环境变量 ADDR 未配置或格式不正确。', 500);

  const subLink = (idx) =>
    `${url.origin}${url.pathname}?source=${idx}&template=${encodeURIComponent(template)}&format=base64`;

  // ---------- 一次产出所有源 ----------
  if (q.get('all') === 'true' || q.get('api') === 'all') {
    const results = await Promise.all(sources.map(async (src, idx) => {
      const pool = await fetchPool(src.urls);
      const items = parsePool(pool.text);

      if (!items.length) {
        return {
          index: idx,
          name: src.name,
          count: 0,
          url: pool.url || '',
          error: pool.error || '拉到了内容，但没解析出任何有效地址',
          subscribeLink: subLink(idx)
        };
      }

      const nodes = buildAll(template, items, info.port);
      return {
        index: idx,
        name: src.name,
        count: nodes.length,
        url: pool.url || '',
        preview: nodes.slice(0, PREVIEW_LIMIT),
        subscribeLink: subLink(idx)
      };
    }));

    return json({
      success: true,
      protocol: info.scheme,
      originalAddr: `${info.host}:${info.port}`,
      results
    });
  }

  // ---------- 单个源 ----------
  const rawIndex = q.get('source');
  const idx = rawIndex === null ? 0 : Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= sources.length) {
    const names = sources.map((s, i) => `${i}=${s.name}`).join('，');
    return plain(`错误：source=${rawIndex} 越界，ADDR 里只有 ${sources.length} 个源（${names}）。`, 400);
  }

  const src = sources[idx];
  const pool = await fetchPool(src.urls);
  const items = parsePool(pool.text);

  if (!items.length) {
    const msg = pool.error || '拉到了内容，但没解析出任何有效地址';
    if (q.get('api') === 'true') {
      return json({ error: msg, sourceName: src.name, sourceUrl: pool.url || '' });
    }
    return plain(`错误：${msg}`, 400);
  }

  const nodes = buildAll(template, items, info.port);
  if (!nodes.length) return plain('错误：模板能解析，但没有生成出任何节点。', 400);

  const format = (q.get('format') || '').toLowerCase();
  if (format === 'base64') return subResponse(toBase64(nodes.map(n => n.url).join('\n')));
  if (format === 'plain' || format === 'raw') return subResponse(nodes.map(n => n.url).join('\n'));

  return json({
    success: true,
    protocol: info.scheme,
    originalAddr: `${info.host}:${info.port}`,
    sourceIndex: idx,
    sourceName: src.name,
    count: nodes.length,
    nodes,
    subscribeLink: subLink(idx)
  });
}

function buildAll(template, items, tplPort) {
  const out = [];
  for (const item of items) {
    const port = pickPort(item.addr, tplPort, item.port);
    const remark = item.remark || item.addr;
    const uri = buildNode(template, item.addr, port, remark);
    if (uri) out.push({ url: uri, addr: item.addr, port, remark });
  }
  return out;
}

function handleShare(q) {
  const raw = q.get('share') || '';
  if (!raw) return plain('错误：share 参数为空。', 400);

  let text = '';
  try {
    text = b64Decode(raw);
  } catch (err) {
    return plain('错误：share 参数无法解码，链接可能被截断了。', 400);
  }
  if (text.length > SHARE_LIMIT) return plain('错误：分享内容过长。', 413);

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return plain('错误：分享链接里没有节点。', 400);

  const body = lines.join('\n');
  if ((q.get('format') || '').toLowerCase() === 'plain') return subResponse(body);
  return subResponse(toBase64(body));
}

// ==========================================
// 保留原功能的辅助
// ==========================================

// Cloudflare 后台的变量框是单行的，换行粘进去会被吃掉，几条源就粘成一整行：
//   移动优选|https://a.txt电信优选|https://b.txt
// 结果被当成一条源、一个畸形 URL，拉取直接 404。三条路一起兜：
//   1. 字面量 \n（反斜杠 + n）当换行，单行框里能直接打
//   2. || 当分隔符
//   3. 实在什么都没有，就猜：整段没有换行且多个 | 时，在「中文名 + |」处断行
// 前两条是确定的，第三条只在中文源名下生效，ASCII 源名粘一起仍然要回去改配置。
function normalizeAddr(text) {
  return String(text || '')
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\|\|/g, '\n');
}

function repairGlued(text) {
  const src = String(text || '');
  if (/\r|\n/.test(src)) return src;
  if ((src.match(/\|/g) || []).length < 2) return src;
  return src.replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+)\|/g, '\n$1|');
}

function parseSources(addrStr) {
  return repairGlued(normalizeAddr(addrStr)).split(/\r?\n/).map((item, idx) => {
    const trimmed = item.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith(';')) return null;

    let name = '';
    let rest = trimmed;
    const bar = trimmed.indexOf('|');
    if (bar > -1) {
      name = trimmed.slice(0, bar).trim();
      rest = trimmed.slice(bar + 1).trim();
    }
    if (!rest) return null;

    const urls = rest.split(/[,，\s]+/).map(u => u.trim()).filter(Boolean);
    if (!urls.length) return null;

    return { name: name || `订阅源_${idx + 1}`, urls };
  }).filter(Boolean);
}

async function tryFetch(targetUrl) {
  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    });
    if (res.ok) return { ok: true, status: res.status, text: await res.text(), error: '' };
    return { ok: false, status: res.status, text: '', error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: `请求失败或超时：${(err && err.message) || err}` };
  }
}

async function fetchPool(urls) {
  const tried = [];
  for (const u of urls) {
    const r = await tryFetch(u);
    tried.push({ url: u, status: r.status, error: r.error });
    if (r.ok) return { text: r.text, error: '', url: u, tried };
  }
  const detail = tried.map(t => `${t.url} → ${t.error || `HTTP ${t.status}`}`).join('；');
  return {
    text: '',
    error: `所有候选地址均失败：${detail}`,
    url: tried.length ? tried[tried.length - 1].url : '',
    tried
  };
}

function parsePool(allText) {
  const out = [];
  if (!allText) return out;

  const seen = new Set();
  let auto = 1;

  for (const line of allText.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('//')) continue;

    let addrPart = raw;
    let remark = '';

    const hash = raw.indexOf('#');
    if (hash > -1) {
      addrPart = raw.slice(0, hash).trim();
      remark = raw.slice(hash + 1).trim();
    } else {
      remark = `自动节点_${auto}`;
    }

    addrPart = addrPart
      .replace(/^(https?:\/\/)/i, '')
      .replace(/^\/\//, '')
      .replace(/\/+$/, '')
      .trim();

    // 池子里写成 ip:port 时，端口以池子为准
    let poolPort = '';
    const pm = addrPart.match(/^(.*):(\d{1,5})$/);
    if (pm) {
      addrPart = pm[1].trim();
      poolPort = pm[2];
    }
    // 剩下的冒号只可能是 IPv6，跳过
    if (!addrPart || addrPart.includes(':')) continue;

    const key = poolPort ? `${addrPart}:${poolPort}` : addrPart;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ addr: addrPart, port: poolPort, remark });
    auto++;
  }

  return out;
}

function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pickPort(addr, tplPort, poolPort) {
  if (poolPort) return String(poolPort);
  const p = String(tplPort || '');
  if (p === '443') return String(CF_TLS_PORTS[hashCode(addr) % CF_TLS_PORTS.length]);
  return p || '443';
}

// ==========================================
// 链接工具
// ==========================================

function schemeOf(uri) {
  const m = String(uri || '').trim().match(/^([a-z0-9+]+):\/\//i);
  return m ? m[1].toLowerCase() : '';
}

// scheme://[userinfo@]host[:port][/path][?query][#hash]
function splitUri(uri) {
  const raw = String(uri || '').trim();
  const sm = raw.match(/^([a-z0-9+]+):\/\//i);
  if (!sm) return null;

  let rest = raw.slice(sm[0].length);

  let hash = '';
  const hi = rest.indexOf('#');
  if (hi > -1) { hash = rest.slice(hi + 1); rest = rest.slice(0, hi); }

  let query = '';
  const qi = rest.indexOf('?');
  if (qi > -1) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }

  let user = '';
  const at = rest.lastIndexOf('@');
  if (at > -1) { user = rest.slice(0, at); rest = rest.slice(at + 1); }

  let path = '';
  const si = rest.indexOf('/');
  if (si > -1) { path = rest.slice(si); rest = rest.slice(0, si); }

  let host = rest;
  let port = '';
  const pm = rest.match(/^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
  if (pm) { host = pm[1]; port = pm[2] || ''; }
  host = host.replace(/^\[|\]$/g, '');

  return { scheme: sm[1].toLowerCase(), user, host, port, path, query, hash };
}

function fmtHost(h) {
  const s = String(h || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) return s;
  return s.includes(':') ? `[${s}]` : s;
}

function remarkOut(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/#/g, '%23').trim();
}

function joinUri(u, host, port, remark) {
  const user = u.user ? `${u.user}@` : '';
  const p = port ? `:${port}` : (u.port ? `:${u.port}` : '');
  const path = u.path || '';
  const query = u.query ? `?${u.query}` : '';
  const hash = remark ? `#${remarkOut(remark)}` : (u.hash ? `#${u.hash}` : '');
  return `${u.scheme}://${user}${fmtHost(host)}${p}${path}${query}${hash}`;
}

function b64Decode(s) {
  const n = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = n + '='.repeat((4 - (n.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function toBase64(text) {
  return b64Encode(text);
}

function vmessDecode(uri) {
  const m = String(uri || '').trim().match(/^vmess:\/\/(.+)$/i);
  if (!m) return null;
  let body = m[1].trim();
  const hi = body.indexOf('#');
  if (hi > -1) body = body.slice(0, hi).trim();
  try {
    const obj = JSON.parse(b64Decode(body));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    return null;
  }
}

// 模板信息：协议、原始主机、原始端口
const SUPPORTED = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'tuic', 'anytls'];

function templateInfo(uri) {
  const scheme = schemeOf(uri);
  if (!scheme || !SUPPORTED.includes(scheme)) return null;

  if (scheme === 'vmess') {
    const obj = vmessDecode(uri);
    if (!obj || !obj.add) return null;
    return { scheme, host: String(obj.add), port: String(obj.port || '') };
  }

  const u = splitUri(uri);
  if (!u || !u.host) return null;
  return { scheme, host: u.host, port: u.port || '' };
}

// 换地址换端口，其余参数原样保留
function buildNode(template, addr, port, remark) {
  const scheme = schemeOf(template);
  const target = String(addr || '').trim();
  if (!scheme || !target) return null;

  if (scheme === 'vmess') {
    const obj = vmessDecode(template);
    if (!obj) return null;
    obj.add = target.replace(/^\[|\]$/g, '');
    if (port) {
      const n = Number(port);
      obj.port = Number.isFinite(n) ? n : obj.port;
    }
    if (remark) obj.ps = remark;
    return `vmess://${b64Encode(JSON.stringify(obj))}`;
  }

  if (scheme === 'ss') {
    const u = splitUri(template);
    if (!u || !u.user) return null;
    const finalPort = port || u.port || '8388';
    const query = u.query ? `?${u.query}` : '';
    const hash = remarkOut(remark || u.hash);
    return `ss://${u.user}@${fmtHost(target)}:${finalPort}${u.path || ''}${query}${hash ? `#${hash}` : ''}`;
  }

  const u = splitUri(template);
  if (!u) return null;
  return joinUri(u, target, port || u.port, remark || u.hash);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function plain(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function subResponse(body, type = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ==========================================
// 页面
// ==========================================

function renderPage(sources) {
  const sourceList = sources.length
    ? sources.map((s, i) => `${i}. ${s.name}`).join('　')
    : 'ADDR 未配置';
  const addrWarn = sources.length
    ? ''
    : '<div class="warn">环境变量 ADDR 为空，批量优选不可用。编辑器不依赖 ADDR，可以正常用。</div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>节点编辑器 · 优选转换器</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 26px 16px 64px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f1f3f8; color: #1f2430; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: #7a8393; font-size: 12.5px; margin: 0 0 18px; }
  .tabs { display: flex; gap: 5px; background: #e5e9f2; padding: 4px; border-radius: 11px; margin-bottom: 15px; }
  .tab {
    flex: 1; padding: 9px 0; border: 0; border-radius: 8px; background: transparent;
    color: #5a6373; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: .15s;
    font-family: inherit;
  }
  .tab.on { background: #fff; color: #2f6bff; box-shadow: 0 1px 3px rgba(16,24,40,.1); }
  .card {
    background: #fff; border-radius: 14px; padding: 20px;
    box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
    margin-bottom: 14px;
  }
  label { display: block; font-size: 12.5px; font-weight: 600; color: #4a5464; margin-bottom: 6px; }
  label i { font-style: normal; font-weight: 500; color: #c3cad6; font-size: 11px; margin-left: 4px; }
  input, select, textarea {
    width: 100%; padding: 10px 12px; border: 1px solid #dfe3ea; border-radius: 9px;
    background: #fbfcfe; font-size: 13px; color: #26303f; font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.12);
  }
  textarea { resize: vertical; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
  .fld.w2 { grid-column: 1 / -1; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  .row2 { display: flex; gap: 9px; align-items: flex-end; flex-wrap: wrap; }
  .row2 .fld { flex: 1 1 130px; min-width: 0; }
  .row2 .fld.grow { flex: 3 1 240px; }
  .btn {
    padding: 10px 16px; border: 1px solid #dfe3ea; border-radius: 9px; background: #fff;
    color: #46505f; font-size: 13px; font-weight: 600; cursor: pointer;
    transition: .15s; white-space: nowrap; font-family: inherit;
  }
  .btn:hover:not(:disabled) { border-color: #2f6bff; color: #2f6bff; }
  .btn.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #1f57e0; border-color: #1f57e0; color: #fff; }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.done { border-color: #16a34a; color: #16a34a; background: #f2fdf6; }
  .hint { font-size: 12px; color: #98a1b0; margin-top: 9px; }
  .warn {
    background: #fff8eb; border: 1px solid #fae3b8; color: #8a5a00;
    padding: 10px 13px; border-radius: 10px; font-size: 12.5px; margin-bottom: 14px;
  }
  .out-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
  .meta { font-size: 12px; color: #98a1b0; text-align: right; }
  .meta.bad { color: #b42318; }
  #out { height: 96px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 11px 0 13px; }
  .chip {
    font-size: 11.5px; padding: 3px 9px; border-radius: 20px; background: #f2f5fa;
    color: #6b7686; font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .chip b { color: #2f6bff; font-weight: 600; }
  .share { display: flex; gap: 8px; margin-top: 12px; }
  .alert {
    display: none; margin-top: 13px; padding: 11px 13px; border-radius: 10px;
    background: #fef2f2; border: 1px solid #fbd5d5; color: #b42318; font-size: 12.5px;
    white-space: pre-wrap; word-break: break-all;
  }
  .result-head { display: flex; align-items: center; gap: 9px; margin-bottom: 13px; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #2f6bff; flex: 0 0 auto; }
  .result-name { font-size: 14.5px; font-weight: 600; margin-right: auto; overflow-wrap: anywhere; }
  .badge {
    font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 20px;
    background: #eef3ff; color: #2f6bff;
  }
  .badge.bad { background: #fef2f2; color: #b42318; }
  .link-row { display: flex; gap: 8px; align-items: stretch; }
  .link {
    flex: 1; min-width: 0; padding: 11px 13px; border-radius: 9px;
    background: #f7f9fc; border: 1px solid #e6eaf1;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px; color: #2c5cd6; overflow-wrap: anywhere; user-select: all;
  }
  .err-text { font-size: 12.5px; color: #b42318; background: #fef2f2; padding: 11px 13px; border-radius: 9px; overflow-wrap: anywhere; }
  details { margin-top: 11px; }
  summary { cursor: pointer; font-size: 12.5px; color: #7a8393; list-style: none; padding: 6px 0; user-select: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▸ "; }
  details[open] summary::before { content: "▾ "; }
  summary:hover { color: #2f6bff; }
  .nodes { margin-top: 6px; border: 1px solid #eef1f6; border-radius: 9px; overflow: hidden; }
  .node {
    padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px; color: #5a6373; border-bottom: 1px solid #f3f5f9; overflow-wrap: anywhere;
  }
  .node:last-child { border-bottom: 0; }
  .node b { color: #1f2430; font-weight: 600; }
  .foot { text-align: center; font-size: 12px; color: #a6aebb; margin-top: 22px; }
  @media (max-width: 560px) { .link-row { flex-direction: column; } .share { flex-direction: column; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>节点编辑器 · 优选转换器</h1>
  <p class="sub">改参数即时出链接　·　多源优选一键生成订阅　·　${sourceList}</p>

  <div class="tabs">
    <button class="tab on" data-tab="edit">节点编辑</button>
    <button class="tab" data-tab="pool">批量优选</button>
  </div>

  <!-- ================= 编辑器 ================= -->
  <section id="pane-edit">
    <div class="card">
      <div class="row2">
        <div class="fld">
          <label>协议</label>
          <select id="proto">
            <option value="vless">VLESS</option>
            <option value="vmess">VMess</option>
            <option value="trojan">Trojan</option>
            <option value="ss">Shadowsocks</option>
            <option value="hysteria2">Hysteria2</option>
          </select>
        </div>
        <div class="fld grow">
          <label>粘贴节点，自动识别协议并填表</label>
          <input id="paste" class="mono" spellcheck="false" placeholder="vless://… / vmess://… / trojan://… / ss://… / hysteria2://…">
        </div>
        <button class="btn" id="parse">解析</button>
      </div>
      <div class="hint" id="parseMsg">先选协议再填表；有现成节点就粘进来点解析，字段会自动对齐。</div>
    </div>

    <div class="card">
      <div class="grid" id="form"></div>
    </div>

    <div class="card">
      <div class="out-head">
        <label style="margin:0">实时链接</label>
        <span class="meta" id="meta"></span>
      </div>
      <textarea id="out" class="mono" readonly spellcheck="false"></textarea>
      <div class="chips" id="chips"></div>
      <div class="row2">
        <button class="btn primary" id="copyNode">复制节点链接</button>
        <button class="btn" id="makeShare">生成分享链接</button>
        <button class="btn" id="openShare" disabled>打开</button>
      </div>
      <div class="share" id="shareWrap" hidden>
        <input id="shareLink" class="mono" readonly spellcheck="false">
        <button class="btn" id="copyShare">复制</button>
      </div>
      <div class="hint">分享链接本身就是一份能直接导入客户端的订阅，节点参数编码在 URL 里，不依赖 ADDR。</div>
    </div>
  </section>

  <!-- ================= 批量优选 ================= -->
  <section id="pane-pool" hidden>
    ${addrWarn}
    <div class="card">
      <label for="tpl">模板节点（vless / vmess / trojan / ss / hysteria2 都行）</label>
      <textarea id="tpl" class="mono" spellcheck="false" placeholder="vless://uuid@dmit.kauroth.top:443?encryption=none&amp;security=tls&amp;sni=dmit.kauroth.top&amp;type=xhttp&amp;host=dmit.kauroth.top&amp;path=%2Fde-xhttp#DE"></textarea>
      <div class="hint">只替换地址和端口，uuid / host / sni / path 原样保留。端口为 443 时按地址哈希取一个 CF 可用端口，同一 IP 每次结果一致。</div>
      <button class="btn primary" id="go" style="width:100%;margin-top:14px">生成全部订阅</button>
      <div class="alert" id="alert"></div>
    </div>
    <div id="results"></div>
    <div class="foot" id="foot"></div>
  </section>
</div>

<script>
(function () {
  'use strict';

  // ---------------- 协议定义 ----------------
  var SCHEMA = {
    vless: {
      label: 'VLESS',
      fields: [
        { k: 'name', l: '备注', ph: '我的节点', w: 2 },
        { k: 'addr', l: '地址 / IP', ph: '104.17.151.9', req: 1 },
        { k: 'port', l: '端口', ph: '443', req: 1 },
        { k: 'uuid', l: 'UUID', ph: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', w: 2, req: 1 },
        { k: 'security', l: '传输安全', opts: ['tls', 'reality', 'none'] },
        { k: 'net', l: '传输方式', opts: ['tcp', 'ws', 'grpc', 'xhttp', 'httpupgrade', 'h2'] },
        { k: 'sni', l: 'SNI', ph: 'example.com' },
        { k: 'host', l: 'Host', ph: 'example.com' },
        { k: 'path', l: 'Path', ph: '/ws' },
        { k: 'fp', l: '指纹 fp', opts: ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'] },
        { k: 'alpn', l: 'ALPN', ph: 'h2,http/1.1' },
        { k: 'flow', l: 'Flow', opts: ['', 'xtls-rprx-vision'] },
        { k: 'serviceName', l: 'gRPC 服务名', ph: 'grpc' },
        { k: 'mode', l: 'mode', opts: ['', 'auto', 'packet-up', 'stream-up', 'stream-one', 'gun', 'multi'] },
        { k: 'pbk', l: 'Reality 公钥', ph: '' },
        { k: 'sid', l: 'Reality ShortId', ph: '' }
      ]
    },
    vmess: {
      label: 'VMess',
      fields: [
        { k: 'name', l: '备注', ph: '我的节点', w: 2 },
        { k: 'addr', l: '地址 / IP', ph: '104.17.151.9', req: 1 },
        { k: 'port', l: '端口', ph: '443', req: 1 },
        { k: 'uuid', l: 'UUID', ph: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', w: 2, req: 1 },
        { k: 'aid', l: 'alterId', ph: '0' },
        { k: 'net', l: '传输方式', opts: ['tcp', 'ws', 'grpc', 'h2', 'xhttp'] },
        { k: 'security', l: '传输安全', opts: ['tls', 'none'] },
        { k: 'sni', l: 'SNI', ph: 'example.com' },
        { k: 'host', l: 'Host', ph: 'example.com' },
        { k: 'path', l: 'Path', ph: '/ws' },
        { k: 'fp', l: '指纹 fp', opts: ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'] },
        { k: 'alpn', l: 'ALPN', ph: 'h2,http/1.1' }
      ]
    },
    trojan: {
      label: 'Trojan',
      fields: [
        { k: 'name', l: '备注', ph: '我的节点', w: 2 },
        { k: 'addr', l: '地址 / IP', ph: '104.17.151.9', req: 1 },
        { k: 'port', l: '端口', ph: '443', req: 1 },
        { k: 'password', l: '密码', ph: '', w: 2, req: 1 },
        { k: 'security', l: '传输安全', opts: ['tls', 'reality', 'none'] },
        { k: 'net', l: '传输方式', opts: ['tcp', 'ws', 'grpc', 'xhttp'] },
        { k: 'sni', l: 'SNI', ph: 'example.com' },
        { k: 'host', l: 'Host', ph: 'example.com' },
        { k: 'path', l: 'Path', ph: '/ws' },
        { k: 'fp', l: '指纹 fp', opts: ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'] },
        { k: 'alpn', l: 'ALPN', ph: 'h2,http/1.1' },
        { k: 'serviceName', l: 'gRPC 服务名', ph: 'grpc' },
        { k: 'allowInsecure', l: '允许不安全证书', opts: ['', '1'] }
      ]
    },
    ss: {
      label: 'Shadowsocks',
      fields: [
        { k: 'name', l: '备注', ph: '我的节点', w: 2 },
        { k: 'addr', l: '地址 / IP', ph: '104.17.151.9', req: 1 },
        { k: 'port', l: '端口', ph: '8388', req: 1 },
        { k: 'method', l: '加密方式', opts: ['aes-256-gcm', 'aes-128-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-chacha20-poly1305', 'none'] },
        { k: 'password', l: '密码', ph: '', req: 1 },
        { k: 'plugin', l: '插件（可选）', ph: 'v2ray-plugin;mode=websocket;host=example.com', w: 2 }
      ]
    },
    hysteria2: {
      label: 'Hysteria2',
      fields: [
        { k: 'name', l: '备注', ph: '我的节点', w: 2 },
        { k: 'addr', l: '地址 / IP', ph: '104.17.151.9', req: 1 },
        { k: 'port', l: '端口', ph: '443', req: 1 },
        { k: 'password', l: '认证密码', ph: '', w: 2, req: 1 },
        { k: 'sni', l: 'SNI', ph: 'example.com' },
        { k: 'insecure', l: '跳过证书校验', opts: ['', '1'] },
        { k: 'obfs', l: '混淆', opts: ['', 'salamander'] },
        { k: 'obfs-password', l: '混淆密码', ph: '' },
        { k: 'alpn', l: 'ALPN', ph: 'h3' }
      ]
    }
  };

  var DEFAULTS = {
    vless: { security: 'tls', net: 'tcp' },
    vmess: { security: 'tls', net: 'tcp', aid: '0' },
    trojan: { security: 'tls', net: 'tcp' },
    ss: { method: 'aes-256-gcm' },
    hysteria2: { alpn: 'h3' }
  };

  var $ = function (id) { return document.getElementById(id); };
  var protoSel = $('proto');
  var formEl = $('form');
  var outEl = $('out');
  var metaEl = $('meta');
  var chipsEl = $('chips');
  var shareWrap = $('shareWrap');
  var shareLink = $('shareLink');
  var openShare = $('openShare');
  var state = {};
  var shareOn = false;   // 生成过一次分享后，链接跟着参数自动更新

  // ---------------- 工具 ----------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tr(s) { return String(s == null ? '' : s).trim(); }
  function dec(s) { try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); } }

  function b64url(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function b64std(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64toText(s) {
    var n = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    var pad = n + '==='.slice(0, (4 - (n.length % 4)) % 4);
    var bin = atob(pad), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function schemeOf(u) {
    var m = String(u || '').trim().match(/^([a-z0-9+]+):\\/\\//i);
    return m ? m[1].toLowerCase() : '';
  }
  function fmtHost(h) {
    var s = tr(h);
    if (!s) return '';
    if (s.charAt(0) === '[') return s;
    return s.indexOf(':') > -1 ? '[' + s + ']' : s;
  }
  function hashOf(name) {
    var n = tr(name).replace(/[\\r\\n]+/g, ' ').replace(/#/g, '%23');
    return n ? '#' + n : '';
  }
  function qs(pairs) {
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var k = pairs[i][0], v = pairs[i][1];
      if (v === undefined || v === null || v === '') continue;
      out.push(k + '=' + encodeURIComponent(v));
    }
    return out.length ? '?' + out.join('&') : '';
  }
  function splitUri(uri) {
    var raw = tr(uri);
    var sm = raw.match(/^([a-z0-9+]+):\\/\\//i);
    if (!sm) return null;
    var rest = raw.slice(sm[0].length);
    var hash = '', query = '', user = '', path = '';
    var hi = rest.indexOf('#');
    if (hi > -1) { hash = rest.slice(hi + 1); rest = rest.slice(0, hi); }
    var qi = rest.indexOf('?');
    if (qi > -1) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
    var at = rest.lastIndexOf('@');
    if (at > -1) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
    var si = rest.indexOf('/');
    if (si > -1) { path = rest.slice(si); rest = rest.slice(0, si); }
    var host = rest, port = '';
    var pm = rest.match(/^(\\[[^\\]]+\\]|[^:]+)(?::(\\d{1,5}))?$/);
    if (pm) { host = pm[1]; port = pm[2] || ''; }
    host = host.replace(/^\\[|\\]$/g, '');
    return { scheme: sm[1].toLowerCase(), user: user, host: host, port: port, path: path, query: query, hash: hash };
  }
  function readParams(query) {
    var out = {};
    if (!query) return out;
    var parts = String(query).split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var kv = parts[i].split('=');
      var k = dec(kv[0]);
      var v = dec(kv.slice(1).join('='));
      if (k) out[k] = v;
    }
    return out;
  }
  function hostPort(s) {
    return fmtHost(tr(s.addr)) + ':' + tr(s.port);
  }

  // ---------------- 构建 ----------------
  function buildVless(s) {
    var q = qs([
      ['encryption', 'none'],
      ['security', s.security],
      ['sni', tr(s.sni)],
      ['fp', s.fp],
      ['alpn', tr(s.alpn)],
      ['pbk', tr(s.pbk)],
      ['sid', tr(s.sid)],
      ['type', s.net],
      ['host', tr(s.host)],
      ['path', tr(s.path)],
      ['serviceName', tr(s.serviceName)],
      ['flow', s.flow],
      ['mode', s.mode]
    ]);
    return 'vless://' + tr(s.uuid) + '@' + hostPort(s) + q + hashOf(s.name);
  }

  function buildVmess(s) {
    var o = {
      v: '2',
      ps: tr(s.name),
      add: tr(s.addr),
      port: Number(tr(s.port)) || 443,
      id: tr(s.uuid),
      aid: Number(tr(s.aid)) || 0,
      scy: 'auto',
      net: s.net || 'tcp',
      type: 'none',
      host: tr(s.host),
      path: tr(s.path) || '/',
      tls: s.security === 'tls' ? 'tls' : ''
    };
    // 可选字段为空就不写进去，链接短一点，也少让客户端误解
    if (tr(s.sni)) o.sni = tr(s.sni);
    if (tr(s.alpn)) o.alpn = tr(s.alpn);
    if (s.fp) o.fp = s.fp;
    return 'vmess://' + b64std(JSON.stringify(o));
  }

  function buildTrojan(s) {
    var q = qs([
      ['security', s.security],
      ['sni', tr(s.sni)],
      ['fp', s.fp],
      ['alpn', tr(s.alpn)],
      ['type', s.net],
      ['host', tr(s.host)],
      ['path', tr(s.path)],
      ['serviceName', tr(s.serviceName)],
      ['allowInsecure', s.allowInsecure]
    ]);
    return 'trojan://' + encodeURIComponent(tr(s.password)) + '@' + hostPort(s) + q + hashOf(s.name);
  }

  function buildSs(s) {
    var auth = b64url(tr(s.method) + ':' + tr(s.password));
    var plugin = tr(s.plugin);
    return 'ss://' + auth + '@' + hostPort(s) + (plugin ? '?plugin=' + encodeURIComponent(plugin) : '') + hashOf(s.name);
  }

  function buildHysteria2(s) {
    var q = qs([
      ['sni', tr(s.sni)],
      ['insecure', s.insecure],
      ['obfs', s.obfs],
      ['obfs-password', tr(s['obfs-password'])],
      ['alpn', tr(s.alpn)]
    ]);
    return 'hysteria2://' + encodeURIComponent(tr(s.password)) + '@' + hostPort(s) + '/' + q + hashOf(s.name);
  }

  var BUILDERS = {
    vless: buildVless,
    vmess: buildVmess,
    trojan: buildTrojan,
    ss: buildSs,
    hysteria2: buildHysteria2
  };

  // ---------------- 解析 ----------------
  function parseVmess(uri) {
    var m = tr(uri).match(/^vmess:\\/\\/(.+)$/i);
    if (!m) return null;
    var body = m[1];
    var hi = body.indexOf('#');
    if (hi > -1) body = body.slice(0, hi);
    var o;
    try { o = JSON.parse(b64toText(tr(body))); } catch (e) { return null; }
    if (!o || !o.add) return null;
    return {
      name: o.ps || '',
      addr: String(o.add || ''),
      port: String(o.port || ''),
      uuid: String(o.id || ''),
      aid: String(o.aid == null ? 0 : o.aid),
      net: o.net || 'tcp',
      security: o.tls === 'tls' ? 'tls' : 'none',
      sni: o.sni || '',
      host: o.host || '',
      path: o.path || '',
      fp: o.fp || '',
      alpn: o.alpn || ''
    };
  }

  function parseSs(uri) {
    var u = splitUri(uri);
    if (!u || !u.user) return null;
    var auth;
    try { auth = b64toText(u.user); } catch (e) { auth = dec(u.user); }
    var i = auth.indexOf(':');
    var method = i > -1 ? auth.slice(0, i) : '';
    var password = i > -1 ? auth.slice(i + 1) : auth;
    var p = readParams(u.query);
    return {
      name: dec(u.hash),
      addr: u.host,
      port: u.port,
      method: method,
      password: password,
      plugin: p.plugin || ''
    };
  }

  function parseGeneric(uri, proto) {
    var u = splitUri(uri);
    if (!u || !u.host) return null;
    var p = readParams(u.query);
    var out = { name: dec(u.hash), addr: u.host, port: u.port };

    if (proto === 'vless') {
      out.uuid = u.user;
      out.security = p.security || '';
      out.net = p.type || 'tcp';
      out.sni = p.sni || '';
      out.host = p.host || '';
      out.path = p.path || '';
      out.fp = p.fp || '';
      out.alpn = p.alpn || '';
      out.flow = p.flow || '';
      out.serviceName = p.serviceName || '';
      out.mode = p.mode || '';
      out.pbk = p.pbk || '';
      out.sid = p.sid || '';
    } else if (proto === 'trojan') {
      out.password = dec(u.user);
      out.security = p.security || '';
      out.net = p.type || 'tcp';
      out.sni = p.sni || '';
      out.host = p.host || '';
      out.path = p.path || '';
      out.fp = p.fp || '';
      out.alpn = p.alpn || '';
      out.serviceName = p.serviceName || '';
      out.allowInsecure = p.allowInsecure || '';
    } else if (proto === 'hysteria2') {
      out.password = dec(u.user);
      out.sni = p.sni || '';
      out.insecure = p.insecure || '';
      out.obfs = p.obfs || '';
      out['obfs-password'] = p['obfs-password'] || '';
      out.alpn = p.alpn || '';
    }
    return out;
  }

  function parseAny(uri) {
    var s = schemeOf(uri);
    if (!s || !SCHEMA[s]) return null;
    var data = null;
    if (s === 'vmess') data = parseVmess(uri);
    else if (s === 'ss') data = parseSs(uri);
    else data = parseGeneric(uri, s);
    if (!data) return null;
    return { proto: s, data: data };
  }

  // ---------------- 表单 ----------------
  function renderForm() {
    var proto = protoSel.value;
    var p = SCHEMA[proto];
    var def = DEFAULTS[proto] || {};
    var html = '';

    for (var i = 0; i < p.fields.length; i++) {
      var f = p.fields[i];
      var v = state[f.k];
      if (v === undefined || v === null) v = def[f.k] !== undefined ? def[f.k] : (f.opts ? f.opts[0] : '');

      html += '<div class="fld' + (f.w === 2 ? ' w2' : '') + '">';
      html += '<label>' + esc(f.l) + (f.req ? '<i>必填</i>' : '') + '</label>';

      if (f.opts) {
        html += '<select data-k="' + esc(f.k) + '">';
        for (var j = 0; j < f.opts.length; j++) {
          var o = f.opts[j];
          html += '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + (o === '' ? '不填' : esc(o)) + '</option>';
        }
        html += '</select>';
      } else {
        html += '<input data-k="' + esc(f.k) + '" value="' + esc(v) + '" placeholder="' + esc(f.ph || '') + '" spellcheck="false" autocomplete="off">';
      }
      html += '</div>';
    }

    formEl.innerHTML = html;

    var els = formEl.querySelectorAll('[data-k]');
    for (var n = 0; n < els.length; n++) {
      (function (el) {
        var k = el.getAttribute('data-k');
        var handler = function () { state[k] = el.value; update(); };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
      })(els[n]);
    }
  }

  function fillState(data) {
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      if (data[keys[i]] !== undefined && data[keys[i]] !== null) state[keys[i]] = String(data[keys[i]]);
    }
  }

  // ---------------- 实时预览 ----------------
  function update() {
    var proto = protoSel.value;
    var p = SCHEMA[proto];
    var missing = [];
    for (var i = 0; i < p.fields.length; i++) {
      var f = p.fields[i];
      if (f.req && !tr(state[f.k])) missing.push(f.l);
    }

    var uri = '';
    try { uri = BUILDERS[proto](state) || ''; } catch (e) { uri = ''; }
    outEl.value = uri;

    var meta = uri.length + ' 字符';
    if (missing.length) meta += ' · 还差 ' + missing.join('、');
    metaEl.textContent = meta;
    metaEl.className = 'meta' + (missing.length ? ' bad' : '');

    renderChips(proto, missing);

    // 分享链接生成过一次就跟着参数走，不用每次重新点
    if (shareOn && uri) {
      shareLink.value = location.origin + location.pathname + '?share=' + b64url(uri);
    } else if (!uri) {
      shareWrap.hidden = true;
      openShare.disabled = true;
    }
  }

  function renderChips(proto, missing) {
    var p = SCHEMA[proto];
    var chips = [['协议', p.label], ['地址', tr(state.addr) || '—'], ['端口', tr(state.port) || '—']];

    if (proto === 'vless' || proto === 'vmess' || proto === 'trojan') {
      if (state.net) chips.push(['传输', state.net]);
      if (state.security) chips.push(['安全', state.security]);
      if (tr(state.host)) chips.push(['Host', tr(state.host)]);
    }
    if (proto === 'ss' && state.method) chips.push(['加密', state.method]);
    if (proto === 'hysteria2' && state.obfs) chips.push(['混淆', state.obfs]);
    if (tr(state.name)) chips.push(['备注', tr(state.name)]);

    var html = '';
    for (var i = 0; i < chips.length; i++) {
      html += '<span class="chip">' + esc(chips[i][0]) + ' <b>' + esc(chips[i][1]) + '</b></span>';
    }
    if (missing.length) html += '<span class="chip" style="background:#fef2f2;color:#b42318">缺少 ' + esc(missing.join('、')) + '</span>';
    chipsEl.innerHTML = html;
  }

  // ---------------- 复制 ----------------
  function copyText(text, btn, label) {
    var ok = function () {
      var old = btn.textContent;
      btn.textContent = label || '已复制';
      btn.classList.add('done');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('done'); }, 1500);
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { alert('复制失败，请手动选中'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    } else {
      fallback();
    }
  }

  // ---------------- 事件 ----------------
  protoSel.addEventListener('change', function () {
    var keep = { addr: state.addr, port: state.port, name: state.name };
    state = keep;
    renderForm();
    update();
    $('parseMsg').textContent = '已切到 ' + SCHEMA[protoSel.value].label + '，地址和端口保留，其余字段用默认值。';
  });

  $('parse').addEventListener('click', function () {
    var msg = $('parseMsg');
    var raw = tr($('paste').value);
    if (!raw) { msg.textContent = '先粘一个节点链接。'; $('paste').focus(); return; }

    var got = parseAny(raw);
    if (!got) {
      msg.textContent = '识别不出来。支持的协议：' + Object.keys(SCHEMA).join(' / ') + '。检查是不是被截断了。';
      return;
    }

    protoSel.value = got.proto;
    state = {};
    fillState(got.data);
    renderForm();
    update();
    msg.textContent = '已识别为 ' + SCHEMA[got.proto].label + '，字段已填好，直接改就行。';
  });

  $('copyNode').addEventListener('click', function () {
    var v = tr(outEl.value);
    if (!v) { $('parseMsg').textContent = '链接还是空的，先把必填项补齐。'; return; }
    copyText(v, $('copyNode'), '已复制节点');
  });

  $('makeShare').addEventListener('click', function () {
    var v = tr(outEl.value);
    if (!v) { $('parseMsg').textContent = '链接还是空的，先把必填项补齐。'; return; }
    shareOn = true;
    shareLink.value = location.origin + location.pathname + '?share=' + b64url(v);
    shareWrap.hidden = false;
    openShare.disabled = false;
    shareLink.select();
  });

  $('copyShare').addEventListener('click', function () {
    copyText(shareLink.value, $('copyShare'), '已复制');
  });

  openShare.addEventListener('click', function () {
    if (shareLink.value) window.open(shareLink.value, '_blank');
  });

  // ---------------- 标签切换 ----------------
  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('on');
        btn.classList.add('on');
        var name = btn.getAttribute('data-tab');
        $('pane-edit').hidden = name !== 'edit';
        $('pane-pool').hidden = name !== 'pool';
      });
    })(tabs[t]);
  }

  // ---------------- 批量优选 ----------------
  var goBtn = $('go');
  if (goBtn) {
    goBtn.addEventListener('click', function () {
      var alertBox = $('alert');
      var results = $('results');
      var foot = $('foot');
      var value = tr($('tpl').value);

      alertBox.style.display = 'none';
      if (!value) { alertBox.textContent = '先把模板节点粘进来。'; alertBox.style.display = 'block'; return; }
      if (!schemeOf(value)) { alertBox.textContent = '模板必须以 vless:// vmess:// trojan:// ss:// hysteria2:// 开头。'; alertBox.style.display = 'block'; return; }

      goBtn.disabled = true;
      goBtn.textContent = '正在拉取各个源…';
      results.innerHTML = '';
      foot.textContent = '';

      fetch('?all=true&template=' + encodeURIComponent(value))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) { alertBox.textContent = data.error; alertBox.style.display = 'block'; return; }

          var colors = ['#2f6bff', '#16a34a', '#f59e0b', '#8b5cf6', '#ef4444', '#0891b2'];
          var total = 0;
          for (var i = 0; i < data.results.length; i++) {
            results.appendChild(renderCard(data.results[i], colors[i % colors.length]));
            total += data.results[i].count || 0;
          }
          foot.textContent = (data.protocol ? data.protocol.toUpperCase() + ' ' : '') + '模板原地址 ' + data.originalAddr + '　·　共 ' + total + ' 个节点';
        })
        .catch(function (err) {
          alertBox.textContent = '请求失败：' + err.message;
          alertBox.style.display = 'block';
        })
        .then(function () {
          goBtn.disabled = false;
          goBtn.textContent = '生成全部订阅';
        });
    });
  }

  function renderCard(r, color) {
    var card = document.createElement('div');
    card.className = 'card';

    var head = '<div class="result-head">' +
      '<span class="dot" style="background:' + color + '"></span>' +
      '<span class="result-name">' + esc(r.name) + '</span>' +
      (r.error
        ? '<span class="badge bad">失败</span>'
        : '<span class="badge">' + r.count + ' 个节点</span>') +
      '</div>';

    if (r.error) {
      card.innerHTML = head + '<div class="err-text">' + esc(r.error) + '</div>';
      return card;
    }

    card.innerHTML = head;

    var row = document.createElement('div');
    row.className = 'link-row';

    var link = document.createElement('div');
    link.className = 'link';
    link.textContent = r.subscribeLink;

    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '复制订阅';
    btn.onclick = function () { copyText(r.subscribeLink, btn, '已复制'); };

    row.appendChild(link);
    row.appendChild(btn);
    card.appendChild(row);

    if (r.preview && r.preview.length) {
      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = '预览节点（' + r.preview.length + ' / ' + r.count + '）';
      det.appendChild(sum);

      var box = document.createElement('div');
      box.className = 'nodes';
      for (var i = 0; i < r.preview.length; i++) {
        var n = r.preview[i];
        var d = document.createElement('div');
        d.className = 'node';
        d.innerHTML = '<b>' + esc(n.addr) + ':' + esc(n.port) + '</b>　' + esc(n.remark);
        box.appendChild(d);
      }
      det.appendChild(box);
      card.appendChild(det);
    }

    return card;
  }

  // ---------------- 启动 ----------------
  renderForm();
  update();
})();
</script>
</body>
</html>`;
}
