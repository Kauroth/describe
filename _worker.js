// _worker.js
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // API：解析链接获取地址
    if (url.pathname === '/api/resolve' && request.method === 'POST') {
      return handleResolve(request);
    }

    // API：转换 VLESS 节点
    if (url.pathname === '/api/convert' && request.method === 'POST') {
      return handleConvert(request);
    }

    // 默认返回前端页面
    return new Response(renderHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// 从用户提供的链接中提取 IP/域名
async function handleResolve(request) {
  try {
    const { link } = await request.json();
    if (!link) {
      return jsonResponse({ error: '请提供链接' }, 400);
    }

    const resp = await fetch(link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(10000)
    });

    const text = await resp.text();

    // 优先匹配 IPv4
    const ipv4Regex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
    const ipv4Matches = [...text.matchAll(ipv4Regex)]
      .map(m => m[1])
      .filter(ip => {
        const parts = ip.split('.').map(Number);
        return parts.every(p => p >= 0 && p <= 255) &&
          !(parts[0] === 0) &&
          !(parts[0] === 127) &&
          !(parts[0] === 10) &&
          !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) &&
          !(parts[0] === 192 && parts[1] === 168);
      });

    if (ipv4Matches.length > 0) {
      return jsonResponse({ addresses: [...new Set(ipv4Matches)], source: 'IPv4' });
    }

    // 尝试匹配 IPv6（简化匹配）
    const ipv6Regex = /\b([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7})\b/g;
    const ipv6Matches = [...text.matchAll(ipv6Regex)].map(m => m[1]);
    if (ipv6Matches.length > 0) {
      return jsonResponse({ addresses: [...new Set(ipv6Matches)], source: 'IPv6' });
    }

    // 尝试匹配域名（排除常见无关节点）
    const domainRegex = /\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.([a-zA-Z]{2,}))\b/g;
    const excludeDomains = ['google.com', 'cloudflare.com', 'mozilla.org', 'github.com',
      'w3.org', 'jquery.com', 'example.com', 'apache.org', 'nginx.org',
      'schema.org', 'json.org', 'xml.org', 'python.org', 'microsoft.com',
      'apple.com', 'amazon.com', 'facebook.com', 'twitter.com', 'youtube.com'];
    const domainMatches = [...text.matchAll(domainRegex)]
      .map(m => m[1].toLowerCase())
      .filter(d => !excludeDomains.some(ex => d === ex || d.endsWith('.' + ex)));

    if (domainMatches.length > 0) {
      return jsonResponse({ addresses: [...new Set(domainMatches)], source: '域名' });
    }

    // 如果都没匹配到，返回原始文本的前500字符供用户参考
    return jsonResponse({ error: '未能从链接中提取到有效地址', preview: text.slice(0, 500) }, 400);

  } catch (err) {
    return jsonResponse({ error: '请求失败: ' + err.message }, 500);
  }
}

// 替换 VLESS 节点地址并转 base64
async function handleConvert(request) {
  try {
    const { vless, newAddress } = await request.json();
    if (!vless || !newAddress) {
      return jsonResponse({ error: '请提供 VLESS 节点和目标地址' }, 400);
    }

    const result = replaceVlessAddress(vless, newAddress);
    if (!result) {
      return jsonResponse({ error: 'VLESS 节点格式无效' }, 400);
    }

    // 转 base64
    const base64 = btoa(result);

    return jsonResponse({
      vless: result,
      base64: base64
    });
  } catch (err) {
    return jsonResponse({ error: '转换失败: ' + err.message }, 500);
  }
}

// 解析并替换 VLESS 链接中的地址
function replaceVlessAddress(vlessLink, newAddr) {
  try {
    // vless://uuid@address:port?params#name
    const urlObj = new URL(vlessLink);

    if (urlObj.protocol !== 'vless:') {
      return null;
    }

    const uuid = urlObj.username;
    const originalHost = urlObj.hostname;
    const port = urlObj.port;
    const params = urlObj.search;
    const hash = urlObj.hash;

    if (!uuid || !originalHost || !port) {
      return null;
    }

    // 如果新地址是 IPv6，需要加方括号
    let addressPart = newAddr;
    if (newAddr.includes(':') && !newAddr.startsWith('[')) {
      addressPart = '[' + newAddr + ']';
    }

    // 重新组装
    let result = `vless://${uuid}@${addressPart}:${port}${params}`;
    if (hash) {
      result += hash;
    }

    return result;
  } catch (e) {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VLESS 地址转换器</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@300;400;600;800&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
  :root {
    --bg: #0a0e17;
    --bg2: #111827;
    --card: #161e2e;
    --card-hover: #1c2740;
    --border: #253049;
    --fg: #e8ecf4;
    --fg-muted: #7a8baa;
    --accent: #00e68a;
    --accent-dim: rgba(0,230,138,0.12);
    --accent-glow: rgba(0,230,138,0.3);
    --danger: #ff5c6a;
    --danger-dim: rgba(255,92,106,0.12);
    --radius: 12px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Noto Sans SC', sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* 背景动态效果 */
  .bg-grid {
    position: fixed;
    inset: 0;
    z-index: 0;
    background-image:
      linear-gradient(rgba(0,230,138,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,230,138,0.03) 1px, transparent 1px);
    background-size: 60px 60px;
    animation: gridMove 20s linear infinite;
  }

  @keyframes gridMove {
    0% { transform: translate(0, 0); }
    100% { transform: translate(60px, 60px); }
  }

  .bg-blob {
    position: fixed;
    border-radius: 50%;
    filter: blur(120px);
    z-index: 0;
    pointer-events: none;
  }
  .bg-blob-1 {
    width: 500px; height: 500px;
    background: rgba(0,230,138,0.07);
    top: -150px; right: -100px;
    animation: blobFloat 12s ease-in-out infinite alternate;
  }
  .bg-blob-2 {
    width: 400px; height: 400px;
    background: rgba(0,180,220,0.05);
    bottom: -100px; left: -80px;
    animation: blobFloat 15s ease-in-out infinite alternate-reverse;
  }

  @keyframes blobFloat {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(40px, -30px) scale(1.15); }
  }

  /* 主容器 */
  .container {
    position: relative;
    z-index: 1;
    max-width: 780px;
    margin: 0 auto;
    padding: 40px 20px 60px;
  }

  /* 头部 */
  header {
    text-align: center;
    margin-bottom: 48px;
  }

  .logo-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 64px; height: 64px;
    border-radius: 18px;
    background: linear-gradient(135deg, var(--accent-dim), rgba(0,180,220,0.1));
    border: 1px solid var(--border);
    margin-bottom: 20px;
    font-size: 28px;
    color: var(--accent);
    animation: logoPulse 3s ease-in-out infinite;
  }

  @keyframes logoPulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
    50% { box-shadow: 0 0 30px 4px var(--accent-glow); }
  }

  header h1 {
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--fg), var(--accent));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
  }

  header p {
    color: var(--fg-muted);
    font-size: 15px;
    font-weight: 300;
  }

  /* 卡片 */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 28px;
    margin-bottom: 20px;
    transition: border-color 0.3s, box-shadow 0.3s;
  }
  .card:hover {
    border-color: rgba(0,230,138,0.2);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
  }

  .card-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--fg);
  }

  .card-title i {
    color: var(--accent);
    font-size: 18px;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-dim);
    border-radius: 8px;
  }

  .step-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 6px;
    background: var(--accent);
    color: var(--bg);
    font-size: 12px;
    font-weight: 800;
    margin-left: auto;
  }

  /* 输入区域 */
  textarea, input[type="text"] {
    width: 100%;
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--fg);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    padding: 14px 16px;
    resize: vertical;
    transition: border-color 0.25s, box-shadow 0.25s;
    outline: none;
  }
  textarea:focus, input[type="text"]:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  textarea::placeholder, input::placeholder {
    color: var(--fg-muted);
    opacity: 0.6;
  }
  textarea { min-height: 100px; }
  input[type="text"] { height: 48px; }

  /* 按钮 */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-radius: 10px;
    font-family: 'Noto Sans SC', sans-serif;
    font-size: 14px;
    font-weight: 600;
    border: none;
    cursor: pointer;
    transition: all 0.25s;
    outline: none;
  }
  .btn:active { transform: scale(0.97); }

  .btn-primary {
    background: var(--accent);
    color: var(--bg);
    box-shadow: 0 2px 16px var(--accent-glow);
  }
  .btn-primary:hover {
    box-shadow: 0 4px 28px var(--accent-glow);
    filter: brightness(1.1);
  }
  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    filter: none;
    box-shadow: none;
  }

  .btn-secondary {
    background: var(--bg2);
    color: var(--fg);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover {
    background: var(--card-hover);
    border-color: var(--accent);
  }

  .btn-row {
    display: flex;
    gap: 10px;
    margin-top: 16px;
    flex-wrap: wrap;
  }

  /* 解析结果 */
  .resolve-results {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }

  .addr-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--accent-dim);
    border: 1px solid rgba(0,230,138,0.2);
    border-radius: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--accent);
    cursor: pointer;
    transition: all 0.2s;
    user-select: none;
  }
  .addr-chip:hover {
    background: rgba(0,230,138,0.2);
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .addr-chip.selected {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
    font-weight: 600;
  }

  /* 手动输入地址 */
  .manual-input {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .manual-input input {
    flex: 1;
    font-size: 13px;
    height: 42px;
    padding: 0 14px;
  }
  .manual-input .btn {
    padding: 0 18px;
    height: 42px;
    font-size: 13px;
    white-space: nowrap;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
    color: var(--fg-muted);
    font-size: 12px;
  }
  .divider::before, .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* 输出区域 */
  .output-box {
    position: relative;
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    margin-top: 14px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--fg-muted);
    word-break: break-all;
    min-height: 60px;
    max-height: 200px;
    overflow-y: auto;
    transition: border-color 0.3s;
  }
  .output-box.has-content {
    color: var(--fg);
    border-color: rgba(0,230,138,0.25);
  }

  .output-label {
    font-size: 12px;
    color: var(--fg-muted);
    margin-top: 16px;
    margin-bottom: 6px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Toast 消息 */
  .toast-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    animation: toastIn 0.35s ease-out;
    max-width: 380px;
  }
  .toast.success {
    background: rgba(0,230,138,0.15);
    border: 1px solid rgba(0,230,138,0.3);
    color: var(--accent);
  }
  .toast.error {
    background: var(--danger-dim);
    border: 1px solid rgba(255,92,106,0.3);
    color: var(--danger);
  }
  .toast.removing {
    animation: toastOut 0.3s ease-in forwards;
  }

  @keyframes toastIn {
    from { opacity: 0; transform: translateX(40px); }
    to { opacity: 1; transform: translateX(0); }
  }
  @keyframes toastOut {
    from { opacity: 1; transform: translateX(0); }
    to { opacity: 0; transform: translateX(40px); }
  }

  /* 加载动画 */
  .spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid var(--bg);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* 信息提示条 */
  .info-bar {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 14px 16px;
    background: rgba(0,180,220,0.08);
    border: 1px solid rgba(0,180,220,0.15);
    border-radius: 10px;
    margin-bottom: 20px;
    font-size: 13px;
    color: var(--fg-muted);
    line-height: 1.6;
  }
  .info-bar i {
    color: #00b4dc;
    font-size: 16px;
    margin-top: 2px;
    flex-shrink: 0;
  }

  /* 底部 */
  footer {
    text-align: center;
    margin-top: 48px;
    color: var(--fg-muted);
    font-size: 12px;
    opacity: 0.5;
  }

  /* 自定义滚动条 */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--fg-muted); }

  /* 响应式 */
  @media (max-width: 600px) {
    .container { padding: 24px 14px 40px; }
    header h1 { font-size: 24px; }
    .card { padding: 20px; }
    .btn-row { flex-direction: column; }
    .btn-row .btn { justify-content: center; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
</head>
<body>

<div class="bg-grid"></div>
<div class="bg-blob bg-blob-1"></div>
<div class="bg-blob bg-blob-2"></div>
<div class="toast-container" id="toastContainer"></div>

<div class="container">
  <header>
    <div class="logo-icon"><i class="fas fa-shuffle"></i></div>
    <h1>VLESS 地址转换器</h1>
    <p>通过链接解析目标地址，替换 VLESS 节点中的 IP/域名，生成 Base64</p>
  </header>

  <div class="info-bar">
    <i class="fas fa-circle-info"></i>
    <span>支持从任意链接中自动提取 IPv4 / IPv6 / 域名地址。常见用法：填入优选 IP 测速页面的链接、Cloudflare Trace 链接等，自动解析出可用地址。</span>
  </div>

  <!-- 步骤1：输入 VLESS 节点 -->
  <div class="card">
    <div class="card-title">
      <i class="fas fa-link"></i>
      <span>输入 VLESS 节点</span>
      <span class="step-badge">1</span>
    </div>
    <textarea id="vlessInput" placeholder="vless://uuid@address:port?type=tcp&security=reality#节点名称" spellcheck="false"></textarea>
  </div>

  <!-- 步骤2：解析链接 -->
  <div class="card">
    <div class="card-title">
      <i class="fas fa-globe"></i>
      <span>解析目标地址</span>
      <span class="step-badge">2</span>
    </div>
    <input type="text" id="linkInput" placeholder="输入用于解析地址的链接，如 https://speed.cloudflare.com/cdn-cgi/trace" spellcheck="false">

    <div class="btn-row">
      <button class="btn btn-primary" id="resolveBtn" onclick="resolveLink()">
        <i class="fas fa-magnifying-glass"></i>
        解析链接
      </button>
    </div>

    <div class="resolve-results" id="resolveResults"></div>

    <div class="divider">或手动输入</div>
    <div class="manual-input">
      <input type="text" id="manualAddr" placeholder="直接输入 IP 或域名">
      <button class="btn btn-secondary" onclick="selectManual()">
        <i class="fas fa-check"></i>
        选用
      </button>
    </div>
  </div>

  <!-- 步骤3：转换输出 -->
  <div class="card">
    <div class="card-title">
      <i class="fas fa-arrow-right-arrow-left"></i>
      <span>转换结果</span>
      <span class="step-badge">3</span>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" id="convertBtn" onclick="convertVless()" disabled>
        <i class="fas fa-bolt"></i>
        执行转换
      </button>
    </div>

    <div class="output-label">VLESS 节点</div>
    <div class="output-box" id="outputVless">转换后的 VLESS 节点将显示在这里</div>

    <div class="output-label">Base64 编码</div>
    <div class="output-box" id="outputBase64">Base64 结果将显示在这里</div>

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="copyText('outputVless')">
        <i class="fas fa-copy"></i>
        复制节点
      </button>
      <button class="btn btn-secondary" onclick="copyText('outputBase64')">
        <i class="fas fa-copy"></i>
        复制 Base64
      </button>
    </div>
  </div>

  <footer>VLESS Address Converter &middot; 所有解析均在服务端完成</footer>
</div>

<script>
  // 状态
  let selectedAddress = '';

  // Toast 提示
  function showToast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    const icon = type === 'success' ? 'fa-circle-check' : 'fa-circle-xmark';
    toast.innerHTML = '<i class="fas ' + icon + '"></i><span>' + msg + '</span>';
    container.appendChild(toast);
    setTimeout(function() {
      toast.classList.add('removing');
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  }

  // 解析链接
  async function resolveLink() {
    const link = document.getElementById('linkInput').value.trim();
    if (!link) {
      showToast('请输入链接', 'error');
      return;
    }

    const btn = document.getElementById('resolveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 解析中...';

    try {
      const resp = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: link })
      });
      const data = await resp.json();

      if (data.error) {
        showToast(data.error, 'error');
        if (data.preview) {
          document.getElementById('resolveResults').innerHTML =
            '<div style="font-size:12px;color:var(--fg-muted);word-break:break-all;opacity:0.6;margin-top:4px;">响应预览: ' + escapeHtml(data.preview) + '</div>';
        }
        return;
      }

      if (data.addresses && data.addresses.length > 0) {
        renderAddrChips(data.addresses);
        showToast('从链接中提取到 ' + data.addresses.length + ' 个' + data.source + '地址');
      } else {
        showToast('未找到有效地址', 'error');
      }
    } catch (err) {
      showToast('请求失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magnifying-glass"></i> 解析链接';
    }
  }

  // 渲染地址选项
  function renderAddrChips(addresses) {
    const container = document.getElementById('resolveResults');
    container.innerHTML = '';
    addresses.forEach(function(addr) {
      var chip = document.createElement('div');
      chip.className = 'addr-chip';
      chip.textContent = addr;
      chip.onclick = function() {
        selectAddress(addr, chip);
      };
      container.appendChild(chip);
    });
  }

  // 选中地址
  function selectAddress(addr, chipEl) {
    // 取消之前选中
    document.querySelectorAll('.addr-chip').forEach(function(c) {
      c.classList.remove('selected');
    });
    chipEl.classList.add('selected');
    selectedAddress = addr;
    document.getElementById('manualAddr').value = '';
    updateConvertBtn();
  }

  // 手动输入选用
  function selectManual() {
    var addr = document.getElementById('manualAddr').value.trim();
    if (!addr) {
      showToast('请输入地址', 'error');
      return;
    }
    document.querySelectorAll('.addr-chip').forEach(function(c) {
      c.classList.remove('selected');
    });
    selectedAddress = addr;
    showToast('已选用地址: ' + addr);
    updateConvertBtn();
  }

  // 更新转换按钮状态
  function updateConvertBtn() {
    var vless = document.getElementById('vlessInput').value.trim();
    document.getElementById('convertBtn').disabled = !(vless && selectedAddress);
  }

  // 监听输入变化
  document.getElementById('vlessInput').addEventListener('input', updateConvertBtn);

  // 转换
  async function convertVless() {
    var vless = document.getElementById('vlessInput').value.trim();
    if (!vless || !selectedAddress) return;

    var btn = document.getElementById('convertBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 转换中...';

    try {
      var resp = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vless: vless, newAddress: selectedAddress })
      });
      var data = await resp.json();

      if (data.error) {
        showToast(data.error, 'error');
        return;
      }

      var vlessBox = document.getElementById('outputVless');
      var base64Box = document.getElementById('outputBase64');
      vlessBox.textContent = data.vless;
      base64Box.textContent = data.base64;
      vlessBox.classList.add('has-content');
      base64Box.classList.add('has-content');
      showToast('转换成功');
    } catch (err) {
      showToast('转换失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-bolt"></i> 执行转换';
      updateConvertBtn();
    }
  }

  // 复制文本
  function copyText(id) {
    var text = document.getElementById(id).textContent;
    if (!text || text.indexOf('将显示在这里') !== -1) {
      showToast('暂无内容可复制', 'error');
      return;
    }
    navigator.clipboard.writeText(text).then(function() {
      showToast('已复制到剪贴板');
    }).catch(function() {
      // 降级方案
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('已复制到剪贴板');
    });
  }

  // HTML 转义
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // 回车触发解析
  document.getElementById('linkInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') resolveLink();
  });
  document.getElementById('manualAddr').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') selectManual();
  });
</script>
</body>
</html>`;
}
