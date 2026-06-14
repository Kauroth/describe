// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const addrStr = env.ADDR;
    
    // 获取前端传过来的参数
    let template = url.searchParams.get('template');
    const isSubscribeMode = url.searchParams.get('format') === 'base64';
    const selectedSourceIndex = parseInt(url.searchParams.get('source') || '0', 10);

    if (!addrStr) {
      return new Response("错误：请先在 Cloudflare 后台配置环境变量 ADDR。", { status: 500 });
    }

    // ==========================================
    // 步骤 1：使用【换行符】精准解析 ADDR 配置，完美包容 URL 参数
    // ==========================================
    const sourceItems = addrStr.split(/\r?\n/).map((item, idx) => {
      const trimmed = item.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return null;
      
      // 支持 "名字|网址" 格式
      if (trimmed.includes('|')) {
        const parts = trimmed.split('|');
        const name = parts[0].trim();
        // 把剩余的部分重新拼接，防止网址参数里也包含 '|'
        const urlPart = parts.slice(1).join('|').trim(); 
        return { name, url: urlPart };
      }
      
      // 如果没有写名字，自动生成一个名字
      return {
        name: `订阅源_${idx + 1}`,
        url: trimmed
      };
    }).filter(Boolean);

    if (sourceItems.length === 0) {
      return new Response("错误：环境变量 ADDR 格式不正确，未能解析出任何有效的网址。", { status: 500 });
    }

    // 确保用户选择的源索引在有效范围内
    const activeIndex = (selectedSourceIndex >= 0 && selectedSourceIndex < sourceItems.length) ? selectedSourceIndex : 0;
    const currentTarget = sourceItems[activeIndex];

    // ==========================================
    // 步骤 2：请求当前选中的订阅源并解析内容
    // ==========================================
    let allText = "";
    try {
      const response = await fetch(currentTarget.url, { 
        headers: { 'User-Agent': 'Mozilla/5.0' }, 
        signal: AbortSignal.timeout(6000) // 略微延长超时至 6 秒
      });
      if (response.ok) {
        allText = await response.text();
      }
    } catch (err) {
      // 容错捕获
    }

    const extractedData = [];
    let autoIndex = 1;

    for (const line of allText.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('# ')) continue;

      let possibleAddr = "";
      let remark = "";

      // 解析 ip/域名#ip名称 格式
      if (trimmedLine.includes('#')) {
        const hashIndex = trimmedLine.indexOf('#');
        possibleAddr = trimmedLine.substring(0, hashIndex).trim();
        remark = trimmedLine.substring(hashIndex + 1).trim();
      } else {
        possibleAddr = trimmedLine;
        remark = `自动节点_${autoIndex}`;
      }

      // 强力清理协议头与尾斜杠
      possibleAddr = possibleAddr.replace(/^(https?:\/\/)/i, "").replace(/^\/\//, "").replace(/\/+$/, "").trim();

      // 排除 IPv6
      if (possibleAddr.includes(':')) continue;

      if (possibleAddr.length > 0) {
        extractedData.push({ addr: possibleAddr, remark });
        autoIndex++;
      }
    }

    // ==========================================
    // 步骤 3：没有 template 参数，显示输入与选择面板
    // ==========================================
    if (!template) {
      const selectOptions = sourceItems.map((item, idx) => {
        const isSelected = idx === activeIndex ? 'selected' : '';
        return `<option value="${idx}" ${isSelected}>${escapeHtml(item.name)}</option>`;
      }).join('');

      const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>VLESS 节点多源替换器</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 40px 15px; display: flex; justify-content: center; }
            .card { background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); max-width: 650px; width: 100%; }
            h2 { margin-top: 0; color: #1f2937; }
            label { font-size: 14px; font-weight: bold; color: #374151; display: block; margin-top: 15px; }
            select, textarea { width: 100%; margin: 8px 0 15px 0; padding: 12px; border: 1px solid #d1d5db; border-radius: 5px; font-size: 14px; box-sizing: border-box; background: #fff; }
            textarea { height: 120px; font-family: monospace; font-size: 12px; resize: vertical; }
            button { background: #3b82f6; color: #fff; border: none; padding: 14px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; transition: background 0.2s; }
            button:hover { background: #2563eb; }
            .info-box { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 15px; border-radius: 5px; margin-bottom: 20px; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🔗 VLESS 多源地址替换</h2>
            <div class="info-box">
              系统已成功加载由换行符分隔的 <strong>${sourceItems.length}</strong> 个节点数据源。
            </div>
            
            <label for="sourceSelect">🗺️ 第一步：选择节点数据源</label>
            <select id="sourceSelect">
              ${selectOptions}
            </select>

            <label for="tpl">🚀 第二步：粘贴 1 个完整的 VLESS 模板节点</label>
            <textarea id="tpl" placeholder="vless://xxxx-xxxx-xxxx@1.2.3.4:443?type=ws&security=tls#原节点名"></textarea>
            
            <button onclick="generate()">替换地址并生成订阅</button>
          </div>
          <script>
            function generate() {
              const sourceIdx = document.getElementById('sourceSelect').value;
              const tpl = document.getElementById('tpl').value.trim();
              if (!tpl.startsWith('vless://')) { alert('格式错误！节点必须以 vless:// 开头'); return; }
              window.location.href = '?source=' + sourceIdx + '&template=' + encodeURIComponent(tpl);
            }
          </script>
        </body>
        </html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ==========================================
    // 后续步骤：替换与输出
    // ==========================================
    if (extractedData.length === 0) {
      return new Response(`错误：选中的订阅源【${currentTarget.name}】拉取失败，或未解析出有效的 IPv4/域名。请检查该网址是否能在浏览器中正常打开、Token 是否过期。`, { status: 400 });
    }

    function parseVless(tpl) {
      const regex = /^(vless:\/\/[^@]+@)([^:]+)(:\d+)([^#]*)(#.*)?$/i;
      const match = tpl.trim().match(regex);
      if (!match) return null;
      
      return {
        prefix: match[1],       
        originalHost: match[2],
        port: match[3],         
        params: match[4] || "",  
        suffix: match[5] || ""  
      };
    }

    const parsedTemplate = parseVless(template);
    if (!parsedTemplate) {
      return new Response("错误：节点模板格式无法解析。请检查端口号是否存在。", { status: 400 });
    }

    const originalAddr = parsedTemplate.originalHost.replace(/^\[|\]$/g, '');

    // 执行替换
    const newNodes = extractedData.map(data => {
      return `${parsedTemplate.prefix}${data.addr}${parsedTemplate.port}${parsedTemplate.params}#${data.remark}`;
    });

    // 输出 Base64
    if (isSubscribeMode) {
      const plainText = newNodes.join('\n');
      const utf8Bytes = new TextEncoder().encode(plainText);
      const base64Str = btoa(String.fromCharCode(...utf8Bytes));
      
      return new Response(base64Str, {
        status: 200,
        headers: { 
          "Content-Type": "text/plain; charset=utf-8", 
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*"
        },
      });
    }

    // 输出普通网页
    const subscribeLink = `${url.origin}${url.pathname}?source=${activeIndex}&template=${encodeURIComponent(template)}&format=base64`;

    const tableRows = extractedData.map((data, i) => `
      <tr>
        <td style="padding: 10px; border: 1px solid #e5e7eb; text-align: center;">${i + 1}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb; font-family: monospace; color: #dc2626; text-decoration: line-through;">${escapeHtml(originalAddr)}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb; font-family: monospace; color: #16a34a; font-weight: bold; word-break: break-all;">${escapeHtml(data.addr)}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb;">${escapeHtml(data.remark)}</td>
      </tr>
    `).join('');

    const resultHtml = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>生成成功</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 40px 15px; }
          .container { max-width: 950px; margin: 0 auto; }
          .card { background: #fff; padding: 25px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); margin-bottom: 20px; }
          h2 { margin-top: 0; color: #1f2937; }
          .badge { font-size: 14px; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 12px; font-weight: normal; margin-left: 10px; display: inline-block; vertical-align: middle; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; background: #fafafa; }
          th { background: #1f2937; color: #fff; padding: 12px 10px; text-align: left; }
          .sub-box { background: #eff6ff; border: 2px solid #3b82f6; padding: 20px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 15px; flex-wrap: wrap; }
          .sub-link { flex: 1; word-break: break-all; font-family: monospace; font-size: 13px; color: #1d4ed8; background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #bfdbfe; user-select: all; }
          .copy-btn { background: #3b82f6; color: #fff; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; white-space: nowrap; transition: all 0.2s; }
          .copy-btn:hover { background: #2563eb; }
          .back-link { display: inline-block; margin-top: 15px; color: #6b7280; text-decoration: none; }
          .back-link:hover { color: #111827; }
          pre { background: #1f2937; color: #f8fafc; padding: 15px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 15px 0 0 0; white-space: pre-wrap; word-break: break-all;}
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h2>📥 订阅链接生成成功 <span class="badge">当前源：${escapeHtml(currentTarget.name)}</span></h2>
            <div class="sub-box">
              <div class="sub-link" id="subLink">${subscribeLink}</div>
              <button class="copy-btn" onclick="copyLink()">一键复制链接</button>
            </div>
          </div>

          <div class="card">
            <h2>✅ 已成功替换 ${newNodes.length} 个节点地址</h2>
            <p style="color:#6b7280; font-size:14px;">首个节点结构预览：</p>
            <pre>${escapeHtml(newNodes[0])}</pre>
            <table>
              <thead>
                <tr>
                  <th style="width: 50px; text-align:center;">#</th>
                  <th>模板原地址</th>
                  <th>替换为新地址</th>
                  <th>新节点名称（来自订阅源）</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
            <a href="?" class="back-link">← 返回首页重新选择</a>
          </div>
        </div>
        <script>
          function copyLink() {
            const text = document.getElementById('subLink').innerText;
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.querySelector('.copy-btn');
              btn.innerText = '已复制!';
              btn.style.background = '#16a34a';
              setTimeout(() => { btn.innerText = '一键复制链接'; btn.style.background = '#3b82f6'; }, 2000);
            }).catch(() => {
              alert('复制失败，请手动选择框内链接复制。');
            });
          }
        </script>
      </body>
      </html>`;

    return new Response(resultHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
