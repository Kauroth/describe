// _worker.js

export default {
  async fetch(request, env) {
    // 1. 读取环境变量 ADDR
    const addr = env.ADDR;

    // 如果未配置环境变量，返回提示
    if (!addr) {
      return new Response(
        "错误：请先在 Cloudflare 后台配置环境变量 ADDR。",
        { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    try {
      // 2. 请求 ADDR 变量中的地址，解析内容
      const response = await fetch(addr);

      // 如果目标地址返回错误状态码（如 404、500），也如实返回
      if (!response.ok) {
        return new Response(
          `无法正常获取目标地址内容，目标服务器返回状态码: ${response.status}`,
          { status: response.status, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      // 3. 获取目标地址的 Content-Type（例如 text/html, application/json）
      const contentType = response.headers.get("content-type") || "text/plain; charset=utf-8";

      // 4. 将目标地址的内容解析为文本
      const content = await response.text();

      // 5. 将解析出的内容显示出来（返回给浏览器）
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": contentType,
        },
      });

    } catch (err) {
      // 捕获网络错误、无效的 URL 格式等异常
      return new Response(
        `解析地址失败: ${err.message}。请检查 ADDR 变量是否为合法的网址（需包含 http:// 或 https://）。`,
        { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
  },
};
