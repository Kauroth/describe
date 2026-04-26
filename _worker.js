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
    // 步骤 1：请求 ADDR，极强容错提取，排除 IPv6
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

    const extractedData = [];
    let autoIndex = 1; // 用于给没有 # 的行自动编号

    for (const line of allText.split('\n')) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      let possibleAddr = "";
      let remark = "";

      // 判断是否有 # 分隔符
      if (trimmedLine.includes('#')) {
        const hashIndex = trimmedLine.indexOf('#');
        possibleAddr = trimmedLine.substring(0, hashIndex).trim();
        remark = trimmedLine.substring(hashIndex + 1).trim();
      } else {
        // 没有 # 的话，整行都当作地址，自动生成一个名字
        possibleAddr = trimmedLine;
        remark = `自动节点_${autoIndex}`;
      }

      // 【新增容错】自动清理可能带上的 http/https 协议头
      possibleAddr = possibleAddr.replace(/^(https?:\/\/)/i, "").replace(/^\/\//, "");
      // 【新增容错】自动清理域名尾部可能带上的斜杠
      possibleAddr = possibleAddr.replace(/\/+$/, "");
      // 再次去空格
      possibleAddr = possibleAddr.trim();

      // 核心过滤：只要包含冒号，就视为 IPv6，直接跳过不处理
      if (possibleAddr.includes(':')) {
        continue;
      }

      // 只要清理后非空，无论是 IPv4 还是域名，全部放行
      if (possibleAddr.length > 0) {
        extractedData.push({ addr: possibleAddr, remark });
        autoIndex++;
      }
    }

    if (extractedData.length === 0) {
      return new Response("错误：未能解析出有效的 IPv4 或域名（已排除 IPv6）。请检查 ADDR 返回的文本格式。", { status: 400 });
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
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🔗 VLESS 纯地址替换</h2>
            <div class="info-box">
              <strong>已从 ADDR 成功解析到 ${extractedData.length} 条有效记录。</strong><br>
              (已自动剔除 IPv6，已自动清理 http:// 前缀)
            </div>
            <p>请粘贴 <strong>1 个完整的 VLESS 模板节点</strong>：</p>
            <textarea id="tpl" placeholder="vless://uuid@1.2.3.4:443?type=ws&security=tls#原节点名"></textarea>
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
      const regex = /^(vless:\/\/[0-9a-f-]+@)((?:\[[^\]]+\])|[^:]+)(:\d+)([?][^#]*)?([#].*)?$/i;
      const match = tpl.trim().match(regex);
      if (!match) return null;
      
      return {
        prefix: match[1],       
        port: match[3],         
        params: match[4] || "", 
        suffix: match[5] || ""  
      };
    }

    const parsedTemplate = parseVless(template);
    if (!parsedTemplate) {
      return new Response("错误：节点格式无法解析，请检查是否缺少端口。", { status: 400 });
    }

    // 获取模板原本的地址（仅用于前端页面展示对比）
    const originalAddr = template.match(/@([^:]+)/)[1].replace(/^\[|\]$/g, '');

    // ==========================================
    // 步骤 4：执行纯净替换
    // ==========================================
    const newNodes = extractedData.map(data => {
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
            <p style="color:#6b7280; font-size:14px;">第一条节点结构预览（除地址外完全保留原参数）：</p>
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
