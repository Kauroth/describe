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
  <!-- 记得把下面这行 src 换成你真实的图片链接 -->
  <img src="https://raw.githubusercontent.com/Kauroth/describe/refs/heads/main/pic.png" alt="Full Screen">

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
    const inputBox = document.getElementById('input-box');
    const outputBox = document.getElementById('output-box');

    inputBox.addEventListener('input', function() {
      outputBox.value = this.value;
      outputBox.placeholder = "点击此处复制内容";
    });

    outputBox.addEventListener('click', async function() {
      const textToCopy = this.value;
      if (!textToCopy) return;

      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch (err) {
        this.select();
        document.execCommand('copy');
      }

      const originalValue = this.value;
      this.value = "✅ 已复制到剪贴板！";

      setTimeout(() => {
        this.value = originalValue;
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
