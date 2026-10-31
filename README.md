# Describe_Convert

优选地址转换器 + 节点编辑器。把模板节点的 IP / 端口换掉，一次产出所有源的订阅；
页面上也能直接编辑单个节点，实时出链接、出分享订阅。

支持 **vless / vmess / trojan / ss / hysteria2**（模板还额外认 tuic / anytls，走通用换址）。

## 页面

打开站点根路径：

- **节点编辑**：选协议 → 填地址、端口、UUID、Host、SNI、Path 等 → 下方实时显示链接。
  也可以把现成节点粘进输入框点「解析」，协议和字段自动对齐。
- **字段跟着工况变**：每种协议只渲染自己有的项，条件不满足的字段**根本不存在**，
  不是藏起来。传输方式选 tcp 时没有 `path`/`host`，选 xhttp 才有 `mode`/`extra`，
  `security` 选 reality 才有 `pbk`/`sid`，gRPC 才有 `serviceName`，
  hysteria2 开了 salamander 才有混淆密码。一组字段全空时，连分组标题都不画。
  值本身不丢：切回原来的组合，填过的内容原样回来。
- 表单分三块：基本信息 / 传输与伪装 / 高级参数（默认折叠，解析到高级参数时自动展开）。
- xhttp 的 `extra`（xmux 那串 JSON）、`insecure`、`allowInsecure` 都有专字段；
  不认识的参数也不会丢——解析时原样透传，改地址改端口它们跟着走。
- **生成分享链接**：把当前节点编码进 `?share=`，得到一条能直接导入客户端的订阅地址。
  不依赖任何服务端配置，生成后随参数自动更新。
- **批量优选**：粘一个模板节点，按源列表逐个换上优选 IP，一键出所有订阅链接。

## 环境变量

两种配法，`ADDR` 有值就以它为准；`ADDR` 空着就把每条源单独放一个变量。

### 配法一：一个 ADDR 装全部

每行一个源，格式 `名称|地址`；名称可省略。同一条源可以给多个候选地址，用英文逗号分隔，
按顺序尝试，第一个返回 200 的生效，全挂了才报错（错误里会带上是哪个 URL 挂的）。

```
移动优选|https://raw.githubusercontent.com/DustinWin/BestCF/refs/heads/bestcf/cmcc-ip.txt
电信优选|https://raw.githubusercontent.com/DustinWin/BestCF/refs/heads/bestcf/ctcc-ip.txt
手动优选|https://example.com/my-own-ip-list.txt,https://backup.example.com/list.txt
```

以 `#`、`//`、`;` 开头的行会被忽略，可以拿来注释。

### 配法二：一个源一个变量（推荐）

Cloudflare 后台的变量框是**单行输入**，粘进去的换行会被吃掉，几条源会粘成一整行，
被当成一个畸形 URL 直接 404。一源一变量最省事，每个变量的值写成 `名称|地址`：

| 变量名 | 值 |
|---|---|
| `CMCC` | `移动优选\|https://…/cmcc-ip.txt` |
| `CTCC` | `电信优选\|https://…/ctcc-ip.txt` |
| `MANUAL` | `手动优选\|https://text.cf.kauroth.top/nb_cmcc.txt?token=…` |

变量名只用来排序和标记来源，源的真实名字取的是值里 `|` 左边那段。
值里没有 `http` 的变量（`ASSETS`、`CF_PAGES_BRANCH` 这类）会被跳过，不用管。
`source=N` 的 N 按**变量名字母序**排，加变量会让后面的序号往后挪，改完记得核对 Sub-Store。

### 非要用单行 ADDR

三种写法都认，按你的输入框选一种：

```
# ① 真换行（wrangler.toml / API 部署时用这种）
移动优选|https://…/cmcc-ip.txt
电信优选|https://…/ctcc-ip.txt

# ② 字面量 \n，单行框里直接打两个字符：反斜杠 + n
移动优选|https://…/cmcc-ip.txt\n电信优选|https://…/ctcc-ip.txt

# ③ || 当分隔符
移动优选|https://…/cmcc-ip.txt||电信优选|https://…/ctcc-ip.txt
```

三种都没有时，程序还会兜一把：整段没有换行且有多个 `|`，就在「中文名 + `|`」处断行。
这个只对中文源名有效，ASCII 源名粘一起猜不出来——所以优先用 ② 或 ③。

不管用哪种写法，`/?sources=1` 都能看到实际拆出来几个源、各自叫什么、来自哪个变量。

池子每行一个地址，`IP#备注`；写成 `IP:端口#备注` 时以池子给的端口为准。
地址按出现顺序去重，重复的只留第一条。

## 路由

| 请求 | 作用 |
|---|---|
| `/` | 节点编辑器 + 批量优选页面（没有源也能打开，编辑器不依赖它） |
| `/?sources=1` | 看源解析成了什么（源名 + 来源变量 + 候选地址列表） |
| `/?probe=1` | 逐个候选地址实测 HTTP 状态码和行数，排障用 |
| `/?source=N&template=<节点>&format=base64` | 单个源的 base64 订阅（Sub-Store 用这个） |
| `/?source=N&template=<节点>&format=plain` | 同上，但返回明文节点列表 |
| `/?source=N&template=<节点>` | 返回 JSON（节点明细 + 订阅链接） |
| `/?all=true&template=<节点>` | 一次产出所有源（页面用） |
| `/?share=<b64url>` | 把编码的节点转成 base64 订阅 |

`source=N` 越界会直接返回 400 并列出真实存在的源名，不再静默退回到源 0。

端口规则：池子给了端口就用池子的；没给且模板端口是 443 时，按地址哈希从
`443 / 2053 / 2083 / 2087 / 2096 / 8443` 里挑一个——同一个 IP 每次拿到的结果都一样，
订阅刷新不会导致节点端口乱跳。

## 排障

订阅拉到 400 时先打 `/?probe=1`：哪个地址 404、哪条链是空的，一眼就能看到。
`/?sources=1` 里 `count` 是几，就说明程序认出了几个源——数字不对先查变量怎么填的。

本地自测：

```bash
node test_worker.mjs
```

覆盖页面内联脚本语法、ADDR 三种单行写法、一源一变量、候选回退、五种协议换址、
分享链接往返、越界与死链报错，共 58 项。
