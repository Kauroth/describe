// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isSubscribeMode = url.searchParams.get('format') === 'base64';
    
    // 1. 读取所有模板变量，并赋予默认值
    const addrStr = env.ADDR;
    const tplUuid = env.TPL_UUID || "";
    const tplPort = env.TPL_PORT || "443";
    const tplSni = env.TPL_SNI || "";
    const tplHost = env.TPL_HOST || "";
    const tplPath = env.TPL_PATH || "";
    const tplType = env.TPL_TYPE || "ws";
    const tplSecurity = env.TPL_SECURITY || "tls";
    const tplFp = env.TPL_FP || "chrome";
    const tplEncryption = env.TPL_ENCRYPTION || "none";
    const tplExtra = env.TPL_EXTRA || "";
    const defaultOverride = env.DEFAULT_PARAMS || "";

    if (!addrStr || !tplUuid) {
      return new Response("错误：请至少配置环境变量 ADDR 和 TPL_UUID。", { status: 500 });
    }

    // ==========================================
    // 步骤 1：请求 ADDR 并提取 IP/域名 和备注
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

    const ipV4Regex = /(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})/;
    const ipV6Regex = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/;
    
    const extractedData = [];
    for (const line of allText.split('\n')) {
      const hashIndex = line.indexOf('#');
      if (hashIndex !== -1) {
        const possibleAddr = line.substring(0, hashIndex).trim();
        const remark = line.substring(hashIndex + 1).trim();
        if (ipV4Regex.test(possibleAddr) || ipV6Regex.test(possibleAddr) || possibleAddr.includes('.')) {
          extractedData.push({ addr: possibleAddr, remark });
        }
      }
    }

    if (extractedData.length === 0) {
      return new Response("错误：未能从 ADDR 解析出任何数据。", { status: 400 });
    }

    // ==========================================
    // 步骤 2：在底层自动拼装基础 VLESS 模板
    // ==========================================
    function buildBaseParams() {
      const params = new URLSearchParams();
      if (tplEncryption) params.set("encryption", tplEncryption);
      if (tplSecurity) params.set("security", tplSecurity);
      if (tplSni) params.set("sni", tplSni);
      if (tplFp) params.set("fp", tplFp);
      if (tplType) params.set("type", tplType);
      if (tplHost) params.set("host", tplHost);
      if (tplPath) params.set("path", tplPath); // 路径会在这里被自动 URL 编码 (如 / 变成 %2F)
      
      // 追加额外参数
      if (tplExtra) {
        tplExtra.split('&').forEach(pair => {
          const [k, v] = pair.split('=');
          if (k) params.set(k, v);
        });
      }

      // 处理强制覆盖参数
      if (defaultOverride) {
        defaultOverride.replace(/^[?&]+/, '').split('&').forEach(pair => {
          const [k, v] = pair.split('=');
          if (k) params.set(k, v); // 覆盖同名参数
        });
      }

      return params.toString();
    }

    const finalParamsStr = buildBaseParams();
    const tplPrefix = `vless://${tplUuid}@`;
    const tplMiddle = `:${tplPort}?${finalParamsStr}#`;

    // ==========================================
    // 步骤 3：Base64 订阅输出
    // ==========================================
    if (isSubscribeMode) {
      const plainText = extractedData.map(data => {
        const isV6 = data.addr.includes(':');
        const formattedAddr = isV6 ? `[${data.addr}]` : data.addr;
        return `${tplPrefix}${formattedAddr}${tplMiddle}${data.remark}`;
      }).join('\n');

      const base64Str = btoa(unescape(encodeURIComponent(plainText)));
      return new Response(base64Str, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    // ==========================================
    // 步骤 4：普通网页输出 (配置看板)
    // ==========================================
    const subscribeLink = `${url.origin}${url.pathname}?format=base64`;
    
    // 生成一个示例节点供前端展示
    const demoAddr = "1.1.1.1";
    const demoNode = `${tplPrefix}${demoAddr}${tplMiddle}示例节点名称`;

    const configRows = [
      ["UUID", tplUuid], ["端口", tplPort], ["SNI", tplSni], 
      ["HOST", tplHost], ["PATH", tplPath], ["协议", tplType],
      ["安全", tplSecurity], ["指纹", tplFp], ["加密", tplEncryption], ["额外", tplExtra]
    ].map(([k, v]) => `
      <tr>
        <td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;width:120px;">${k}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace;word-break:break-all;color:#374151;">${v || '<span style="color:#9ca3af">未设置</span>'}</td>
      </tr>
    `).join('');

    const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>VLESS 订阅生成器</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 30px 15px; }
          .container { max-width: 900px; margin: 0 auto; }
          .card { background: #fff; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); margin-bottom: 20px; }
          h2 { margin-top: 0; color: #1f2937; }
          .success-box { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; padding: 15px; border-radius: 8px; margin-bottom: 20px; font-size: 15px; }
          .sub-box { background: #eff6ff; border: 2px solid #3b82f6; padding: 20px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 15px; flex-wrap: wrap; margin-bottom: 20px;}
          .sub-link { flex: 1; word-break: break-all; font-family: monospace; font-size: 14px; color: #1d4ed8; background: #fff; padding: 12px; border-radius: 4px; border: 1px solid #bfdbfe; user-select: all; }
          .copy-btn { background: #3b82f6; color: #fff; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; font-weight: bold; white-space: nowrap; font-size: 15px;}
          .copy-btn:hover { background: #2563eb; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          pre { background: #1f2937; color: #f8fafc; padding: 15px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 15px 0 0 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-box">
            ✅ <strong>运行正常：</strong>已从 ADDR 成功解析出 <strong>${extractedData.length}</strong> 条有效记录。模板变量已加载完毕。
          </div>

          <div class="card">
            <h2>📥 一键订阅链接</h2>
            <p style="color:#6b7280;font-size:14px;">直接将此链接填入客户端即可，无需任何手动传参：</p>
            <div class="sub-box">
              <div class="sub-link" id="subLink">${subscribeLink}</div>
              <button class="copy-btn" onclick="copyLink()">一键复制</button>
            </div>
          </div>

          <div class="card">
            <h2>⚙️ 当前生效的模板变量</h2>
            <table>${configRows}</table>
            ${defaultOverride ? `<div style="margin-top:15px;color:#dc2626;font-weight:bold;">⚠️ 检测到 DEFAULT_PARAMS 覆盖变量：${defaultOverride}</div>` : ''}
          </div>

          <div class="card">
            <h2>🧩 拼装效果预览</h2>
            <p style="color:#6b7280;font-size:14px;">基于上述变量，底层实际生成的节点结构如下：</p>
            <pre>${escapeHtml(demoNode)}</pre>
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

    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
