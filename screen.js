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

      /* 👇 包裹两个文本框的容器 */
      .box-container {
      width: 90%;             /* 容器宽度占遮罩的90% */
      flex-grow: 1;           /* 自动占满标题下方的所有剩余高度 */
      display: flex;
      flex-direction: column; /* 上下两个文本框排列 */
      gap: 15px;              /* 两个文本框之间的间距 */
      padding-bottom: 5%;     /* 底部留点边距 */
    }
    /* 👇 文本框通用样式 */
      textarea {
      width: 100%;
      flex-grow: 1;           /* 上下文本框平分高度 */
      resize: none;           /* 禁止手动拖拽改变大小 */
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
      border-color: #1a6dff;  /* 输入焦点时边框变蓝色 */
      background-color: #fff;
    }
    /* 输出框因为是只读，背景稍微灰一点区分 */
    #output-box {
      background-color: #f0f2f5;
      cursor: default;
    }
    </style>
  </head>
  <body>
    <img src="https://raw.githubusercontent.com/Kauroth/describe/refs/heads/main/pic.png" alt="Full Screen">
    <div class="glass">
      <div class="glass-mask">
        <div class="glass-title">订阅转换</div>
        <div class="box-container">
          <textarea id="input-box" placeholder="请输入订阅链接"></textarea>
          <textarea id="output-box" readonly placeholder="转换结果"></textarea>
        </div>
      </div>
    </div>
  </body>
  </html>
`;
