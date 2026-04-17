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
      color: #d93025;
    }
  </style>
</head>
<body>
  <img src="https://bing.img.run/1920x1080.php" alt="Bing Wallpaper">

  <div class="glass">
    <div class="glass-mask">
      <div class="glass-title">订阅转换</div>
      
      <div class="box-container">
        <textarea id="input-box" placeholder="请输入原始 VLESS 节点链接（支持多行批量）..."></textarea>
        <textarea id="output-box" placeholder="生成的订阅链接将在这里显示（点击复制）" readonly></textarea>
      </div>
    </div>
  </div>

  <script>
    var DOMAINS_RAW = '__DOMAINS__';
    var domainList = [];
    var inputBox = document.getElementById('input-box');
    var outputBox = document.getElementById('output-box');

    if (DOMAINS_RAW === 'ERROR_NO_ENV') {
      inputBox.disabled = true;
      inputBox.placeholder = '环境变量异常，无法输入';
      outputBox.value = '⚠️ 环境变量未生效！请检查 Pages【设置 -> 环境变量】是否添加了 DOMAIN，并务必【重试部署】！';
    } else if (DOMAINS_RAW && DOMAINS_RAW !== '__DOMAINS__') {
      domainList = DOMAINS_RAW.split(',').map(function(d) { return d.trim(); }).filter(function(d) { return d.length > 0; });
      outputBox.style.color = '#333'; 
    } else {
      outputBox.value = '请在环境变量中配置 DOMAIN';
    }

    inputBox.addEventListener('input', function() {
      if (domainList.length === 0) return;

      var inputText = this.value.trim();
      if (!inputText) {
        outputBox.value = '';
        return;
      }

      var lines = inputText.split('\\n');
      var newLinks = [];

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('vless://')) continue;

        var hashIndex = line.lastIndexOf('#');
        var name = '';
        var mainPart = line;
        if (hashIndex !== -1) {
          name = line.substring(hashIndex); 
          mainPart = line.substring(0, hashIndex);
        }

        var atIndex = mainPart.indexOf('@');
        if (atIndex === -1) continue;
        
        var prefix = mainPart.substring(0, atIndex + 1); 
        var suffix = mainPart.substring(atIndex + 1);     

        var addrEndIndex = -1;
        var colonIndex = suffix.indexOf(':');
        var questionIndex = suffix.indexOf('?');

        if (colonIndex !== -1) {
          addrEndIndex = colonIndex; 
        } else if (questionIndex !== -1) {
          addrEndIndex = questionIndex; 
        } else {
          addrEndIndex = suffix.length; 
        }

        if (addrEndIndex <= 0) continue;

        var restSuffix = suffix.substring(addrEndIndex); 

        for (var j = 0; j < domainList.length; j++) {
          var newLink = prefix + domainList[j] + restSuffix + name;
          newLinks.push(newLink);
        }
      }

      if (newLinks.length === 0) {
        outputBox.value = '未检测到有效的 VLESS 链接';
        return;
      }

      var finalStr = newLinks.join('\\n');

      try {
        var encodedStr = encodeURIComponent(finalStr).replace(/%([0-9A-F]{2})/g, function(match, p1) {
          return String.fromCharCode('0x' + p1);
        });
        var base64Str = btoa(encodedStr);
        
        // 👇 核心改变：拼接成当前页面的 URL 链接
        var currentUrl = window.location.origin + window.location.pathname;
        var subUrl = currentUrl + '?sub=' + encodeURIComponent(base64Str);
        
        outputBox.value = subUrl;
      } catch (e) {
        outputBox.value = '生成订阅链接失败';
      }
    });

    outputBox.addEventListener('click', function() {
      var textToCopy = outputBox.value;
      // 只有看起来像 URL 的时候才允许复制
      if (!textToCopy || textToCopy.startsWith('⚠') || textToCopy.startsWith('请') || textToCopy.startsWith('未') || !textToCopy.startsWith('http')) return;

      try {
        navigator.clipboard.writeText(textToCopy);
      } catch (err) {
        outputBox.select();
        document.execCommand('copy');
      }
      var originalValue = outputBox.value;
      outputBox.value = "✅ 订阅链接已复制！可粘贴到客户端";
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
    const url = new URL(request.url);

    // ==========================================
    // 拦截订阅请求：如果 URL 里带有 ?sub= 参数
    // ==========================================
    if (url.searchParams.has('sub')) {
      const base64Data = url.searchParams.get('sub');
      // 直接返回纯文本的 Base64，不包裹任何 HTML
      return new Response(base64Data, {
        headers: {
          "content-type": "text/plain;charset=UTF-8"
        }
      });
    }

    // ==========================================
    // 正常访问：返回前端 HTML 页面
    // ==========================================
    const domainStr = env.DOMAIN || "";

    if (!domainStr) {
      const errorHtml = HTML_CONTENT.replace('__DOMAINS__', 'ERROR_NO_ENV');
      return new Response(errorHtml, {
        headers: { "content-type": "text/html;charset=UTF-8" }
      });
    }

    const safeDomainStr = domainStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const finalHtml = HTML_CONTENT.replace('__DOMAINS__', safeDomainStr);

    return new Response(finalHtml, {
      headers: { "content-type": "text/html;charset=UTF-8" }
    });
  }
};
