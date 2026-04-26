// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const addrStr = env.ADDR;
    const template = url.searchParams.get('template');
    const isSubscribeMode = url.searchParams.get('format') === 'base64';

    if (!addrStr) {
      return new Response("错误：请先配置环境变量 ADDR。", { status: 500 });
    }

    // ==========================================
    // 步骤 1：请求 ADDR，提取 IP/域名，【严格排除 IPv6】
    // ==========================================
    const addresses = addrStr.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0);
    const fetchPromises = addresses.map(async (targetUrl) => {
      try {
        const response = await fetch(targetUrl);
        return await response.text();
      } catch (err) { return ""; }
    });
    
    const resultsText = await Promise.all(fetchPromises);
    const allText = resultsText.join('\n');

    const ipV6Regex = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/;
    
    const extractedData = [];
    for (const line of allText.split('\n')) {
      const hashIndex = line.indexOf('#');
      if (hashIndex !== -1) {
        const possibleAddr = line.substring(0, hashIndex).trim();
        const remark = line.substring(hashIndex + 1).trim();
        
        // 核心过滤：只要包含冒号，就视为 IPv6，直接跳过不处理
        if (possibleAddr.includes(':')) {
          continue;
        }
        
        // 剩下的只要非空，无论是 IPv4 还是域名，全部放行
        if (possibleAddr.length > 0) {
          extractedData.push({ addr: possibleAddr, remark });
        }
      }
    }

    if (extractedData.length === 0) {
      return new Response("错误：未能解析出有效的 IPv4 或域名（已自动排除所有 IPv6）。", { status: 400 });
    }

    // ==========================================
    // 步骤 2：没有 template 参数，显示输入面板
    // ==========================================
    if (!template) {
      const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>VLESS 地址替换器</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 40px 15px; display: flex; justify-content: center; }
            .card { background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); max-width: 650px; width: 100%; }
            h2 { margin-top: 0; color: #1f2937; }
            p { color: #6b7280; font-size: 14px; line-height: 1.6; }
            textarea { width: 100%; height: 100px; margin: 15px 0; padding: 10px; border: 1px solid #d1d5db; border-radius: 5px; font-family: monospace; font-size: 12px; box-sizing: border-box; resize: vertical; }
            button { background: #3b82f6; color: #fff; border: none; padding: 12px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
            button:hover { background: #2563eb; }
            .info-box { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; padding: 15px; border-radius: 5px; margin-bottom: 20px; font-size: 14px; }
            .warn-box { background: #fef3c7; border: 1px solid #fde68a; color: #92400e; padding: 10px; border-radius: 5px; margin-bottom: 20px; font-size: 13px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🔗 VLESS 纯地址替换</h2>
            <div class="info-box">
              <strong>已从 ADDR 解析到 ${extractedData.length} 条有效记录。</strong><br>
              提取规则：保留 IPv4 和域名，<strong>已自动排除所有 IPv6</strong>。
            </div>
            <div class="warn-box">
              ⚠️ 注意：系统只会替换节点中的【IP/域名】部分，UUID、端口、路径、参数等其他任何配置均保持原样！
            </div>
            <p>请粘贴 <strong>1 个完整的 VLESS 模板节点</strong>：</p>
            <textarea id="tpl" placeholder="vless://uuid@1.2.3.4:443?type=ws&security=tls&path=%2Fxxx#原节点名"></textarea>
            <button onclick="generate()">替换地址并生成订阅</button>
          </div>
          <script>
            function generate() {
              const tpl = document.getElementById('tpl').value.trim();
              if (!tpl.startsWith('vless://')) { alert('格式错误！'); return; }
              window.location.href = '?template=' + encodeURIComponent(tpl);
            }
          </script>
        </body>
        </html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ==========================================
    // 步骤 3：精准切分 VLESS 模板
    // ==========================================
    function parseVless(tpl) {
      // 正则说明：@ 后面到冒号前面，全部视为原地址 (支持 IPv4, 域名, 甚至带括号的IPv6)
      const regex = /^(vless:\/\/[0-9a-f-]+@)((?:\[[^\]]+\])|[^:]+)(:\d+)([?][^#]*)?([#].*)?$/i;
      const match = tpl.trim().match(regex);
      if (!match) return null;
      
      return {
        prefix: match[1],       // vless://uuid@
        port: match[3],         // :443
        params: match[4] || "", // ?type=ws...
        suffix: match[5] || ""  // #原节点名
      };
    }

    const parsedTemplate = parseVless(template);
    if (!parsedTemplate) {
      return new Response("错误：节点格式无法解析，请检查是否缺少端口。", { status: 400 });
    }

    // ==========================================
    // 步骤 4：执行纯净替换 (只换地址，换名称)
    // ==========================================
    const newNodes = extractedData.map(data => {
      // 因为前面已经排除了IPv6，所以这里直接原样拼接，绝对安全
      return `${parsedTemplate.prefix}${data.addr}${parsedTemplate.port}${parsedTemplate.params}#${data.remark}`;
    });

    // ==========================================
    // 步骤 5：Base64 订阅输出
    // ==========================================
    if (isSubscribeMode) {
      const plainText = newNodes.join('\n');
      const base64Str = btoa(unescape(encodeURIComponent(plainText)));
      return new Response(base64Str, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    // ==========================================
    // 步骤 6：普通网页结果展示
    // ==========================================
    const subscribeLink = `${url.origin}${url.pathname}?template=${encodeURIComponent(template)}&format=base64`;

    const tableRows = extractedData.map((data, i) => `
      <tr>
        <td style="padding: 10px; border: 1px solid #e5e7eb; text-align: center;">${i + 1}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb; font-family: monospace; color: #dc2626; text-decoration: line-through; word-break: break-all;">${template.match(/@([^:]+)/)[1].replace(/^\[|\]$/g, '')}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb; font-family: monospace; color: #16a34a; font-weight: bold;">${data.addr}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb;">${data.remark}</td>
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
          .container { max-width: 900px; margin: 0 auto; }
          .card { background: #fff; padding: 25px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); margin-bottom: 20px; }
          h2 { margin-top: 0; color: #1f2937; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          th { background: #1f2937; color: #fff; padding: 10px; text-align: left; }
          .sub-box { background: #eff6ff; border: 2px solid #3b82f6; padding: 20px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 15px; flex-wrap: wrap; }
          .sub-link { flex: 1; word-break: break-all; font-family: monospace; font-size: 13px; color: #1d4ed8; background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #bfdbfe; user-select: all; }
          .copy-btn { background: #3b82f6; color: #fff; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; white-space: nowrap; }
          .copy-btn:hover { background: #2563eb; }
          .back-link { display: inline-block; margin-top: 15px; color: #6b7280; text-decoration: none; }
          .back-link:hover { color: #111827; }
          pre { background: #1f2937; color: #f8fafc; padding: 15px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 15px 0 0 0; white-space: pre-wrap; word-break: break-all;}
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h2>✅ 成功生成 ${newNodes.length} 个节点</h2>
            <p style="color:#6b7280; font-size:14px;">除地址和节点名外，其他参数已完全保留原模板设置：</p>
            <pre>${escapeHtml(newNodes[0])}</pre>
            <table>
              <thead>
                <tr>
                  <th style="width: 50px;">#</th>
                  <th>模板原地址</th>
                  <th>替换为新地址</th>
                  <th>新节点名称</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
            <a href="?" class="back-link">← 返回重新生成</a>
          </div>
          
          <div class="card">
            <h2>📥 Base64 订阅链接</h2>
            <div class="sub-box">
              <div class="sub-link" id="subLink">${subscribeLink}</div>
              <button class="copy-btn" onclick="copyLink()">一键复制</button>
            </div>
          </div>
        </div>
        <script>
          function copyLink() {
            const text = document.getElementById('subLink').innerText;
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.querySelector('.copy-btn');
              btn.innerText = '已复制!';
              btn.style.background = '#16a34a';
              setTimeout(() => { btn.innerText = '一键复制'; btn.style.background = '#3b82f6'; }, 2000);
            }).catch(() => alert('已复制'));
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
