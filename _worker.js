// _worker.js
// VLESS 多源优选转换器
// 用法：粘贴一个 VLESS 模板，同时产出 ADDR 里所有源的订阅链接

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CF_TLS_PORTS = [2053, 2083, 2087, 2096, 8443, 443];
const FETCH_TIMEOUT = 15000;
const FETCH_RETRY = 2;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.ADDR) {
      return plain('错误：请先在 Cloudflare 后台配置环境变量 ADDR。', 500);
    }

    const sources = parseSources(env.ADDR);
    if (sources.length === 0) {
      return plain('错误：环境变量 ADDR 格式不正确，未能解析出任何有效的网址。', 500);
    }

    const template = url.searchParams.get('template');
    const isSubscribeMode = url.searchParams.get('format') === 'base64';
    const isJsonRequest = url.searchParams.get('api') === 'true';
    const isAllMode = url.searchParams.get('all') === 'true' || url.searchParams.get('api') === 'all';
    const rawIndex = parseInt(url.searchParams.get('source') || '0', 10);
    const activeIndex = (rawIndex >= 0 && rawIndex < sources.length) ? rawIndex : 0;

    // ---------- 模式 A：一次产出所有源（前端用） ----------
    if (template && isAllMode) {
      const tpl = parseTemplate(template);
      if (!tpl) {
        return json({ error: '节点模板格式错误，无法解析主机和端口。' }, 400);
      }

      const results = await Promise.all(sources.map(async (src, idx) => {
        const link = `${url.origin}${url.pathname}?source=${idx}&template=${encodeURIComponent(template)}&format=base64`;
        const pool = await fetchPool(src.url);
        const poolData = parsePool(pool.text);

        if (poolData.length === 0) {
          return {
            index: idx,
            name: src.name,
            count: 0,
            error: pool.error || '拉到了内容，但没解析出任何有效地址',
            subscribeLink: link
          };
        }

        const nodes = buildNodes(poolData, tpl);
        return {
          index: idx,
          name: src.name,
          count: nodes.length,
          preview: nodes.slice(0, 50),
          subscribeLink: link
        };
      }));

      return json({
        success: true,
        originalAddr: `${tpl.host}:${tpl.port}`,
        results
      }, 200);
    }

    // ---------- 模式 B：单个源 ----------
    if (template) {
      const currentTarget = sources[activeIndex];

      const pool = await fetchPool(currentTarget.url);
      const extractedData = parsePool(pool.text);

      if (extractedData.length === 0) {
        const errorMsg = pool.error || '未能从订阅源拉取到数据，或无法解析出任何有效的 IPv4/域名。';
        if (isJsonRequest) {
          return json({ error: errorMsg, rawText: pool.text || '[无内容]' }, 200);
        }
        return plain(`错误诊断：${errorMsg}`, 400);
      }

      const tpl = parseTemplate(template);
      if (!tpl) {
        if (isJsonRequest) return json({ error: '节点模板格式错误，无法解析端口。' }, 400);
        return plain('错误：节点模板格式错误。', 400);
      }

      const nodesInfo = buildNodes(extractedData, tpl);

      if (isSubscribeMode) {
        const plainText = nodesInfo.map(n => n.rawUrl).join('\n');
        return new Response(toBase64(plainText), {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      if (isJsonRequest) {
        return json({
          success: true,
          originalAddr: tpl.host,
          sourceName: currentTarget.name,
          nodes: nodesInfo,
          subscribeLink: `${url.origin}${url.pathname}?source=${activeIndex}&template=${encodeURIComponent(template)}&format=base64`
        }, 200);
      }
    }

    // ---------- 模式 C：前端页面 ----------
    const sourceList = sources.map((s, i) => `${i + 1}. ${s.name}`).join('　');
    return new Response(renderPage(sourceList), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
};

// ==========================================
// 数据层
// ==========================================

function parseSources(addrStr) {
  return addrStr.split(/\r?\n/).map((item, idx) => {
    const trimmed = item.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return null;

    if (trimmed.includes('|')) {
      const parts = trimmed.split('|');
      const name = parts[0].trim() || `订阅源_${idx + 1}`;
      const urlPart = parts.slice(1).join('|').trim();
      if (!urlPart) return null;
      return { name, url: urlPart };
    }

    return { name: `订阅源_${idx + 1}`, url: trimmed };
  }).filter(Boolean);
}

async function fetchPool(targetUrl) {
  let text = '';
  let error = '';

  for (let attempt = 1; attempt <= FETCH_RETRY; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        cf: { cacheTtl: 0, cacheEverything: false },
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      });

      if (response.ok) {
        text = await response.text();
        error = '';
        break;
      }
      error = `HTTP 状态码异常: ${response.status}`;
    } catch (err) {
      error = `网络请求失败或超时（第 ${attempt} 次）: ${err.message || err}`;
    }
  }

  return { text, error };
}

function parsePool(allText) {
  const out = [];
  if (!allText) return out;

  const seen = new Set();
  let autoIndex = 1;

  for (const line of allText.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('# ')) continue;

    let possibleAddr = '';
    let remark = '';

    if (trimmedLine.includes('#')) {
      const hashIndex = trimmedLine.indexOf('#');
      possibleAddr = trimmedLine.substring(0, hashIndex).trim();
      remark = trimmedLine.substring(hashIndex + 1).trim();
    } else {
      possibleAddr = trimmedLine;
      remark = `自动节点_${autoIndex}`;
    }

    possibleAddr = possibleAddr.replace(/^(https?:\/\/)/i, '').replace(/^\/\//, '').replace(/\/+$/, '').trim();

    // 池子行如果写成 ip:port#备注，端口就听池子的
    let poolPort = '';
    const portMatch = possibleAddr.match(/^(.*):(\d{1,5})$/);
    if (portMatch) {
      possibleAddr = portMatch[1].trim();
      poolPort = portMatch[2];
    }
    // 剩下的冒号只可能是 IPv6，沿用原逻辑跳过
    if (possibleAddr.includes(':')) continue;
    if (possibleAddr.length === 0) continue;

    const key = poolPort ? `${possibleAddr}:${poolPort}` : possibleAddr;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ addr: possibleAddr, port: poolPort, remark });
    autoIndex++;
  }

  return out;
}

function parseTemplate(template) {
  const regex = /^(vless:\/\/[^@]+@)([^:]+)(:\d+)([^#]*)(#.*)?$/i;
  const match = String(template || '').trim().match(regex);
  if (!match) return null;

  return {
    prefix: match[1],
    host: match[2].replace(/^\[|\]$/g, ''),
    portStr: match[3],
    port: match[3].substring(1),
    params: match[4] || ''
  };
}

function buildNodes(poolData, tpl) {
  return poolData.map(data => {
    let finalPortStr = tpl.portStr;
    if (data.port) {
      finalPortStr = `:${data.port}`;
    } else if (tpl.portStr === ':443') {
      const randomPort = CF_TLS_PORTS[Math.floor(Math.random() * CF_TLS_PORTS.length)];
      finalPortStr = `:${randomPort}`;
    }

    return {
      rawUrl: `${tpl.prefix}${data.addr}${finalPortStr}${tpl.params}#${data.remark}`,
      addr: data.addr,
      port: finalPortStr.substring(1),
      remark: data.remark
    };
  });
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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

// ==========================================
// 页面
// ==========================================

function renderPage(sourceList) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VLESS 优选转换器</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 16px 60px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f2f4f7; color: #1f2430; line-height: 1.6;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .3px; }
  .sub { color: #7a8393; font-size: 13px; margin: 0 0 22px; }
  .card {
    background: #fff; border-radius: 14px; padding: 22px;
    box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
    margin-bottom: 16px;
  }
  label { display: block; font-size: 13px; font-weight: 600; color: #4a5464; margin-bottom: 8px; }
  textarea {
    width: 100%; height: 108px; resize: vertical; padding: 13px 14px;
    border: 1px solid #dfe3ea; border-radius: 10px; background: #fbfcfe;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px; color: #26303f; transition: border-color .15s, box-shadow .15s;
  }
  textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.12); }
  .hint { font-size: 12px; color: #98a1b0; margin-top: 8px; }
  button.primary {
    width: 100%; margin-top: 16px; padding: 14px; border: 0; border-radius: 10px;
    background: #2f6bff; color: #fff; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: background .15s, transform .05s;
  }
  button.primary:hover:not(:disabled) { background: #1f57e0; }
  button.primary:active:not(:disabled) { transform: translateY(1px); }
  button.primary:disabled { background: #a9bde8; cursor: default; }
  .alert {
    display: none; margin-top: 14px; padding: 12px 14px; border-radius: 10px;
    background: #fef2f2; border: 1px solid #fbd5d5; color: #b42318; font-size: 13px;
    white-space: pre-wrap; word-break: break-all;
  }
  #results { display: none; }
  .result-head {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #2f6bff; flex: 0 0 auto; }
  .result-name { font-size: 15px; font-weight: 600; margin-right: auto; }
  .badge {
    font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 20px;
    background: #eef3ff; color: #2f6bff;
  }
  .badge.bad { background: #fef2f2; color: #b42318; }
  .link-row { display: flex; gap: 8px; align-items: stretch; }
  .link {
    flex: 1; min-width: 0; padding: 11px 13px; border-radius: 9px;
    background: #f7f9fc; border: 1px solid #e6eaf1;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; color: #2c5cd6; overflow-wrap: anywhere; user-select: all;
  }
  button.copy {
    flex: 0 0 auto; padding: 0 16px; border: 1px solid #dfe3ea; border-radius: 9px;
    background: #fff; color: #46505f; font-size: 13px; font-weight: 600; cursor: pointer;
    transition: all .15s;
  }
  button.copy:hover { border-color: #2f6bff; color: #2f6bff; }
  button.copy.done { border-color: #16a34a; color: #16a34a; background: #f2fdf6; }
  .err-text { font-size: 13px; color: #b42318; background: #fef2f2; padding: 11px 13px; border-radius: 9px; }
  details { margin-top: 12px; }
  summary {
    cursor: pointer; font-size: 13px; color: #7a8393; list-style: none;
    padding: 6px 0; user-select: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▸ "; }
  details[open] summary::before { content: "▾ "; }
  summary:hover { color: #2f6bff; }
  .nodes { margin-top: 6px; border: 1px solid #eef1f6; border-radius: 9px; overflow: hidden; }
  .node {
    padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px; color: #5a6373; border-bottom: 1px solid #f3f5f9;
    overflow-wrap: anywhere;
  }
  .node:last-child { border-bottom: 0; }
  .node b { color: #1f2430; font-weight: 600; }
  .foot { text-align: center; font-size: 12px; color: #a6aebb; margin-top: 24px; }
  @media (max-width: 560px) {
    .link-row { flex-direction: column; }
    button.copy { padding: 11px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>VLESS 优选转换器</h1>
  <p class="sub">粘贴一个模板节点，下面所有订阅源会一起生成　·　${sourceList}</p>

  <div class="card">
    <label for="tpl">模板节点（vless:// 开头，含真实域名和端口）</label>
    <textarea id="tpl" spellcheck="false" placeholder="vless://uuid@dmit.kauroth.top:443?security=tls&amp;type=xhttp&amp;path=%2Fdmit_xhttp&amp;host=dmit.kauroth.top&amp;sni=dmit.kauroth.top#备注"></textarea>
    <div class="hint">只替换 IP 和端口。host、sni、path、uuid 全部保留模板里的值。</div>
    <button class="primary" id="go">生成全部订阅</button>
    <div class="alert" id="alert"></div>
  </div>

  <div id="results"></div>
  <div class="foot" id="foot"></div>
</div>

<script>
(function () {
  var btn = document.getElementById('go');
  var tpl = document.getElementById('tpl');
  var alertBox = document.getElementById('alert');
  var results = document.getElementById('results');
  var foot = document.getElementById('foot');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showError(msg) {
    alertBox.textContent = msg;
    alertBox.style.display = 'block';
  }

  function copyText(text, el) {
    var done = function () {
      var old = el.textContent;
      el.textContent = '已复制';
      el.classList.add('done');
      setTimeout(function () { el.textContent = old; el.classList.remove('done'); }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { alert('复制失败，请手动选中'); }
      document.body.removeChild(ta);
    }
  }

  function renderCard(r, order) {
    var card = document.createElement('div');
    card.className = 'card';

    var head = '<div class="result-head">' +
      '<span class="dot" style="background:' + order + '"></span>' +
      '<span class="result-name">' + esc(r.name) + '</span>' +
      (r.error
        ? '<span class="badge bad">失败</span>'
        : '<span class="badge">' + r.count + ' 个节点</span>') +
      '</div>';

    if (r.error) {
      card.innerHTML = head + '<div class="err-text">' + esc(r.error) + '</div>';
      return card;
    }

    var row = document.createElement('div');
    row.className = 'link-row';
    var link = document.createElement('div');
    link.className = 'link';
    link.textContent = r.subscribeLink;
    var btnCopy = document.createElement('button');
    btnCopy.className = 'copy';
    btnCopy.textContent = '复制订阅';
    btnCopy.onclick = function () { copyText(r.subscribeLink, btnCopy); };
    row.appendChild(link);
    row.appendChild(btnCopy);

    card.innerHTML = head;
    card.appendChild(row);

    if (r.preview && r.preview.length) {
      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = '预览节点（' + Math.min(r.preview.length, r.count) + ' / ' + r.count + '）';
      det.appendChild(sum);

      var box = document.createElement('div');
      box.className = 'nodes';
      r.preview.forEach(function (n) {
        var d = document.createElement('div');
        d.className = 'node';
        d.innerHTML = '<b>' + esc(n.addr) + ':' + esc(n.port) + '</b>　' + esc(n.remark);
        box.appendChild(d);
      });
      det.appendChild(box);
      card.appendChild(det);
    }

    return card;
  }

  btn.addEventListener('click', function () {
    var value = tpl.value.trim();
    alertBox.style.display = 'none';

    if (!value) { showError('先把模板节点粘进来。'); tpl.focus(); return; }
    if (value.indexOf('vless://') !== 0) { showError('模板必须以 vless:// 开头。'); return; }

    btn.disabled = true;
    btn.textContent = '正在拉取各个源…';
    results.style.display = 'none';
    results.innerHTML = '';
    foot.textContent = '';

    fetch('?all=true&template=' + encodeURIComponent(value))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) { showError(data.error); return; }

        var colors = ['#2f6bff', '#16a34a', '#f59e0b', '#8b5cf6', '#ef4444', '#0891b2'];
        data.results.forEach(function (r, i) {
          results.appendChild(renderCard(r, colors[i % colors.length]));
        });
        results.style.display = 'block';

        var total = data.results.reduce(function (s, r) { return s + (r.count || 0); }, 0);
        foot.textContent = '模板原地址 ' + data.originalAddr + '　·　共 ' + total + ' 个节点';
      })
      .catch(function (err) {
        showError('请求失败：' + err.message);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '生成全部订阅';
      });
  });
})();
</script>
</body>
</html>`;
}
