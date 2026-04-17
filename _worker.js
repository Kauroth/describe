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
      font-family: "Microsoft YaHei", sans-serif;
      box-sizing: border-box;
      outline: none;
      background-color: #f9fafb;
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
  <img src="https://raw.githubusercontent.com/你的用户名/你的仓库名/main/你的图片路径.jpg" alt="Full Screen">

  <div class="glass">
    <div class="glass-mask">
      <div class="glass-title">订阅转换</div>
      
      <div class="box-container">
        <textarea id="input-box" placeholder="请输入原始订阅链接..."></textarea>
        <textarea id="output-box" placeholder="点击此处复制内容" readonly></textarea>
      </div>
    </div>
  </div>

  <script>
    var inputBox = document.getElementById('input-box');
    var outputBox = document.getElementById('output-box');

    // 清洗无效的控制字符（保留正常换行）
    function cleanStr(str) {
      return String(str).replace(/[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, '');
    }

    // 解析 VLESS
    function parseVless(line) {
      line = line.trim();
      if (!line.startsWith('vless://')) return null;
      try {
        var hashIndex = line.lastIndexOf('#');
        var name = '未命名节点';
        var mainPart = line;
        if (hashIndex !== -1) {
          name = decodeURIComponent(line.substring(hashIndex + 1));
          mainPart = line.substring(0, hashIndex);
        }
        var withoutProtocol = mainPart.substring(8);
        var atIndex = withoutProtocol.indexOf('@');
        if (atIndex === -1) return null;
        var uuid = withoutProtocol.substring(0, atIndex);
        var addrAndParams = withoutProtocol.substring(atIndex + 1);
        var queryIndex = addrAndParams.indexOf('?');
        var address = '';
        var port = '';
        var params = {};
        if (queryIndex !== -1) {
          var addrPort = addrAndParams.substring(0, queryIndex);
          var queryString = addrAndParams.substring(queryIndex + 1);
          var lastColonIndex = addrPort.lastIndexOf(':');
          if (lastColonIndex !== -1) {
            address = addrPort.substring(0, lastColonIndex);
            port = addrPort.substring(lastColonIndex + 1);
          } else {
            address = addrPort;
          }
          var pairs = queryString.split('&');
          for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i];
            var eqIndex = pair.indexOf('=');
            if (eqIndex !== -1) {
              var key = decodeURIComponent(pair.substring(0, eqIndex));
              var val = decodeURIComponent(pair.substring(eqIndex + 1));
              params[key] = val;
            }
          }
        } else {
          var lci = addrAndParams.lastIndexOf(':');
          if (lci !== -1) {
            address = addrAndParams.substring(0, lci);
            port = addrAndParams.substring(lci + 1);
          } else {
            address = addrAndParams;
          }
        }
        return {
          name: name, address: address, port: port, uuid: uuid,
          network: params.type || 'tcp', security: params.security || 'none',
          sni: params.sni || '', host: params.host || '', path: params.path || ''
        };
      } catch (e) {
        return null;
      }
    }

    // 格式化输出（全部用单引号拼接，避免和外层冲突）
    function formatNode(node) {
      var str = '【' + cleanStr(node.name) + '】\\n' +
                '协议：VLESS\\n' +
                '地址：' + cleanStr(node.address) + '\\n' +
                '端口：' + cleanStr(node.port) + '\\n' +
                'UUID：' + cleanStr(node.uuid) + '\\n' +
                '传输协议：' + cleanStr(node.network);
      if (node.path) str += '\\n路径：' + cleanStr(node.path);
      str += '\\n底层安全：' + cleanStr(node.security);
      if (node.sni) str += '\\nSNI：' + cleanStr(node.sni);
      if (node.host && node.host !== node.sni) str += '\\nHost：' + cleanStr(node.host);
      return str;
    }

    // 监听输入
    inputBox.addEventListener('input', function() {
      var lines = this.value.split('\\n');
      var result = [];
      for (var i = 0; i < lines.length; i++) {
        var node = parseVless(lines[i]);
        if (node) {
          result.push(formatNode(node));
        }
      }
      outputBox.value = result.join('\\n\\n--------------------\\n\\n');
    });

    // 监听复制
    outputBox.addEventListener('click', function() {
      var textToCopy = outputBox.value;
      if (!textToCopy) return;
      try {
        navigator.clipboard.writeText(textToCopy);
      } catch (err) {
        outputBox.select();
        document.execCommand('copy');
      }
      var originalValue = outputBox.value;
      outputBox.value = "✅ 已复制到剪贴板！";
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
    return new Response(HTML_CONTENT, {
      headers: { "content-type": "text/html;charset=UTF-8" }
    });
  }
};
