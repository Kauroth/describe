// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const addrStr = env.ADDR;

    // 判断是否触发订阅模式 (访问时加上 ?format=base64 或 ?subscribe=1)
    const isSubscribeMode = url.searchParams.get('format') === 'base64' || url.searchParams.has('subscribe');

    if (!addrStr) {
      return new Response("错误：请先配置环境变量 ADDR。", { status: 500 });
    }

    // 解析多个地址
    const addresses = addrStr.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0);
    if (addresses.length === 0) {
      return new Response("错误：ADDR 变量中没有有效的地址。", { status: 400 });
    }

    // ==========================================
    // 核心逻辑：并发请求所有地址
    // ==========================================
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
    // 分支 1：订阅模式 (返回 Base64 编码)
    // ==========================================
    if (isSubscribeMode) {
      // 将结果打包为结构化 JSON
      const payload = JSON.stringify({
        update_time: new Date().toISOString(),
        count: results.length,
        data: results.map(r => ({
          url: r.url,
          status: r.status,
          content: r.content
        }))
      }, null, 0); // 压缩 JSON，减少体积

      // 处理中文等非 Latin1 字符，防止 btoa 报错，然后转为 Base64
      const base64Str = btoa(unescape(encodeURIComponent(payload)));

      return new Response(base64Str, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          // 建议关闭缓存，保证每次拉取都是最新内容
          "Cache-Control": "no-cache, no-store, must-revalidate"
        },
      });
    }

    // ==========================================
    // 分支 2：普通模式 (返回可视化 HTML 页面)
    // ==========================================
    const subscribeLink = `${url.origin}${url.pathname}?format=base64`;

    const htmlParts = results.map((result, index) => {
      const header = `
        <div style="background:#f8f9fa;padding:10px 15px;border-bottom:1px solid #dee2e6;display:flex;justify-content:space-between;flex-wrap:wrap;align-items:center;">
          <strong>地址 ${index + 1}：</strong>
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
        <title>多地址内容解析</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; background: #e9ecef; }
          .container { max-width: 1200px; margin: 0 auto; }
          h2 { color: #343a40; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
          .sub-box { background: #fff; padding: 15px; border-radius: 5px; border: 1px dashed #007bff; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;}
          .sub-box a { color: #007bff; font-weight: bold; text-decoration: none; word-break: break-all;}
          .sub-box a:hover { text-decoration: underline;}
        </style>
      </head>
      <body>
        <div class="container">
          <h2>共解析 ${results.length} 个地址</h2>
          <div class="sub-box">
            <span>📥 <strong>Base64 订阅链接：</strong>可用于 RSS 阅读器、Telegram Bot 或脚本定时拉取。</span>
            <a href="${subscribeLink}" target="_blank">${subscribeLink}</a>
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

// 辅助函数：转义 HTML 特殊字符
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
