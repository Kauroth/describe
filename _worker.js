// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const addrStr = env.ADDR;
    const template = url.searchParams.get('template');
    const isSubscribeMode = url.searchParams.get('format') === 'base64';

    if (!addrStr) {
      return new Response("错误：请先在 Cloudflare 后台配置环境变量 ADDR。", { status: 500 });
    }

    // ==========================================
    // 步骤 1：请求 ADDR 并提取 IP 和备注
    // ==========================================
    const addresses = addrStr.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0);
    const fetchPromises = addresses.map(async (targetUrl) => {
      try {
        const response = await fetch(targetUrl);
        return await response.text();
      } catch (err) {
        return ""; // 请求失败则返回空
      }
    });

    const resultsText = await Promise.all(fetchPromises);
    const allText = resultsText.join('\n');

    // 正则提取 IPv4 和 IPv6 及备注
    const ipV4Regex = /(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})/;
    const ipV6Regex = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/;

    const extractedData = [];
    const lines = allText.split('\n');
    for (const line of lines) {
      const hashIndex = line.indexOf('#');
      if (hashIndex !== -1) {
        const possibleIp = line.substring(0, hashIndex).trim();
        const remark = line.substring(hashIndex + 1).trim();
        if (ipV4Regex.test(possibleIp) || ipV6Regex.test(possibleIp)) {
          extractedData.push({ ip: possibleIp, remark });
        }
      }
    }

    if (extractedData.length === 0) {
      return new Response("错误：未能从 ADDR 指定的网址中解析出任何 IP#备注 数据。", { status: 400 });
    }

    // ==========================================
    // 步骤 2：如果没有 template 参数，显示操作面板
    // ==========================================
    if (!template) {
      const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>VLESS 节点批量生成器</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 40px 15px; display: flex; justify-content: center; }
            .card { background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); max-width: 600px; width: 100%; }
            h2 { margin-top: 0; color: #1f2937; }
            p { color: #6b7280; font-size: 14px; line-height: 1.6; }
            textarea { width: 100%; height: 120px; margin: 15px 0; padding: 10px; border: 1px solid #d1d5db; border-radius: 5px; font-family: monospace; font-size: 13px; box-sizing: border-box; resize: vertical; }
            button { background: #3b82f6; color: #fff; border: none; padding: 12px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
            button:hover { background: #2563eb; }
            .info-box { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; padding: 15px; border-radius: 5px; margin-bottom: 20px; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🚀 VLESS 节点批量生成器</h2>
            <div class="info-box">
              <strong>已从 ADDR 中成功解析 ${extractedData.length} 个 IP 记录。</strong><br>
              系统会提取记录中的 IP 替换掉下方节点模板的地址，并将记录备注作为新节点名称。
            </div>
            <p>请在下方粘贴 <strong>1 个 VLESS 节点模板</strong>（支持 IPv4/IPv6）：</p>
            <textarea id="tpl" placeholder="例如：vless://a1b2c3d4-xxxx@1.1.1.1:443?type=ws&security=tls#默认节点"></textarea>
            <button onclick="generate()">生成节点并获取订阅链接</button>
          </div>
          <script>
            function generate() {
              const tpl = document.getElementById('tpl').value.trim();
              if (!tpl.startsWith('vless://')) {
                alert('请输入正确的 VLESS 节点格式！');
                return;
              }
              // 跳转到带有 template 参数的页面
              window.location.href = '?template=' + encodeURIComponent(tpl);
            }
          </script>
        </body>
        </html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ==========================================
    // 步骤 3：解析 VLESS 模板
    // ==========================================
    function parseVless(tpl) {
      // 匹配 vless://uuid@IP:端口?参数#名称 (兼容IPv6带不带括号的情况)
      const regex = /^(vless:\/\/[0-9a-f-]+@)((?:\[[0-9a-fA-F:]+\])|(?:[0-9]{1,3}\.(?:[0-9]{1,3}\.){2}[0-9]{1,3})|(?:[0-9a-fA-F:]+))(:\d+)(\?[^#]*)?(\#.*)?$/i;
      const match = tpl.trim().match(regex);
      if (!match) return null;

      // 去除可能存在的 IPv6 方括号
      const pureIp = match[2].replace(/^\[|\]$/g, '');

      return {
        prefix: match[1],           // vless://uuid@
        port: match[3],             // :port
        params: match[4] || "",     // ?params
        suffix: match[5] || ""      // #name
      };
    }

    const parsedTemplate = parseVless(template);
    if (!parsedTemplate) {
      return new Response("错误：输入的 VLESS 节点格式无法解析，请检查格式是否正确。", { status: 400 });
    }

    // ==========================================
    // 步骤 4：批量生成新节点
    // ==========================================
    const newNodes = extractedData.map(data => {
      const isV6 = data.ip.includes(':');
      // 如果是 IPv6，拼接时加上中括号
      const formattedIp = isV6 ? `[${data.ip}]` : data.ip;
      return `${parsedTemplate.prefix}${formattedIp}${parsedTemplate.port}${parsedTemplate.params}#${data.remark}`;
    });

    // ==========================================
    // 步骤 5：Base64 订阅输出
    // ==========================================
    if (isSubscribeMode) {
      const plainText = newNodes.join('\n');
      const base64Str = btoa(unescape(encodeURIComponent(plainText)));
      return new Response(base64Str, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        },
      });
    }

    // ==========================================
    // 步骤 6：普通网页输出（展示结果与订阅链接）
    // ==========================================
    const subscribeLink = `${url.origin}${url.pathname}?template=${encodeURIComponent(template)}&format=base64`;

    const tableRows = extractedData.map((data, i) => `
      <tr>
        <td style="padding: 10px; border: 1px solid #e5e7eb; text-align: center;">${i + 1}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb; font-family: monospace; color: #dc2626; text-decoration: line-through;">${parsedTemplate.prefix.includes('[') ? '[' + data.ip + ']' : data.ip}</td>
        <td style="padding: 10px; border: 1px solid #e5e7eb; font-family: monospace; color: #16a34a; font-weight: bold;">${data.ip.includes(':') ? '[' + data.ip + ']' : data.ip}</td>
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
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h2>✅ 成功生成 ${newNodes.length} 个新节点</h2>
            <table>
              <thead>
                <tr>
                  <th style="width: 50px;">#</th>
                  <th>模板原 IP</th>
                  <th>替换为新 IP</th>
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
            <p style="color:#6b7280; font-size:14px; margin-bottom:15px;">请将下方链接复制到您的代理客户端（如 Clash, v2rayN 等）中订阅：</p>
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
            }).catch(err => {
              // 降级方案
              const textarea = document.createElement('textarea');
              textarea.value = text; document.body.appendChild(textarea);
              textarea.select(); document.execCommand('copy'); document.body.removeChild(textarea);
              alert('已复制到剪贴板');
            });
          }
        </script>
      </body>
      </html>`;

    return new Response(resultHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
