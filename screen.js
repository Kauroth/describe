// screen.js
export const getHtml = () => `
  <!DOCTYPE html>
  <html lang="zh">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>订阅转换</title>
    <style>
      body, html {
        margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #000;
      }
      img {
        width: 100vw; height: 100vh; object-fit: cover; display: block;
      }
      /* 👇 毛玻璃遮罩层 */
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
        inset: 3%;
        background: rgba(255, 255, 255, 0.85);
        border-radius: 12px;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 15%;
        box-sizing: border-box;
      }
      .glass-title {
        color: #1a6dff;
        font-size: 40px;
        font-weight: bold;
        font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
        letter-spacing: 4px;
      }
    </style>
  </head>
  <body>
    <img src="https://raw.githubusercontent.com/Kauroth/describe-convert/refs/heads/Kauroth/pic.png" alt="Full Screen">
    <div class="glass">
      <div class="glass-mask">
        <div class="glass-title">订阅转换</div>
  </body>
  </html>
`;
