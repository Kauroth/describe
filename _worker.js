// _worker.js
import { getHtml } from './screen.js'; // 引入文件

export default {
  async fetch(request, env, ctx) {
    // 调用函数获取 HTML 字符串
    const html = getHtml();

    return new Response(html, {
      headers: { "content-type": "text/html;charset=UTF-8" }
    });
  }
};
