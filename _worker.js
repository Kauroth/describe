// _worker.js
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>优选订阅生成器</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #000;
    }
    img {
      width: 100vw;
      height: 100vh;
      object-fit: cover;
      display: block;
    }
    .glass {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 60%;
      height: 60%;
      background: rgba(255, 255, 255, 0.35);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.4);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    .glass-mask {
      position: absolute;
      inset: 5%;
      background: rgba(255, 255, 255, 0.85);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 5%;
      box-sizing: border-box;
    }
    .glass-title {
      color: #1a6dff;
      font-size: 40px;
      font-weight: bold;
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
      letter-spacing: 4px;
      margin-bottom: 20px;
    }
    .box-container {
      width: 90%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 15px;
      padding-bottom: 5%;
    }
    textarea {
      width: 100%;
      flex-grow: 1;
      resize: none;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      padding: 15px;
      font-size: 16px;
      font-family: "Consolas", "Microsoft YaHei", monospace;
      box-sizing: border-box;
      outline: none;
      background-color: #f9fafb;
      word-break: break-all;
    }
    textarea:focus {
      border-color: #1a6dff;
      background-color: #fff;
    }
    #output-box {
      background-color: #f0f2f5;
      cursor: pointer; 
    }
  </style>
</head>
<body>
  <img src="https://bing.img.run/rand_uhd.php" alt="Full Screen">

  <div class="glass">
    <div class="glass-mask">
      <div class="glass-title">订阅转换</div>
      
      <div class="box-container">
        <textarea id="input-box" placeholder="请输入原始 VLESS 节点链接（支持多行批量）..."></textarea>
        <textarea id="output-box" placeholder="生成的 Base64 订阅链接将在这里显示（点击复制）" readonly></textarea>
      </div>
    </div>
  </div>

  <script>
    // 注意：这里的 __DOMAINS__ 会被后端 Worker 替换为真实的域名
    var DOMAINS_RAW = '__DOMAINS__';
    var domainList = [];

    if (DOMAINS_RAW && DOMAINS_RAW !== '__DOMAINS__') {
      domainList = DOMAINS_RAW.split(',').map(function(d) { return d.trim(); }).filter(function(d) { return d.length > 0; });
    }

    var inputBox = document.getElementById('input-box');
    var outputBox = document.getElementById('output-box');

    inputBox.addEventListener('input', function() {
      var inputText = this.value.trim();

      if (domainList.length === 0) {
        outputBox.value = '请在 Cloudflare Workers 环境变量中配置 DOMAIN';
        return;
      }

      if (!inputText) {
        outputBox.value = '';
        return;
      }

      var lines = inputText.split('\\n');
      var newLinks = [];

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('vless://')) continue;

        // 分离节点名称 (# 后面的部分)
        var hashIndex = line.lastIndexOf('#');
        var name = '';
        var mainPart = line;
        if (hashIndex !== -1) {
          name = line.substring(hashIndex); // 包含 '#'
          mainPart = line.substring(0, hashIndex);
        }

        // 找到 @ 符号，分离 UUID 和 地址端口参数
        var atIndex = mainPart.indexOf('@');
        if (atIndex === -1) continue;
        
        var prefix = mainPart.substring(0, atIndex + 1); // "vless://uuid@"
        var suffix = mainPart.substring(atIndex + 1);     // "ip:port?params"

        // 找到地址结束的位置（遇到冒号端口 或 问号参数 即结束）
        var addrEndIndex = -1;
        var colonIndex = suffix.indexOf(':');
        var questionIndex = suffix.indexOf('?');

        if (colonIndex !== -1) {
          addrEndIndex = colonIndex; // 有端口，地址在冒号前结束
        } else if (questionIndex !== -1) {
          addrEndIndex = questionIndex; // 无端口有参数，地址在问号前结束
        } else {
          addrEndIndex = suffix.length; // 都没有，整个后缀就是地址
        }

        if (addrEndIndex <= 0) continue;

        var restSuffix = suffix.substring(addrEndIndex); // ":port?params" 或 "?params" 或 ""

        // 将预设的每一个域名替换进去，生成新链接
        for (var j = 0; j < domainList.length; j++) {
          var newLink = prefix + domainList[j] + restSuffix + name;
          newLinks.push(newLink);
        }
      }

      if (newLinks.length === 0) {
        outputBox.value = '未检测到有效的 VLESS 链接';
        return;
      }

      // 多条链接用换行符拼接
      var finalStr = newLinks.join('\\n');

      // 转换为 Base64（处理中文节点名的 UTF-8 编码问题）
      try {
        var encodedStr = encodeURIComponent(finalStr).replace(/%([0-9A-F]{2})/g, function(match, p1) {
          return String.fromCharCode('0x' + p1);
        });
        outputBox.value = btoa(encodedStr);
      } catch (e) {
        outputBox.value = 'Base64 编码失败';
      }
    });

    // 点击输出框复制
    outputBox.addEventListener('click', function() {
      var textToCopy = outputBox.value;
      if (!textToCopy || textToCopy.startsWith('请') || textToCopy.startsWith('未')) return;

      try {
        navigator.clipboard.writeText(textToCopy);
      } catch (err) {
        outputBox.select();
        document.execCommand('copy');
      }
      var originalValue = outputBox.value;
      outputBox.value = "✅ 已复制 Base64 到剪贴板！";
      setTimeout(function() {
        outputBox.value = originalValue;
      }, 1500);
    });
  </script>
</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    // 1. 从 Cloudflare 环境变量获取 DOMAIN
    const domainStr = env.DOMAIN || "";

    // 2. 转义单引号，防止破坏前端 JS 语法
    const safeDomainStr = domainStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    // 3. 将占位符替换为真实域名
    const finalHtml = HTML_CONTENT.replace('__DOMAINS__', safeDomainStr);

    return new Response(finalHtml, {
      headers: { "content-type": "text/html;charset=UTF-8" }
    });
  }
};
