// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const addrStr = env.ADDR;

    // 判断是否为订阅模式
    const isSubscribeMode = url.searchParams.get('format') === 'base64' || url.searchParams.has('subscribe');

    if (!addrStr) {
      return new Response("错误：请先配置环境变量 ADDR。", { status: 500 });
    }

    // 1. 解析 ADDR 中的多个网址
    const addresses = addrStr.split(',')
      .map(addr => addr.trim())
      .filter(addr => addr.length > 0);

    if (addresses.length === 0) {
      return new Response("错误：ADDR 中没有有效的网址。", { status: 400 });
    }

    // 2. 并发请求所有网址，获取文本内容
    const fetchPromises = addresses.map(async (targetUrl) => {
      try {
        const response = await fetch(targetUrl);
        const text = await response.text();
        const contentType = response.headers.get("content-type") || "text/plain";
        return { url: targetUrl, status: response.status, contentType, content: text, success: response.ok };
      } catch (err) {
        return { url: targetUrl, status: 502, contentType: "text/plain", content: `请求失败: ${err.message}`, success: false };
      }
    });

    const results = await Promise.all(fetchPromises);

    // ==========================================
    // 分支 1：订阅模式 (精准提取 IP#备注 并 Base64 编码)
    // ==========================================
    if (isSubscribeMode) {
      // 把所有网址返回的文本合并
      const allText = results.map(r => r.content).join('\n');

      // 正则定义
      const ipV4Regex = /(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})/;
      const ipV6Regex = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/;

      const validLines = [];
      const lines = allText.split('\n');

      // 逐行解析提取
      for (const line of lines) {
        const hashIndex = line.indexOf('#');
        if (hashIndex !== -1) {
          const possibleIp = line.substring(0, hashIndex).trim();
          const remark = line.substring(hashIndex + 1).trim();

          // 判断 # 前面的内容是否为合法的 IPv4 或 IPv6
          if (ipV4Regex.test(possibleIp) || ipV6Regex.test(possibleIp)) {
            // 格式化为 "IP 备注" (用空格替代 #)
            validLines.push(`${possibleIp} ${remark}`);
          }
        }
      }

      // 用换行符拼接最终纯文本
      const plainText = validLines.join('\n');

      if (plainText === "") {
        return new Response("", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      // 转义并转为 Base64
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
    // 分支 2：普通模式 (可视化网页展示)
    // ==========================================
    const subscribeLink = `${url.origin}${url.pathname}?format=base64`;

    const htmlParts = results.map((result, index) => {
      const header = `
        <div style="background:#f8f9fa;padding:10px 15px;border-bottom:1px solid #dee2e6;display:flex;justify-content:space-between;flex-wrap:wrap;align-items:center;">
          <strong>源 ${index + 1}：</strong>
          <a href="${result.url}" target="_blank" style="color:#0066cc;word-break:break-all;">${result.url}</a>
          <span style="color:${result.success ? '#28a745' : '#dc3545'}; white-space:nowrap; margin-left:10px;">
            状态码: ${result.status}
          </span>
        </div>`;

      let contentHtml = '';
      if (result.contentType.includes("text/html") && result.success) {
        const base64Content = btoa(unescape(encodeURIComponent(result.content)));
        contentHtml = `<iframe src="data:text/html;base64,${base64Content}" style="width:100%;height:500px;border:none;"></iframe>`;
      } else {
        contentHtml = `<pre style="padding:15px;background:#212529;color:#f8f9fa;margin:0;overflow:auto;max-height:500px;font-size:14px;line-height:1.5;">${escapeHtml(result.content)}</pre>`;
      }

      return `<div style="border:1px solid #dee2e6;border-radius:5px;margin-bottom:25px;overflow:hidden;box-shadow:0 2px 5px rgba(0,0,0,0.05);">${header}${contentHtml}</div>`;
    }).join('');

    const finalHtml = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>多源内容解析</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; margin: 0; padding: 30px 15px; }
          .container { max-width: 1200px; margin: 0 auto; }
          h2 { color: #343a40; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
          .sub-box { background: #fff; padding: 15px; border-radius: 5px; margin-bottom: 25px; border-left: 4px solid #28a745; box-shadow: 0 2px 5px rgba(0,0,0,0.05); word-break: break-all;}
          .sub-box a { color: #28a745; font-weight: bold; text-decoration: none;}
          .sub-box a:hover { text-decoration: underline;}
        </style>
      </head>
      <body>
        <div class="container">
          <h2>数据源解析 (共 ${results.length} 个)</h2>
          <div class="sub-box">
            <span>📥 <strong>提取 IP 订阅链接：</strong>自动从下方内容中提取 IPv4/IPv6 与备注，输出 Base64。</span>
            <br><a href="${subscribeLink}" target="_blank">${subscribeLink}</a>
          </div>
          ${htmlParts}
        </div>
      </body>
      </html>`;

    return new Response(finalHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

// 辅助函数：防止 XSS
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
