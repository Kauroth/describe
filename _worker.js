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

    return new Response(renderHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

async function handleResolve(request) {
  try {
    const { link } = await request.json();
    if (!link) return jsonResponse({ error: '请提供链接' }, 400);

    const resp = await fetch(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await resp.text();

    // IPv4（排除内网和特殊地址）
    const ipv4Re = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
    const ipv4 = [...text.matchAll(ipv4Re)].map(m => m[1]).filter(ip => {
      const p = ip.split('.').map(Number);
      return p.every(v => v >= 0 && v <= 255) &&
        p[0] !== 0 && p[0] !== 127 &&
        !(p[0] === 10) &&
        !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
        !(p[0] === 192 && p[1] === 168);
    });
    if (ipv4.length > 0) return jsonResponse({ addresses: [...new Set(ipv4)], source: 'IPv4' });

    // IPv6
    const ipv6Re = /\b([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7})\b/g;
    const ipv6 = [...text.matchAll(ipv6Re)].map(m => m[1]);
    if (ipv6.length > 0) return jsonResponse({ addresses: [...new Set(ipv6)], source: 'IPv6' });

    // 域名
    const skip = ['google.com', 'cloudflare.com', 'mozilla.org', 'github.com', 'w3.org',
      'jquery.com', 'example.com', 'apache.org', 'nginx.org', 'schema.org', 'json.org',
      'python.org', 'microsoft.com', 'apple.com', 'amazon.com', 'facebook.com', 'twitter.com',
      'youtube.com', 'googleapis.com', 'gstatic.com', 'google-analytics.com', 'doubleclick.net'];
    const domRe = /\b([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.([a-zA-Z]{2,}))\b/g;
    const doms = [...text.matchAll(domRe)].map(m => m[1].toLowerCase())
      .filter(d => !skip.some(s => d === s || d.endsWith('.' + s)));
    if (doms.length > 0) return jsonResponse({ addresses: [...new Set(doms)], source: '域名' });

    return jsonResponse({ error: '未能提取到有效地址', preview: text.slice(0, 500) }, 400);
  } catch (err) {
    return jsonResponse({ error: '请求失败: ' + err.message }, 500);
  }
}

async function handleConvert(request) {
  try {
    const { input, newAddress } = await request.json();
    if (!input || !newAddress) return jsonResponse({ error: '缺少参数' }, 400);

    // 解析输入：尝试 base64 解码，逐行提取 vless://
    let lines;
    try {
      const decoded = atob(input.trim());
      lines = decoded.split(/[\n\r]+/);
    } catch {
      lines = input.split(/[\n\r]+/);
    }

    const vlessList = lines
      .map(l => l.trim())
      .filter(l => l.startsWith('vless://'));

    if (vlessList.length === 0) {
      return jsonResponse({ error: '未找到有效的 VLESS 节点（需以 vless:// 开头）' }, 400);
    }

    const converted = [];
    const failed = [];

    vlessList.forEach((raw, idx) => {
      try {
        const result = replaceVlessAddress(raw, newAddress);
        if (result) {
          converted.push(result);
        } else {
          failed.push({ line: idx + 1, reason: '格式无效' });
        }
      } catch (e) {
        failed.push({ line: idx + 1, reason: e.message });
      }
    });

    const base64 = btoa(converted.join('\n'));

    return jsonResponse({
      total: vlessList.length,
      success: converted.length,
      failed: failed.length,
      failedDetails: failed,
      vless: converted.join('\n'),
      base64: base64
    });
  } catch (err) {
    return jsonResponse({ error: '转换失败: ' + err.message }, 500);
  }
}

function replaceVlessAddress(vlessLink, newAddr) {
  const urlObj = new URL(vlessLink);
  if (urlObj.protocol !== 'vless:') return null;
  if (!urlObj.username || !urlObj.hostname || !urlObj.port) return null;

  let addrPart = newAddr;
  if (newAddr.includes(':') && !newAddr.startsWith('[')) {
    addrPart = '[' + newAddr + ']';
  }

  let result = 'vless://' + urlObj.username + '@' + addrPart + ':' + urlObj.port + urlObj.search;
  if (urlObj.hash) result += urlObj.hash;
  return result;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VLESS 批量转换器</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@300;400;600;800&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
:root{
  --bg:#090d14;--bg2:#0f1520;--card:#141c2b;--card2:#182236;
  --border:#1f2d45;--fg:#e4e9f2;--muted:#5f7599;
  --accent:#00e68a;--accent2:#00c9ff;
  --accent-dim:rgba(0,230,138,.1);--accent-glow:rgba(0,230,138,.25);
  --red:#ff5263;--red-dim:rgba(255,82,99,.1);
  --amber:#ffb347;--amber-dim:rgba(255,179,71,.1);
  --r:12px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans SC',sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;overflow-x:hidden}

/* 背景 */
.bg-mesh{position:fixed;inset:0;z-index:0;
  background:
    radial-gradient(ellipse 600px 400px at 15% 10%,rgba(0,230,138,.06),transparent),
    radial-gradient(ellipse 500px 500px at 85% 80%,rgba(0,201,255,.05),transparent),
    radial-gradient(ellipse 400px 300px at 50% 50%,rgba(0,230,138,.02),transparent);
}
.bg-dots{position:fixed;inset:0;z-index:0;
  background-image:radial-gradient(rgba(0,230,138,.08) 1px,transparent 1px);
  background-size:32px 32px;
}
.scan-line{position:fixed;left:0;right:0;height:2px;z-index:0;
  background:linear-gradient(90deg,transparent,var(--accent-glow),transparent);
  animation:scanDown 6s linear infinite;opacity:.4;pointer-events:none}
@keyframes scanDown{0%{top:-2px}100%{top:100vh}}

.wrap{position:relative;z-index:1;max-width:860px;margin:0 auto;padding:36px 20px 64px}

/* 头部 */
header{text-align:center;margin-bottom:44px}
.logo{display:inline-flex;align-items:center;justify-content:center;
  width:60px;height:60px;border-radius:16px;
  background:linear-gradient(135deg,var(--accent-dim),rgba(0,201,255,.08));
  border:1px solid var(--border);margin-bottom:18px;
  font-size:24px;color:var(--accent);
  animation:glow 3s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 var(--accent-glow)}50%{box-shadow:0 0 28px 4px var(--accent-glow)}}
header h1{font-size:30px;font-weight:800;letter-spacing:-.5px;
  background:linear-gradient(135deg,var(--fg) 40%,var(--accent));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
header p{color:var(--muted);font-size:14px;font-weight:300;margin-top:6px}

/* 卡片 */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);
  padding:26px;margin-bottom:18px;transition:border-color .3s,box-shadow .3s}
.card:hover{border-color:rgba(0,230,138,.15);box-shadow:0 4px 30px rgba(0,0,0,.35)}
.card-head{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.card-head .icon{color:var(--accent);font-size:16px;width:30px;height:30px;
  display:flex;align-items:center;justify-content:center;
  background:var(--accent-dim);border-radius:8px;flex-shrink:0}
.card-head span{font-size:15px;font-weight:600}
.badge{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;
  min-width:22px;height:22px;padding:0 6px;border-radius:6px;
  font-size:11px;font-weight:800;font-family:'JetBrains Mono',monospace}
.badge-step{background:var(--accent);color:var(--bg)}
.badge-count{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(0,230,138,.2)}
.badge-fail{background:var(--red-dim);color:var(--red);border:1px solid rgba(255,82,99,.2)}

/* 输入 */
textarea,input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--border);
  border-radius:10px;color:var(--fg);font-family:'JetBrains Mono',monospace;
  font-size:13px;padding:13px 15px;resize:vertical;outline:none;
  transition:border-color .25s,box-shadow .25s}
textarea:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
textarea::placeholder,input::placeholder{color:var(--muted);opacity:.5}
textarea{min-height:120px;line-height:1.7}
input[type=text]{height:46px}

/* 按钮 */
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:10px;
  font-family:'Noto Sans SC',sans-serif;font-size:13px;font-weight:600;
  border:none;cursor:pointer;transition:all .2s;outline:none;white-space:nowrap}
.btn:active{transform:scale(.97)}
.btn-p{background:var(--accent);color:var(--bg);box-shadow:0 2px 14px var(--accent-glow)}
.btn-p:hover{box-shadow:0 4px 24px var(--accent-glow);filter:brightness(1.1)}
.btn-p:disabled{opacity:.35;cursor:not-allowed;filter:none;box-shadow:none}
.btn-s{background:var(--bg2);color:var(--fg);border:1px solid var(--border)}
.btn-s:hover{border-color:var(--accent);background:var(--card2)}
.btn-row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}

/* 地址选择 */
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
  background:var(--accent-dim);border:1px solid rgba(0,230,138,.18);border-radius:8px;
  font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--accent);
  cursor:pointer;transition:all .2s;user-select:none}
.chip:hover{background:rgba(0,230,138,.18);border-color:var(--accent);transform:translateY(-1px)}
.chip.on{background:var(--accent);color:var(--bg);border-color:var(--accent);font-weight:600}
.divider{display:flex;align-items:center;gap:12px;margin-top:14px;color:var(--muted);font-size:12px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.manual{display:flex;gap:8px;margin-top:10px}
.manual input{flex:1;font-size:13px;height:42px;padding:0 14px}
.manual .btn{padding:0 16px;height:42px;font-size:13px}

/* 统计条 */
.stats{display:flex;gap:12px;margin-top:16px;flex-wrap:wrap}
.stat{display:flex;align-items:center;gap:8px;padding:10px 16px;
  border-radius:10px;font-size:13px;font-weight:600}
.stat-ok{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(0,230,138,.15)}
.stat-err{background:var(--red-dim);color:var(--red);border:1px solid rgba(255,82,99,.15)}
.stat-all{background:var(--amber-dim);color:var(--amber);border:1px solid rgba(255,179,71,.15)}

/* 输出 */
.out-label{font-size:11px;color:var(--muted);margin-top:18px;margin-bottom:6px;
  font-weight:700;text-transform:uppercase;letter-spacing:.6px}
.out-box{position:relative;background:var(--bg2);border:1px solid var(--border);
  border-radius:10px;padding:13px 15px;
  font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);
  word-break:break-all;min-height:56px;max-height:260px;overflow-y:auto;
  line-height:1.7;transition:border-color .3s}
.out-box.filled{color:var(--fg);border-color:rgba(0,230,138,.2)}

/* 失败详情 */
.fail-list{margin-top:12px;max-height:120px;overflow-y:auto}
.fail-item{display:flex;gap:8px;padding:6px 10px;font-size:12px;
  font-family:'JetBrains Mono',monospace;color:var(--red);border-radius:6px;
  background:var(--red-dim);margin-bottom:4px}

/* Toast */
.toast-wrap{position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px}
.toast{display:flex;align-items:center;gap:10px;padding:13px 18px;border-radius:10px;
  font-size:13px;font-weight:500;box-shadow:0 8px 32px rgba(0,0,0,.45);
  animation:tIn .3s ease-out;max-width:360px}
.toast.ok{background:rgba(0,230,138,.12);border:1px solid rgba(0,230,138,.25);color:var(--accent)}
.toast.err{background:var(--red-dim);border:1px solid rgba(255,82,99,.25);color:var(--red)}
.toast.out{animation:tOut .25s ease-in forwards}
@keyframes tIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}
@keyframes tOut{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(40px)}}

.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--bg);
  border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

footer{text-align:center;margin-top:48px;color:var(--muted);font-size:11px;opacity:.4}

::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}

@media(max-width:600px){
  .wrap{padding:20px 12px 40px}
  header h1{font-size:22px}
  .card{padding:18px}
  .btn-row{flex-direction:column}
  .btn-row .btn{justify-content:center}
  .stats{flex-direction:column}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<div class="bg-mesh"></div>
<div class="bg-dots"></div>
<div class="scan-line"></div>
<div class="toast-wrap" id="toasts"></div>

<div class="wrap">
  <header>
    <div class="logo"><i class="fas fa-layer-group"></i></div>
    <h1>VLESS 批量转换器</h1>
    <p>粘贴 Base64 订阅或多条 VLESS 链接，批量替换地址并输出</p>
  </header>

  <!-- 步骤1 -->
  <section class="card">
    <div class="card-head">
      <div class="icon"><i class="fas fa-list"></i></div>
      <span>输入 VLESS 节点</span>
      <span class="badge badge-count" id="nodeCount">0</span>
      <span class="badge badge-step">1</span>
    </div>
    <textarea id="vlessInput" placeholder="支持以下格式：&#10;&#10;1. 直接粘贴 Base64 订阅内容&#10;2. 每行一个 vless:// 链接&#10;3. 混合粘贴（自动识别 vless:// 开头的行）" spellcheck="false"></textarea>
  </section>

  <!-- 步骤2 -->
  <section class="card">
    <div class="card-head">
      <div class="icon"><i class="fas fa-crosshairs"></i></div>
      <span>选择目标地址</span>
      <span class="badge badge-step">2</span>
    </div>
    <input type="text" id="linkInput" placeholder="输入解析链接，如 https://speed.cloudflare.com/cdn-cgi/trace" spellcheck="false">
    <div class="btn-row">
      <button class="btn btn-p" id="resolveBtn" onclick="doResolve()">
        <i class="fas fa-magnifying-glass"></i>解析链接
      </button>
    </div>
    <div class="chips" id="chips"></div>
    <div class="divider">或手动输入地址</div>
    <div class="manual">
      <input type="text" id="manualAddr" placeholder="输入 IP 或域名">
      <button class="btn btn-s" onclick="useManual()"><i class="fas fa-check"></i>选用</button>
    </div>
  </section>

  <!-- 步骤3 -->
  <section class="card">
    <div class="card-head">
      <div class="icon"><i class="fas fa-bolt"></i></div>
      <span>批量转换</span>
      <span class="badge badge-step">3</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-p" id="convertBtn" onclick="doConvert()" disabled>
        <i class="fas fa-arrows-rotate"></i>执行批量转换
      </button>
    </div>

    <div class="stats" id="statsBar" style="display:none"></div>
    <div class="fail-list" id="failList"></div>

    <div class="out-label">VLESS 节点（逐行）</div>
    <div class="out-box" id="outVless">转换结果将显示在这里</div>

    <div class="out-label">Base64 编码</div>
    <div class="out-box" id="outB64">Base64 结果将显示在这里</div>

    <div class="btn-row">
      <button class="btn btn-s" onclick="copyEl('outVless')"><i class="fas fa-copy"></i>复制节点</button>
      <button class="btn btn-s" onclick="copyEl('outB64')"><i class="fas fa-copy"></i>复制 Base64</button>
    </div>
  </section>

  <footer>VLESS Batch Converter &middot; 服务端解析，本地零依赖</footer>
</div>

<script>
var selectedAddr='';

/* ---------- Toast ---------- */
function toast(msg,type){
  var c=document.getElementById('toasts'),t=document.createElement('div');
  t.className='toast '+(type||'ok');
  var ic=type==='err'?'fa-circle-xmark':'fa-circle-check';
  t.innerHTML='<i class="fas '+ic+'"></i><span>'+msg+'</span>';
  c.appendChild(t);
  setTimeout(function(){t.classList.add('out');setTimeout(function(){t.remove()},250)},3200);
}

/* ---------- 实时计数 ---------- */
document.getElementById('vlessInput').addEventListener('input',function(){
  var v=this.value.trim();
  var n=0;
  if(v){
    // 尝试base64解码
    try{
      var d=atob(v);
      n=d.split(/[\\n\\r]+/).filter(function(l){return l.trim().startsWith('vless://')}).length;
    }catch(e){
      n=v.split(/[\\n\\r]+/).filter(function(l){return l.trim().startsWith('vless://')}).length;
    }
  }
  document.getElementById('nodeCount').textContent=n;
  checkReady();
});

function checkReady(){
  var hasAddr=!!selectedAddr;
  var raw=document.getElementById('vlessInput').value.trim();
  var hasNodes=false;
  if(raw){
    try{var d=atob(raw);hasNodes=d.split(/[\\n\\r]+/).some(function(l){return l.trim().startsWith('vless://')})}catch(e){hasNodes=raw.split(/[\\n\\r]+/).some(function(l){return l.trim().startsWith('vless://')})}
  }
  document.getElementById('convertBtn').disabled=!(hasAddr&&hasNodes);
}

/* ---------- 解析链接 ---------- */
async function doResolve(){
  var link=document.getElementById('linkInput').value.trim();
  if(!link){toast('请输入链接','err');return}
  var btn=document.getElementById('resolveBtn');
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span>解析中...';
  try{
    var r=await fetch('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({link:link})});
    var d=await r.json();
    if(d.error){toast(d.error,'err');return}
    if(d.addresses&&d.addresses.length>0){
      renderChips(d.addresses);
      toast('提取到 '+d.addresses.length+' 个'+d.source+'地址');
    }else{toast('未找到有效地址','err')}
  }catch(e){toast('请求失败: '+e.message,'err')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-magnifying-glass"></i>解析链接'}
}

function renderChips(arr){
  var c=document.getElementById('chips');c.innerHTML='';
  arr.forEach(function(a){
    var ch=document.createElement('div');ch.className='chip';ch.textContent=a;
    ch.onclick=function(){pickChip(a,ch)};c.appendChild(ch);
  });
}

function pickChip(addr,el){
  document.querySelectorAll('.chip').forEach(function(c){c.classList.remove('on')});
  el.classList.add('on');selectedAddr=addr;
  document.getElementById('manualAddr').value='';
  toast('已选择: '+addr);checkReady();
}

function useManual(){
  var a=document.getElementById('manualAddr').value.trim();
  if(!a){toast('请输入地址','err');return}
  document.querySelectorAll('.chip').forEach(function(c){c.classList.remove('on')});
  selectedAddr=a;toast('已选择: '+a);checkReady();
}

/* ---------- 批量转换 ---------- */
async function doConvert(){
  var raw=document.getElementById('vlessInput').value.trim();
  if(!raw||!selectedAddr)return;
  var btn=document.getElementById('convertBtn');
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span>转换中...';
  try{
    var r=await fetch('/api/convert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:raw,newAddress:selectedAddr})});
    var d=await r.json();
    if(d.error){toast(d.error,'err');return}

    // 统计
    var sb=document.getElementById('statsBar');sb.style.display='flex';sb.innerHTML='';
    sb.innerHTML+=
      '<div class="stat stat-all"><i class="fas fa-layer-group"></i>总计 '+d.total+'</div>'+
      '<div class="stat stat-ok"><i class="fas fa-circle-check"></i>成功 '+d.success+'</div>';
    if(d.failed>0){
      sb.innerHTML+='<div class="stat stat-err"><i class="fas fa-circle-xmark"></i>失败 '+d.failed+'</div>';
    }

    // 失败详情
    var fl=document.getElementById('failList');fl.innerHTML='';
    if(d.failedDetails&&d.failedDetails.length>0){
      d.failedDetails.forEach(function(f){
        fl.innerHTML+='<div class="fail-item"><span>第 '+f.line+' 行</span><span>'+esc(f.reason)+'</span></div>';
      });
    }

    // 输出
    var ov=document.getElementById('outVless');ov.textContent=d.vless;ov.classList.add('filled');
    var ob=document.getElementById('outB64');ob.textContent=d.base64;ob.classList.add('filled');
    toast('批量转换完成，成功 '+d.success+' 条');
  }catch(e){toast('转换失败: '+e.message,'err')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-arrows-rotate"></i>执行批量转换';checkReady()}
}

/* ---------- 复制 ---------- */
function copyEl(id){
  var t=document.getElementById(id).textContent;
  if(!t||t.indexOf('将显示在这里')!==-1){toast('暂无内容','err');return}
  navigator.clipboard.writeText(t).then(function(){toast('已复制到剪贴板')}).catch(function(){
    var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;left:-9999px';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    toast('已复制到剪贴板');
  });
}

function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}

/* 回车触发 */
document.getElementById('linkInput').addEventListener('keydown',function(e){if(e.key==='Enter')doResolve()});
document.getElementById('manualAddr').addEventListener('keydown',function(e){if(e.key==='Enter')useManual()});
</script>
</body>
</html>`;
}
