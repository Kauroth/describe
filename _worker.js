// _worker.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const addrStr = env.ADDR;
    
    // 获取核心参数
    const template = url.searchParams.get('template');
    const isSubscribeMode = url.searchParams.get('format') === 'base64';
    const selectedSourceIndex = parseInt(url.searchParams.get('source') || '0', 10);

    if (!addrStr) {
      return new Response("错误：请先在 Cloudflare 后台配置环境变量 ADDR。", { status: 500 });
    }

    // ==========================================
    // 步骤 1：解析 ADDR 多源配置（按换行符拆分）
    // ==========================================
    const sourceItems = addrStr.split(/\r?\n/).map((item, idx) => {
      const trimmed = item.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return null;
      
      if (trimmed.includes('|')) {
        const parts = trimmed.split('|');
        const name = parts[0].trim();
        const urlPart = parts.slice(1).join('|').trim(); 
        return { name, url: urlPart };
      }
      
      return {
        name: `订阅源_${idx + 1}`,
        url: trimmed
      };
    }).filter(Boolean);

    if (sourceItems.length === 0) {
      return new Response("错误：环境变量 ADDR 格式不正确，未能解析出任何有效的网址。", { status: 500 });
    }

    // ==========================================
    // 步骤 2：核心处理逻辑（当带有 template 参数时触发，支持页面内 API 调用或直接订阅）
    // ==========================================
    if (template) {
      const activeIndex = (selectedSourceIndex >= 0 && selectedSourceIndex < sourceItems.length) ? selectedSourceIndex : 0;
      const currentTarget = sourceItems[activeIndex];

      let allText = "";
      let fetchError = "";

      try {
        const response = await fetch(currentTarget.url, { 
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
          }, 
          signal: AbortSignal.timeout(8000)
        });
        if (response.ok) {
          allText = await response.text();
        } else {
          fetchError = `HTTP 状态码异常: ${response.status}`;
        }
      } catch (err) {
        fetchError = `网络请求失败或超时: ${err.message || err}`;
      }

      const extractedData = [];
      let autoIndex = 1;

      if (allText) {
        for (const line of allText.split(/\r?\n/)) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('# ')) continue;

          let possibleAddr = "";
          let remark = "";

          if (trimmedLine.includes('#')) {
            const hashIndex = trimmedLine.indexOf('#');
            possibleAddr = trimmedLine.substring(0, hashIndex).trim();
            remark = trimmedLine.substring(hashIndex + 1).trim();
          } else {
            possibleAddr = trimmedLine;
            remark = `自动节点_${autoIndex}`;
          }

          possibleAddr = possibleAddr.replace(/^(https?:\/\/)/i, "").replace(/^\/\//, "").replace(/\/+$/, "").trim();
          if (possibleAddr.includes(':')) continue;

          if (possibleAddr.length > 0) {
            extractedData.push({ addr: possibleAddr, remark });
            autoIndex++;
          }
        }
      }

      // 异常反馈（如果是代理软件请求订阅模式，返回明文错误；如果是前端调用的 API 则返回 JSON 供前端单页渲染）
      const isJsonRequest = url.searchParams.get('api') === 'true';

      if (extractedData.length === 0) {
        const errorMsg = fetchError || "未能从订阅源拉取到数据，或无法解析出任何有效的 IPv4/域名。";
        if (isJsonRequest) {
          return new Response(JSON.stringify({ error: errorMsg, rawText: allText || "[无内容]" }), {
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }
        return new Response(`错误诊断：${errorMsg}`, { status: 400 });
      }

      // 解析模板
      const regex = /^(vless:\/\/[^@]+@)([^:]+)(:\d+)([^#]*)(#.*)?$/i;
      const match = template.trim().match(regex);
      if (!match) {
        if (isJsonRequest) return new Response(JSON.stringify({ error: "节点模板格式错误，无法解析端口。" }), { headers: { "Content-Type": "application/json" } });
        return new Response("错误：节点模板格式错误。", { status: 400 });
      }

      const prefix = match[1];
      const originalHost = match[2].replace(/^\[|\]$/g, '');
      const originalPortStr = match[3];
      const params = match[4] || "";

      // 智能端口随机分配
      const cfTlsPorts = [2053, 2083, 2087, 2096, 8443, 443];
      const nodesInfo = extractedData.map(data => {
        let finalPortStr = originalPortStr;
        if (originalPortStr === ':443') {
          const randomPort = cfTlsPorts[Math.floor(Math.random() * cfTlsPorts.length)];
          finalPortStr = `:${randomPort}`;
        }
        return {
          rawUrl: `${prefix}${data.addr}${finalPortStr}${params}#${data.remark}`,
          addr: data.addr,
          port: finalPortStr.substring(1),
          remark: data.remark
        };
      });

      // 订阅输出模式 (Base64) -> 供客户端软件直接拉取
      if (isSubscribeMode) {
        const plainText = nodesInfo.map(n => n.rawUrl).join('\n');
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

      // 前端 API 响应模式 -> 返回 JSON 数据供单页异步渲染预览
      if (isJsonRequest) {
        return new Response(JSON.stringify({
          success: true,
          originalAddr: originalHost,
          sourceName: currentTarget.name,
          nodes: nodesInfo,
          subscribeLink: `${url.origin}${url.pathname}?source=${activeIndex}&template=${encodeURIComponent(template)}&format=base64`
        }), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    // ==========================================
    // 步骤 3：纯前端单页架构（HTML/CSS/JS 全内建）
    // ==========================================
    const selectOptions = sourceItems.map((item, idx) => {
      return `<option value="${idx}">${escapeHtml(item.name)}</option>`;
    }).join('');

    const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>VLESS 纯净多源转换面板</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 30px 15px; display: flex; justify-content: center; color: #1f2937; }
          .wrapper { max-width: 850px; width: 100%; display: flex; flex-direction: column; gap: 20px; }
          .card { background: #fff; padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
          h2 { margin: 0 0 15px 0; font-size: 20px; display: flex; align-items: center; gap: 8px; }
          label { font-size: 14px; font-weight: 600; color: #4b5563; display: block; margin-top: 15px; }
          select, textarea { width: 100%; margin: 8px 0 5px 0; padding: 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; background: #fff; }
          textarea { height: 100px; font-family: monospace; font-size: 12px; resize: vertical; }
          .btn-group { margin-top: 15px; }
          button { background: #3b82f6; color: #fff; border: none; padding: 13px 20px; border-radius: 6px; cursor: pointer; font-size: 15px; width: 100%; font-weight: bold; transition: background 0.2s; }
          button:hover { background: #2563eb; }
          
          /* 结果展示区域 - 默认隐藏 */
          #resultContainer { display: none; flex-direction: column; gap: 20px; }
          .sub-box { background: #eff6ff; border: 2px solid #3b82f6; padding: 15px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 15px; flex-wrap: wrap; margin-top: 10px; }
          .sub-link { flex: 1; word-break: break-all; font-family: monospace; font-size: 13px; color: #1d4ed8; background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #bfdbfe; user-select: all; }
          .copy-btn { background: #3b82f6; color: #fff; border: none; padding: 10px 18px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px; white-space: nowrap; transition: all 0.2s; max-width: 150px; }
          .copy-btn:hover { background: #2563eb; }
          
          table { width: 100%; border-collapse: collapse; margin-top: 15px; background: #fafafa; font-size: 14px; }
          th { background: #1f2937; color: #fff; padding: 12px 10px; text-align: left; }
          td { padding: 10px; border: 1px solid #e5e7eb; }
          pre { background: #1f2937; color: #f8fafc; padding: 15px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 10px 0 0 0; white-space: pre-wrap; word-break: break-all;}
          
          /* 诊断错误提示框 */
          .error-box { background: #fef2f2; border: 1px solid #fca5a5; color: #b91c1c; padding: 15px; border-radius: 8px; display: none; margin-top: 15px; }
          .error-box pre { background: #374151; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="card">
            <h2>🔗 VLESS 单页流式转换器</h2>
            
            <label for="sourceSelect">🗺️ 第一步：选择节点数据源</label>
            <select id="sourceSelect">
              ${selectOptions}
            </select>

            <label for="tpl">🚀 第二步：粘贴 1 个完整的 VLESS 模板节点</label>
            <textarea id="tpl" placeholder="vless://xxxx-xxxx-xxxx@1.2.3.4:443?type=ws&security=tls#原节点名"></textarea>
            
            <div class="btn-group">
              <button id="genBtn" onclick="processConversion()">立即替换并构建订阅</button>
            </div>

            <div id="errorDiagnostic" class="error-box"></div>
          </div>

          <div id="resultContainer">
            <div class="card">
              <h2>📥 自动化 Base64 订阅链接</h2>
              <div class="sub-box">
                <div class="sub-link" id="subLink"></div>
                <button class="copy-btn" id="copyBtn" onclick="copySubscriptionLink()">一键复制链接</button>
              </div>
            </div>

            <div class="card">
              <h2>✅ 实时节点生成预览 (<span id="nodeCount">0</span> 个)</h2>
              <p style="color:#6b7280; font-size:13px; margin: 0;">结构快照（443端口已应用智能随机重分配机制）：</p>
              <pre id="previewNode"></pre>
              
              <div style="overflow-x: auto;">
                <table>
                  <thead>
                    <tr>
                      <th style="width: 50px; text-align:center;">#</th>
                      <th>模板原地址</th>
                      <th>替换为新地址</th>
                      <th style="text-align: center; width: 80px;">分配端口</th>
                      <th>节点备注名称</th>
                    </tr>
                  </thead>
                  <tbody id="tableBody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <script>
          async function processConversion() {
            const btn = document.getElementById('genBtn');
            const tpl = document.getElementById('tpl').value.trim();
            const sourceIdx = document.getElementById('sourceSelect').value;
            const errorBox = document.getElementById('errorDiagnostic');
            const resContainer = document.getElementById('resultContainer');

            // 隐藏历史结果及错误
            errorBox.style.display = 'none';
            resContainer.style.display = 'none';

            if (!tpl.startsWith('vless://')) { 
              alert('格式有误！节点必须以 vless:// 作为协议开头。'); 
              return; 
            }

            btn.innerText = '正在远程调配并生成中...';
            btn.disabled = true;

            try {
              // 发起异步请求，带上 api=true 标识以索取 JSON 数据
              const apiUrl = '?source=' + sourceIdx + '&template=' + encodeURIComponent(tpl) + '&api=true';
              const response = await fetch(apiUrl);
              const data = await response.json();

              if (!response.ok || data.error) {
                showError(data.error || '请求异常', data.rawText);
                return;
              }

              // 渲染订阅链接及统计
              document.getElementById('subLink').innerText = data.subscribeLink;
              document.getElementById('nodeCount').innerText = data.nodes.length;
              document.getElementById('previewNode').innerText = data.nodes[0].rawUrl;

              // 渲染表格
              let rowsHtml = '';
              data.nodes.forEach((node, i) => {
                const portColor = node.port !== '443' ? 'color:#3b82f6; font-weight:bold;' : 'color:#4b5563;';
                rowsHtml += '<tr>' +
                  '<td style="text-align:center;">' + (i + 1) + '</td>' +
                  '<td style="font-family:monospace; color:#dc2626; text-decoration:line-through;">' + escapeHtml(data.originalAddr) + '</td>' +
                  '<td style="font-family:monospace; color:#16a34a; font-weight:bold; word-break:break-all;">' + escapeHtml(node.addr) + '</td>' +
                  '<td style="font-family:monospace; text-align:center; ' + portColor + '">' + node.port + '</td>' +
                  '<td>' + escapeHtml(node.remark) + '</td>' +
                  '</tr>';
              });
              document.getElementById('tableBody').innerHTML = rowsHtml;
              
              // 顺滑展示结果
              resContainer.style.display = 'flex';
            } catch (err) {
              showError('脚本内部或网络通讯故障：' + err.message);
            } finally {
              btn.innerText = '立即替换并构建订阅';
              btn.disabled = false;
            }
          }

          function showError(message, rawText = '') {
            const errorBox = document.getElementById('errorDiagnostic');
            let html = '<strong>⚠️ 数据拉取或识别失败：</strong><br>' + escapeHtml(message);
            if (rawText) {
              html += '<br><b>远端接口返回原始文本片段预览：</b><pre>' + escapeHtml(rawText.substring(0, 800)) + '</pre>';
            }
            errorBox.innerHTML = html;
            errorBox.style.display = 'block';
          }

          function copySubscriptionLink() {
            const text = document.getElementById('subLink').innerText;
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.getElementById('copyBtn');
              btn.innerText = '已成功复制!';
              btn.style.background = '#16a34a';
              setTimeout(() => { 
                btn.innerText = '一键复制链接'; 
                btn.style.background = '#3b82f6'; 
              }, 2000);
            }).catch(() => alert('复制失败，请手动双击链接选择复制。'));
          }

          function escapeHtml(text) {
            if (!text) return '';
            return text.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
