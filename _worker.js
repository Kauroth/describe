// _worker.js

export default {
  async fetch(request, env) {
    // 1. 读取环境变量
    const addrStr = env.ADDR;

    if (!addrStr) {
      return new Response("错误：请先在 Cloudflare 后台配置环境变量 ADDR。", { status: 500 });
    }

    // 2. 解析多个地址：用逗号分割，去除首尾空格，并过滤掉空字符串
    const addresses = addrStr.split(',')
      .map(addr => addr.trim())
      .filter(addr => addr.length > 0);

    if (addresses.length === 0) {
      return new Response("错误：ADDR 变量中没有检测到有效的地址。", { status: 400 });
    }

    // 3. 并发请求所有地址
    const fetchPromises = addresses.map(async (url) => {
      try {
        const response = await fetch(url);
        const text = await response.text();
        const contentType = response.headers.get("content-type") || "text/plain";

        return {
          url,
          status: response.status,
          contentType,
          content: text,
          success: response.ok,
        };
      } catch (err) {
        return {
          url,
          status: 502,
          contentType: "text/plain",
          content: `请求失败: ${err.message}`,
          success: false,
        };
      }
    });

    // 等待所有请求完成
    const results = await Promise.all(fetchPromises);

    // 4. 组装展示页面
    const htmlParts = results.map((result, index) => {
      // 顶部信息栏
      const header = `
        <div style="background:#f8f9fa;padding:10px 15px;border-bottom:1px solid #dee2e6;display:flex;justify-content:space-between;align-items:center;">
          <strong>地址 ${index + 1}：</strong>
          <a href="${result.url}" target="_blank" style="color:#0066cc;word-break:break-all;">${result.url}</a>
          <span style="color:${result.success ? '#28a745' : '#dc3545'}; white-space:nowrap; margin-left:10px;">
            状态码: ${result.status} | ${result.contentType.split(';')[0]}
          </span>
        </div>`;

      let contentHtml = '';

      // 智能判断内容类型进行展示
      if (result.contentType.includes("text/html") && result.success) {
        // 如果是 HTML，转成 Base64 放入 iframe 中，实现完美隔离，防止样式和脚本污染主页面
        const base64Content = btoa(unescape(encodeURIComponent(result.content)));
        contentHtml = `<iframe src="data:text/html;base64,${base64Content}" style="width:100%;height:600px;border:none;"></iframe>`;
      } else {
        // 如果是 JSON、纯文本或请求失败，用 <pre> 格式化展示
        contentHtml = `<pre style="padding:15px;background:#212529;color:#f8f9fa;margin:0;overflow:auto;max-height:600px;font-size:14px;line-height:1.5;">${escapeHtml(result.content)}</pre>`;
      }

      return `<div style="border:1px solid #dee2e6;border-radius:5px;margin-bottom:25px;overflow:hidden;box-shadow:0 2px 5px rgba(0,0,0,0.05);">${header}${contentHtml}</div>`;
    }).join('');

    // 5. 返回完整的 HTML 页面
    const finalHtml = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>多地址内容解析</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 20px; background: #e9ecef; }
          .container { max-width: 1200px; margin: 0 auto; }
          h2 { color: #343a40; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>共解析 ${results.length} 个地址</h2>
          ${htmlParts}
        </div>
      </body>
      </html>`;

    return new Response(finalHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

// 辅助函数：转义 HTML 特殊字符，防止 XSS 和标签解析错误
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
