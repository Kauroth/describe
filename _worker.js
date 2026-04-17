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
        <textarea id="input-box" placeholder="支持粘贴 vless:// 链接 或 Base64 订阅内容..."></textarea>
        <textarea id="output-box" placeholder="生成的 Clash 订阅链接将在这里显示（点击复制）" readonly></textarea>
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
      inputBox.placeholder = '环境变量异常';
      outputBox.value = '⚠️ 环境变量未生效！请在 Pages 设置中添加 DOMAIN 并重试部署！';
    } else if (DOMAINS_RAW && DOMAINS_RAW !== '__DOMAINS__') {
      domainList = DOMAINS_RAW.split(',').map(function(d) { return d.trim(); }).filter(function(d) { return d.length > 0; });
      outputBox.style.color = '#333'; 
    }

    // 清除不可见控制字符
    function cleanStr(str) {
      return String(str).replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, '');
    }

    // 安全解码 Base64（兼容中文 UTF-8）
    function decodeBase64(str) {
      try {
        var binary = atob(str);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        return null;
      }
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
        var address = '', port = '', params = {};
        if (queryIndex !== -1) {
          var addrPort = addrAndParams.substring(0, queryIndex);
          var queryString = addrAndParams.substring(queryIndex + 1);
          var lastColonIndex = addrPort.lastIndexOf(':');
          if (lastColonIndex !== -1) { address = addrPort.substring(0, lastColonIndex); port = addrPort.substring(lastColonIndex + 1); }
          else { address = addrPort; }
          var pairs = queryString.split('&');
          for (var i = 0; i < pairs.length; i++) {
            var eqIndex = pairs[i].indexOf('=');
            if (eqIndex !== -1) { params[decodeURIComponent(pairs[i].substring(0, eqIndex))] = decodeURIComponent(pairs[i].substring(eqIndex + 1)); }
          }
        } else {
          var lci = addrAndParams.lastIndexOf(':');
          if (lci !== -1) { address = addrAndParams.substring(0, lci); port = addrAndParams.substring(lci + 1); }
          else { address = addrAndParams; }
        }
        return { name, address, port, uuid, params };
      } catch (e) { return null; }
    }

    // 生成 Clash YAML
    function buildClashYaml(node, newAddress) {
      var p = node.params;
      var type = (p.type || 'tcp').toLowerCase();
      if (type === 'splithttp') type = 'xhttp';
      
      // 转义节点名里的双引号，防止破坏 YAML 结构
      var safeName = node.name.replace(/"/g, '\\"');

      var yaml = '  - name: "' + safeName + '_' + newAddress + '"\\n';
      yaml += '    type: vless\\n';
      yaml += '    server: ' + newAddress + '\\n';
      yaml += '    port: ' + node.port + '\\n';
      yaml += '    uuid: ' + node.uuid + '\\n';
      
      if (p.flow) yaml += '    flow: ' + p.flow + '\\n';
      yaml += '    network: ' + type + '\\n';
      yaml += '    tls: ' + (p.security === 'tls' || p.security === 'reality') + '\\n';
      yaml += '    udp: true\\n';
      
      if (p.sni) yaml += '    servername: ' + p.sni + '\\n';
      if (p.fp) yaml += '    client-fingerprint: ' + p.fp + '\\n';

      if (p.security === 'reality') {
        yaml += '    reality-opts:\\n';
        if (p.pbk) yaml += '      public-key: ' + p.pbk + '\\n';
        if (p.sid) yaml += '      short-id: ' + p.sid + '\\n';
      }

      if (type === 'xhttp') {
        yaml += '    xhttp-opts:\\n';
        yaml += '      path: "' + (p.path || '/') + '"\\n';
        yaml += '      mode: "' + (p.mode || 'auto') + '"\\n';
        if (p.host) yaml += '      host: ' + p.host + '\\n';
      } else if (type === 'ws') {
        yaml += '    ws-opts:\\n';
        yaml += '      path: "' + (p.path || '/') + '"\\n';
        if (p.host) yaml += '      headers:\\n        Host: ' + p.host + '\\n';
      } else if (type === 'grpc') {
        yaml += '    grpc-opts:\\n';
        if (p.serviceName) yaml += '      grpc-service-name: "' + p.serviceName + '"\\n';
      } else if (type === 'h2') {
        yaml += '    h2-opts:\\n';
        yaml += '      path: "' + (p.path || '/') + '"\\n';
        if (p.host) yaml += '      host:\\n        - ' + p.host + '\\n';
      }
      
      return yaml;
    }

    // 监听输入
    inputBox.addEventListener('input', function() {
      if (domainList.length === 0) return;
      var rawInput = cleanStr(this.value.trim());
      if (!rawInput) { outputBox.value = ''; return; }

      var actualText = rawInput;

      // 智能识别：如果不是 vless:// 开头，尝试当 Base64 解码
      if (!rawInput.startsWith('vless://')) {
        var decoded = decodeBase64(rawInput);
        if (decoded && decoded.includes('vless://')) {
          actualText = decoded;
        }
      }

      // 兼容不同系统的换行符进行分割
      var lines = actualText.split(/\\r?\\n/);
      var yamlProxies = '';

      for (var i = 0; i < lines.length; i++) {
        var node = parseVless(lines[i]);
        if (!node) continue;

        for (var j = 0; j < domainList.length; j++) {
          yamlProxies += buildClashYaml(node, domainList[j]) + '\\n';
        }
      }

      if (!yamlProxies) {
        outputBox.value = '未检测到有效的 VLESS 链接（请确认输入的是 VLESS 节点或 Base64）';
        return;
      }

      var finalYaml = 'proxies:\\n' + yamlProxies;

      try {
        var encodedStr = encodeURIComponent(finalYaml).replace(/%([0-9A-F]{2})/g, function(match, p1) {
          return String.fromCharCode('0x' + p1);
        });
        var base64Str = btoa(encodedStr);
        
        var currentUrl = window.location.origin + window.location.pathname;
        outputBox.value = currentUrl + '?sub=' + encodeURIComponent(base64Str);
      } catch (e) {
        outputBox.value = '生成订阅链接失败';
      }
    });

    outputBox.addEventListener('click', function() {
      var textToCopy = outputBox.value;
      if (!textToCopy || textToCopy.startsWith('⚠') || textToCopy.startsWith('未') || !textToCopy.startsWith('http')) return;

      try { navigator.clipboard.writeText(textToCopy); } catch (err) { outputBox.select(); document.execCommand('copy'); }
      var originalValue = outputBox.value;
      outputBox.value = "✅ Clash 订阅链接已复制！";
      setTimeout(function() { outputBox.value = originalValue; }, 1500);
    });
  </script>
</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.searchParams.has('sub')) {
      const base64Data = url.searchParams.get('sub');
      return new Response(base64Data, {
        headers: { "content-type": "text/plain;charset=UTF-8" }
      });
    }

    const domainStr = env.DOMAIN || "";
    if (!domainStr) {
      const errorHtml = HTML_CONTENT.replace('__DOMAINS__', 'ERROR_NO_ENV');
      return new Response(errorHtml, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    const safeDomainStr = domainStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const finalHtml = HTML_CONTENT.replace('__DOMAINS__', safeDomainStr);

    return new Response(finalHtml, { headers: { "content-type": "text/html;charset=UTF-8" } });
  }
};
