# dsh-mobile-bridge —— 用手机和这台电脑上的 DSH 对话

结论先说：**可以**。手机连同一个 Wi-Fi，浏览器打开 `http://<电脑局域网IP>:8099/`，
就是这台电脑上正在跑的那一个 DSH WebUI（同一个实例、同一批会话、同一条正在进行的对话，能实时看到流式输出）。

本目录里的 `bridge.cjs` 就是让它成立的那座小桥。

---

## 一、为什么不能直接把 3080 暴露出去

`dsh web` 有两条设计上的硬约束（都在产品源码里，不是配置问题）：

1. **只监听回环地址**：`--host 0.0.0.0` 被显式拒绝。
   源码原文：`--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network`。
   WebUI 等价于本机 shell 权限，上游故意不让它上网。
2. **两把锁**：
   - 认证：首页需要一次性 token 换来的签名 cookie，且 cookie 是**按来源 `host:port` 签名**的 —— 换个 IP、换个端口都要重新认证；
   - 信任栅栏：所有 `/api` 请求必须来自「回环地址 / 已声明的可信来源」，否则一律 **403**。

所以「路由器端口映射 3080」和「在 3081 上再开一个实例」都不行：前者根本连不上，
后者虽然能开页面，但 cookie 与栅栏仍然按来源判定，手机侧还是得到 403。

## 二、这座桥做了什么

```
手机浏览器  --HTTP-->  bridge.cjs (0.0.0.0:8099)  --HTTP-->  dsh web (127.0.0.1:3080)
```

- 监听局域网端口，把每个请求原样转发给回环上的真实实例；
- 转发时**按手机看到的 authority 现场签发一枚合法的 dsh 会话 cookie**（签名密钥读自 `~/.dsh/.credentials.yaml`），
  所以手机上不需要任何登录动作；
- `Host` 头保持手机真实的 `IP:端口`，上游栅栏用 `--trusted-host` 登记后即放行（下方第 3 步）；
- 请求体/响应体全程流式管道转发（含 upgrade 隧道），所以 WebUI 的实时刷新照常。

## 三、默认端口与文件

| 文件 | 作用 |
| --- | --- |
| `bridge.cjs` | 桥本体（纯 Node 内置模块，零依赖） |
| `mobile-tweaks.css` / `mobile-tweaks.js` | 注入到手机页面的移动端适配（见 §9.2），**改完存盘即生效，不用重启桥** |
| `start-bridge-hidden.vbs` | 隐藏启动 + 看门狗（计划任务与启动项都指向它，见 §9.5） |
| `device-settings.json` | 各设备**独享**的语言/外观/字号（见 §9.4）+ 被踢出的设备名单，自动生成 |
| `mobile-panel.js` | 客户端插件：设置里的「手机端」面板（二维码 + 设备管理，见 §9.6），**改完存盘刷新页面即可** |
| `vendor/qrcode-generator.js` | 二维码生成（MIT，Kazuhiko Arase），vendored 进来以保持零 npm 依赖 |
| `bridge.log` | 运行日志（启动/监听/异常/退出码/设备设置变更，>1MB 自动清空） |
| `allow-firewall.ps1` | 放行入站端口（**仅限本机所在网段**），需管理员 |
| `start-bridge.cmd` / `stop-bridge.cmd` | 双击启动 / 停止（停之前会先结束计划任务，否则看门狗会把它拉回来） |

桥端口默认 **8099**，可用 `--port` 或环境变量 `DSH_BRIDGE_PORT` 改；
上游地址默认 `http://127.0.0.1:3080`，可用 `--target` / `DSH_BRIDGE_TARGET` 改。

## 四、用起来（4 步）

### 1) 启动桥

**这台机器已经装好自启动了**（计划任务 `DSH Mobile Bridge` + 启动项），登录即开，一般不用手动启动；
运行日志看同目录 `bridge.log`。手动启动/停止见 §9.5。

手动前台跑（调试用）：

```bat
cd "<你放 dsh-mobile-bridge 的目录>"
node bridge.cjs
```

或双击 `start-bridge.cmd`（保持窗口开着）。启动后会打印手机可用的网址。

### 2) 放行防火墙（只需一次，需管理员）

```powershell
powershell -ExecutionPolicy Bypass -File allow-firewall.ps1        # 放行 8099
powershell -ExecutionPolicy Bypass -File allow-firewall.ps1 -Remove  # 撤销
```

脚本会把规则的「远程地址」限制为本机各网卡所在的网段，即使路由器做了公网端口映射也匹配不上。
第一次 `bridge.cjs` 监听 `0.0.0.0` 时 Windows 可能弹「防火墙已阻止部分功能」，勾选**专用网络**并允许。

### 3) 让 WebUI 信任手机侧的来源（需要重启一次 harness）

桌面版启动器 `dsh-desktop\launcher.ps1`（以及安装目录下那份）已经改好：
启动 `dsh web` 时会自动把每个网卡 IP + 桥端口登记为 `--trusted-host`。

**改动在「下一次启动 harness」时生效**，所以选一个方便的时候重启：

- 托盘图标右键 → 退出，然后重新双击桌面上的「DeepSeek Harness」；或
- 关掉当前窗口再从快捷方式启动。

（如果当前会话正忙，不急 —— 桥可以先开着，手机上会看到页面但 `/api` 仍然 403，重启后就通了。）

### 4) 手机打开

手机连**同一个 Wi-Fi**，浏览器输入启动时打印的网址，例如：

```
http://192.168.1.10:8099/
```

先看到一张「DSH 手机接入」小卡片，点「打开 WebUI」即进入完整界面。
想当 APP 用：浏览器菜单 →「添加到主屏幕」（页面自带 manifest）。

## 五、自检（不用手机也能查一半）

在电脑上跑这几条，逐条对照：

```powershell
# 1. 桥在监听
Get-NetTCPConnection -State Listen -LocalPort 8099 | Select LocalAddress,LocalPort

# 2. 局域网地址可达 + 首页 200（用真实 IP，不要用 127.0.0.1）
curl.exe -s -o NUL -w "%{http_code}`n" http://192.168.1.10:8099/

# 3. 栅栏是否已放行：404 = 已放行；403 = 还没重启 harness（或 --trusted-host 没生效）
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://192.168.1.10:8099/api/__probe__/nope -H "content-type: application/json" -d "{}"

# 4. dsh-api 也顺带能用了（可选）
curl.exe -s http://192.168.1.10:8099/api/v1/health -H "X-API-Key: dsh-api-demo-key"
```

手机侧症状对照：

| 手机看到 | 含义 | 处理 |
| --- | --- | --- |
| 一直转圈 / 打不开 | 防火墙或路由隔离 | 第 2 步防火墙；确认手机在**同一个** Wi-Fi（不是访客网络） |
| 页面出来了，但一直「连接中」/ 报错 | `/api` 403，栅栏还没放行 | 重启 harness（第 3 步） |
| 401 / 需要认证 | 桥没在转发（直连了 3080） | 检查地址端口是不是 8099 |

## 六、安全边界（务必知道）

- **这座桥不做登录**：能访问 8099 的人 = 直接拿到这台电脑的 shell 权限（文件读写、执行命令）。
  所以它只适合可信的家庭局域网，**不要**做公网端口映射、**不要**在公司/公共 Wi-Fi 上开。
- 想更稳妥：
  - 用完就 `stop-bridge.cmd`；
  - 或者只在需要时启动，并把 `allow-firewall.ps1` 的规则保持「仅本网段」；
  - 桥端口可以改（`--port`），改完记得同步重启 harness 让 `--trusted-host` 跟上。
- 换 Wi-Fi / 换网段后 IP 会变，需要重启一次 harness（启动器会自动登记当前网卡 IP）。

## 七、出门在外也想连？（远程方案，未实施）

局域网方案只在家里有效。要在家外访问，选一条：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **Tailscale / ZeroTier**（推荐） | 手机与电脑装同一虚拟局域网客户端，手机访问 `http://<虚拟IP>:8099/` | 需装客户端；地址变了要重启 harness 让 `--trusted-host` 跟着变 |
| **Cloudflare Tunnel / ngrok** | 把 8099 通过带登录的反向隧道发布出去 | 等于把 shell 权限暴露到公网，必须叠加强认证（Cloudflare Access / 隧道自身的 Basic Auth），且仍要 `--trusted-host` 登记隧道域名 |
| **dsh-api + 手机小程序/快捷指令** | 只用现成的 `/api/v1/tasks` 提交任务、轮询结果（见 `skills/dsh-api`） | 适合「发一条指令、取回复」的轻量场景，不是完整界面 |

需要的话告诉我走哪条，我来落地（隧道方案我会一并把 `--trusted-host` 与防火墙规则配好）。

## 八、实现细节（维护者看）

- **cookie 算法**（与 `dsh-desktop\launcher.ps1` 的精简版一致，已在 dsh 0.1.5-rc.1 上实测通过）：
  - 名字：`dsh-auth-` + base64url(sha256(`authority`))
  - 值：`v1.` + base64url(payload) + `.` + base64url(HMAC-SHA256(secret, payload))
  - payload：`{"version":1,"authority":"host:port","issuedAt":ms,"expiresAt":ms}`，有效期不得超过上游 `cookieMaxAgeDays`（默认 30 天）
  - secret：`~/.dsh/.credentials.yaml` 里的 `client-connection/browser-session.secret`（base64url，32 字节）
- **栅栏判定**（`dsh-client-connection`）：`Host` 是回环 → 放行；否则必须命中 `trustedHosts`；带 `Origin` 时还要求与 `Host` 同源。
- **为什么不改写 Host 为 127.0.0.1**：那样 cookie 得按 `127.0.0.1:3080` 签发（本可行），但页面里的同源校验、绝对地址与调试都会绕；保留真实 authority 最干净。
- **编码坑**（都踩过一遍，已修）：`.cmd` 里的 `echo` 只写 ASCII（cmd 的控制台代码页与 UTF-8 脚本不兼容，中文会变乱码）；带中文的 `.ps1` 必须存成 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 按 ANSI 解码直接报语法错误（`launcher.ps1` 与 `allow-firewall.ps1` 都已带 BOM，改动时请保留）。`.cjs` 则**不能**带 BOM（Node 会把 BOM 当成 shebang 前的一个非法字符）。
## 九、手机端相关（2026-10-06 补）

### 9.1 WebSocket 转发（关键修复）

页面里的实时连接是 **WebSocket**：`ws://<手机看到的地址>/api/remote.mux`。
升级请求必须把 `Connection: Upgrade` / `Upgrade: websocket` / `Sec-WebSocket-*` **原样送到上游**——
早期版本把它们当 hop-by-hop 头剥掉了，后果是：

```
WebSocket connection to 'ws://192.168.1.10:8099/api/remote.mux' failed: 404
[connection] connection lost, retry #1..#5        ← 界面右下角「自动重连中…」
```

症状是：页面能打开、但**工作区/会话列表始终「暂无会话」**。现在 upgrade 走
`forwardUpgradeHeaders()`（保留 Connection/Upgrade，只替换 Host/Cookie），实测
`/api/session/list` 200、控制台零错误、列表完整。

> 排查同类问题的办法：用无头浏览器打开桥的地址，抓控制台与 `/api/*` 响应——
> 见 `_checkpoints/_diag/mobile-bridge/cdp-probe.cjs`（打印页面文本、/api 状态码、网络失败、控制台）。

#### 9.1.1 隧道下 WebSocket 永远「自动重连中」的真因（2026-10-06 深夜修）

现象：经隧道打开时框架能加载，但工作区/会话内容出不来，一直「自动重连中…」；同一台手机在内网一切正常。

根因：`mintCookie(authority)` 的 **cookie 名与签名都由 authority 推导**（`dsh-auth-<sha256(authority)>`），
而 `server.on("upgrade")` 用的是**原始 Host**（隧道下是域名），HTTP 那条路用的是 `upstreamAuthority(req)`（归一化后的局域网 authority）。
于是隧道下签出的 cookie 名和上游期望的对不上 ⇒ harness 把握手当未认证请求丢掉 ⇒ 客户端无限重连。
内网时两者恰好相同，所以只用内网测永远发现不了。

修法：升级路径也改用 `upstreamAuthority(req)` 签 cookie（与 HTTP 对齐）；顺带补上**升级路径一直漏掉的口令闸门**
（`upgradeAllowed()`：经隧道/公网 IPv6 必须带口令，除非该设备「完全信任」，否则回 403 并断开）。

验证：同一套手机凭据下，内网与隧道的 WS 握手都是 **101** 且页面文本完全一致；
不带口令经隧道发起 WS → **403**；带口令 → **101**。

### 9.2 移动端适配注入（mobile-tweaks）

产品 WebUI **没有移动端布局**（CSS 里几乎没有媒体查询，窄屏行为全靠 JS 的
`viewportWidth < 1024`）。桥在返回 HTML 时插入 `mobile-tweaks.css` + `mobile-tweaks.js`：

| 问题 | 注入后的效果 |
| --- | --- |
| 窄屏展开侧栏 → 中间栏被挤到 ~130px，文字竖排 | 侧栏改为**浮层**（absolute + 阴影），内容不再被挤压（实测标语从 74×96 竖排 → 156×32 单行） |
| 设置面板固定两列（nav 188 + content 176）→ 标签逐字换行 | 面板改**竖排**：nav 在上（横向换行）、content 在下占满宽度（412px 屏上 dialog 400px、语言标签 254×22 单行） |
| 常驻 56px 左轨一直占屏（官方 App 是抽屉式） | 把产品的三栏网格第一列轨道改成 **0**，并**显式钉住** `sidebarCol/centerCol/rightbarCol` 的 `grid-column`；顶栏左上角注入 **☰**，点开是 `position:fixed` 的抽屉（宽 `min(300px,78vw)`）+ 半透明遮罩；点会话 / 点遮罩 / 再点 ☰ 收回 |
| 会话顶栏一行塞不下（标题 + 图标按钮 + 3 个插件 chip ≈ 700px → 溢出被裁） | 桌面专属按钮隐藏（`_split` 组 =「在文件资源管理器中打开工作目录 / 选择打开方式」）；三个 chip 平时隐藏 |
| 手机端用不了的功能白占位置 | 隐藏「**添加工作区**」（要桌面目录选择器；按 `aria-label` 匹配，带英文兜底）与「**截图**」按钮（我们自己的 dsh-screenshot 插件，依赖 `getDisplayMedia`；按 `[data-dsh-screenshot="button"]` 精确隐藏，元素仍在 DOM 里、桌面端照常显示） |
| 三个插件开关（时间戳 / 记忆库 / 备份）占 283px 且互相挤 | 只留一个「插件」药丸，**夹在「⋯（更多操作）」和「打开右侧边栏」之间**（做法：给 `_headerUtilities` 加 `margin-right:56px` 把 ⋯ 往左让，药丸再定位到 `_headerCorner` 左侧）；点开后三个 chip 以 **`position:fixed` 竖排悬浮**在药丸下方（宽 168px，间距 36px）——**完全脱离文档流**；再点药丸或点别处收回 |
| 注入的浮动控件不「合群」：左抽屉打开时药丸仍浮在上面；右面板（文件/预览）打开时还占着位置 | ① 左抽屉打开（`body.dshm-sidebar-open`）→ 隐藏「插件」药丸与其面板（跟着被抽屉遮住）；② 右面板打开 → 隐藏 `☰`、药丸、插件面板与悬浮信息，专心预览。右面板判据：先看 `_rightbarCol` 宽度，窄屏下改看「收起右侧边栏」按钮是否**可见**（实测关闭态它是 `visibility:hidden`，且「打开/收起」两个按钮在 DOM 里长期并存——不能用标签存在性判断） |
| agent 预设 chip（如「PTC 模式」）文字太长 | `div[class*="_headerActions"] span[class*="_label"]` 设 `font-size:0`，只留 svg 图标；它自带 `title` 长说明，点图标弹**悬浮信息面板**展示全文 |
| 顶栏第一行仍然塞不下（标题 + 后台任务 + 更多操作 + 打开右侧边栏） | ① 会话标题 crumb 限 `4.4em` + 省略号，点它弹**悬浮信息面板**显示完整标题；② 顶栏下拉触发器（后台任务 / 子代理，在 `_headerActions` 里）隐藏文字 span，**只留图标 + 下箭头**（自带下拉面板照常可用）；③ 其余 crumb（lineage 之类）只留图标 |
| 手机上 **设置 → 模型** 报「加载提供方目录失败：settings are unavailable in this browser」 | 产品按「是否本机托管」决定要不要开放设置读写：`isLoopback = __DSH_TRANSPORT__?.ownsHost === true \|\| isLoopbackHostname(location.hostname)`。手机用局域网 IP 访问，两个条件都为假 → 设置直接判定不可用。桥在**所有页面**最前面注入 `window.__DSH_TRANSPORT__ = { ownsHost: true }`（在 HTML 的 `<head>` 顶部，先于产品脚本执行），把桥的访问者当作「本地托管」。实测：提供方列表正常渲染、读写双向可用（点「深色」→ 宿主 `settings.yaml` 立刻出现 `ui-theme.preference: dark`） |
| 注入脚本自己把页面/桥搞崩 | 两个教训：① 注入是锦上添花——转发路径里**必须 try/catch 回退成「原样返回」**（曾经这里引用了改名后的旧常量，每次加载页面都抛 `ReferenceError`，被 `uncaughtException` 带走整个桥进程：手机一开页面桥就死）；② 脚本注入在 `</head>` 之前（`__DSH_TRANSPORT__` 必须先于产品脚本生效），此时 `document.body` 还是 **null** —— 初始化要等 `DOMContentLoaded`，`tick()`/`setPanel()` 也各自加 body 守卫；否则 `classList` 抛错还会连带跳过首次 `tick()`（顶栏得等 1 秒定时器才整理好） |
| 从侧栏点会话后：侧栏不收、输入法先弹出来 | 监听会话行点击（`_sessionRow` / `role=treeitem` / `data-session-id`）→ 260ms 后点侧栏自带的折叠控件（`button[class*="_toggle"]`，失败兜底 aria-label），必要时 450ms 再补一次；同时 1.2s 内抑制输入法自动聚焦（用户主动点输入框则立即停手） |

实测（412×915，无头 Edge）：

- 面板：收起态药丸右缘 404px ≤ 412；展开后 chips 固定在 (236, 50/86/122)，`_headerUtilities` 高度仍是 **28px**、`header` 76px、`_titleRow` 30px —— 顶栏几何零变化；点别处立即收回；
- 会话跳转：侧栏 **281px → 56px** 自动收起（连测两次）；`document.activeElement` 始终是 `BODY`，`editable=false`（不弹输入法）；
- 控制台：零错误。

- 只对 `text/html` 生效；转发时会去掉 `accept-encoding`，保证上游返回未压缩内容可直接改写；
- `__DSH_TRANSPORT__` 必须注入在**产品脚本之前**（我们注入在 `</head>` 之前，够早）；它只是「告诉产品这台机器由自己托管」，`ownsHost` 不影响鉴权——鉴权靠桥代签的浏览器会话 cookie，所以不要以为设了它就能匿名访问；
#### 踩过的坑（务必别再犯）

- **不要用 `display:none` 隐藏 `_sidebarCol`**：三栏是产品用内联 `style` 设的 CSS Grid（`grid-template-columns: 56px minmax(0,1fr) 0px`）。把第一个子元素移出网格，后面两列会整体前移——中间栏被塞进 56px 轨道（实测 412px 屏上中心列只剩 56px）。正确做法：**改轨道为 0** + 给三列**显式 `grid-column`**；抽屉再 `position:fixed` 浮起来，这样抽屉开关都不影响内容宽度。
- 抽屉的开合判据**不能用侧栏实测宽度**（收起态宽度为 0，会死锁）：用产品自己的折叠按钮 `aria-label`（「收起侧边栏」= 展开中）。
- **「点会话才收抽屉」不能靠 `[role="treeitem"]` 一刀切**：产品侧栏里**项目/分组行也是 `role="treeitem"`**（带 `aria-expanded`，点它是展开/收起），只有**会话行**（`_sessionRow`，带 `aria-selected`）和**搜索结果行**（`_searchResultRow`）点击才打开会话。所以判据必须是「命中会话类行 **且** 该行没有 `aria-expanded`」，否则点一下文件夹就会把抽屉收走（2026-10-07 修）。

- 关掉：启动桥时设 `DSH_BRIDGE_NO_TWEAKS=1`；
- 注入片段带 `id="dshm-css"` / `id="dshm-js"`，页面里搜这两个标记即可确认是否生效；
- 这些是**纯样式覆盖**：不改产品状态、不发请求，DSH 升级后即使 class 哈希变了也只会退回原样（下载按钮与缩放控制条同样只依赖 `data-files-entry` / `data-files-path` / `data-image-preview` / `data-pdf-preview` 这几个**稳定 data 属性**，不吃 class 哈希）。

#### 手机端下载（/__file）与预览缩放

DSH 的「文件」面板没有下载入口（点开只走应用内预览，而且预览是 RPC 取 base64 → blob，WebView 的下载器拿不到），图片/PDF 又按**原始尺寸**渲染，小屏上只能看到一角。两件事都在桥 + 注入层解决：

- **下载**：注入脚本给每个 `li[data-files-entry="file"]` 补一个 `⤓`（预览控制条上也有一个），指向 `GET /__file?path=<绝对路径>`；桥以 `Content-Disposition: attachment` 回文件，Android WebView 的 `DownloadListener` 转交系统下载器（`CookieManager.getCookie` 已把 WebView 的 cookie 带上，所以外网经隧道也过得了口令闸门），落到手机「下载」目录。
  - 文件名同时给 ASCII 兜底和 RFC 5987 的 UTF-8 名（`filename*=UTF-8''…`），中文名不会乱码或被截断；
  - **安全边界**：`/__file` 能读走本机任意可读文件——它和桥的其它接口一样在**设备认证 + 接入口令**之后，而桥口本身已经等价于本机 shell 权限（见「安全模型」），所以不额外扩大攻击面；但仍不要把这个端口暴露到公网。
- **缩放（手势版）**：页面里**不放任何常驻控件**（第一版做了底部控制条，实测会挡住输入框、且 50% 下限不够用，已废弃）。默认给 `body.dshm-pv-fit`：CSS 必须**连 `width:max-content` 的 frame 一起夹住**（只压 img 的 `max-width` 等于没压），一屏看全；缩放靠**双指捏合**——脚本直接把 `width` 写成 `自然尺寸 × 倍数` 并摘掉 fit 类，范围 10%–2000%，由滚动容器平移。
- **长按菜单**（下载 / 适宽 / 1:1）：路径优先取预览头部 `title` 上的展示路径（实测是完整绝对路径），其次退到文件树里最近点开的文件，最后才试 `data-document-preview`（当前版本那里是合成 tab id，**不是**资源地址，直接拿去下载会 404 —— 已加绝对路径校验）。
- **两个必须记住的坑**：① 长按抬手时浏览器会补一次 `click`，不留神就把刚弹出的菜单关掉（现在用「刚打开 600ms 内忽略 click」+「点在菜单内部不关」）；② `data-document-preview` 的值看着像地址其实不是路径，别想当然。
- **一句教训**：注入脚本里**不要用 MutationObserver 驱动会写 DOM 的 tick**——自己写、自己触发，实测直接把页面卡死（打开图片预览即复现）。改成定时器 + 「值没变就不写」幂等写入后正常。
#### 悬浮球的下载进度环（原生，App ≥ 1.3.4）

球的下载进度只能原生做：`DownloadManager` 没有回调，`startDownload` 拿到 id 后每 400ms `query` 一次（`COLUMN_BYTES_DOWNLOADED_SO_FAR` / `COLUMN_TOTAL_SIZE_BYTES` / `COLUMN_STATUS`），把 0–1 交给自绘的 `BallView.setRing()`；结束（成功/失败）后 0.9s 收环。原来球是 `TextView` + shape 背景，加环只能改成自绘 View（球体 / 细环 / 延迟读数一体），触摸逻辑（点开设置、长按刷新、拖动吸附）仍在 `MainActivity` 里，不受影响。
两个连带修的点（都在 App ≥ 1.3.5）：
- **`/__ping` 不再被口令闸门拦**：悬浮球的延迟探测是原生 `HttpURLConnection`，不共享 WebView 的 cookie jar，走隧道时会每 5 秒被 `外网入口被拦（缺口令）` 拦一次（实测累计 1032 次、日志被刷屏，延迟数字本身仍然有效——403 也是桥在这一跳回的响应，任何 HTTP 响应都算一次往返）。修法与下载同源：`CookieManager.getInstance().getCookie(url)` 取到 WebView 的 cookie（里面有 `dshm-key`）→ `conn.setRequestProperty("Cookie", cookie)`，于是与页面同等待遇。**原生请求不共享 cookie** 是这事儿的全部根因，App 里凡是绕过 WebView 自己发起的请求都要记得补这一步。
- **版本号以清单为准**：`build.ps1 -VersionCode/-VersionName` 只影响输出文件名，aapt2 的 `--version-code` 盖不住 `AndroidManifest.xml` 里的值——不改清单就会得到「文件名 1.3.4、装上去还是 1.3.3」的错标包（本仓库踩过，已修正）。
还有一个和返回键有关的坑（App ≥ 1.3.5）：
- **系统的「打开/收起」按钮在 DOM 里始终并存**，收起态的那个只是 `visibility:hidden`。`window.__dshmBack()` 里若不查可见性就按 `aria-label` 匹配，会在右栏已经收起时误点「收起右侧边栏」——等于又把面板打开了。判据必须是「标签匹配 **且** 可见 **且** 有尺寸」。
关于「注入会不会影响 PC 窗口」——两道门，别搞混：
- **布局/外壳那摊**（三栏改抽屉、☰、插件药丸、窄屏样式）由 `MOBILE_MAX_WIDTH = 720` 门控，宽屏窗口每次 tick 都会 `teardownMobileChrome()` 把它们拆掉，PC 保持产品三栏布局。
- **预览那摊**（默认适宽、双指捏合、长按菜单）另加一道 `mobileish()`（`navigator.maxTouchPoints > 0 || innerWidth <= 720`）：PC 上完全不碰预览，保持产品原样（原始尺寸 + 滚动）。**文件行的 ⤓ 下载不设门控**——PC 上也有用，且不改产品任何行为。
- 代价说明：`maxTouchPoints > 0` 会让**触屏笔记本**也按手机处理（预览自动适宽）。要严格只看宽度就把它去掉。

### 9.3 APK 分发

| 路径 | 作用 |
| --- | --- |
| `/__bridge` | 手机友好的落地页：打开 WebUI + **下载 APK**（显示文件名/大小/sha256 前 16 位） |
| `/__apk` | 直接下载 `dsh-mobile-app/dist/` 下**最新**的 APK（`content-disposition: attachment`，带 `x-apk-sha256` 头） |

### 9.4 按设备隔离的「通用设置」（语言 / 外观 / 字号）

手机改这三项**只影响手机**，电脑改**只影响电脑**。桥天然是设备边界（手机走 8099，电脑直连
127.0.0.1:3080 不经过这里），所以整件事在桥里完成，**产品代码零改动**。

| 环节 | 做法 |
| --- | --- |
| 设备身份 | 首次访问发一枚 5 年有效的 cookie `dshm-device=<16位id>`，该设备的设置存在 `device-settings.json` |
| 首帧 | 宿主把配色与字号嵌进**每份** index 的引导脚本（`const preference = "…"`、`--dsh-content-font-size', "…px"`）。桥按设备改写这两处字面量 → **首帧**就是这台设备的配色/字号，不会先亮一下再切 |
| 读 | `POST /api/settings/describe` 的响应里，把 `ui-theme` / `locale` 两个命名空间的 `value`/`user` 换成本设备的值；顺带缓存 schema、并记下电脑当时的解析值当种子 |
| 写 | `POST /api/settings/mutate`（以及 `update`/`replace`）命中这两个命名空间时**不转发**，只落本设备，并合成一份与上游同形的响应 `{type:"server-response",rpcId,result:{ok:true,value:{ns,schema,value,user,applies:"live",secrets:[],revision}}}`——schema 用之前缓存的那份，客户端 zod 校验照样通过 |
| 查看/撤销 | 手机浏览器打开 `http://<电脑IP>:8099/__device` 看本设备覆盖；`?reset=1` 清空 → 刷新页面即回到「跟随电脑」 |
| 关闭 | 启动桥时设 `DSH_BRIDGE_DEVICE_SETTINGS=0` |

**语义**：某台设备**第一次**改动之前跟随电脑（describe 原样透传）；改过之后就以「当时电脑上的值」为起点固定下来，
此后与电脑解耦——电脑再改它也不动。其它设置项（权限、模型、插件开关……）不受影响，照旧共享。

实测（无头 Edge 走真实局域网地址当手机，另一路用桥的签发算法给 `127.0.0.1:3080` 签 cookie 当电脑）：

- 手机改「深色 + 字号 15」→ 宿主 `settings.yaml` **仍是 `preference: system`**，设备存储里出现该设备的
  `ui-theme: {preference: dark, fontSize: 15}`；
- 手机切语言到 English → `<html lang="en">`、界面整体变英文，`settings.yaml` 里**没有** locale 段，设备存储里多了 `locale: {preference: "en"}`；
- 电脑改成浅色 → `settings.yaml` 变 `light`，**手机刷新后仍是 dark / 15px / en**，首帧脚本仍是 `const preference = "dark"`；
- 刷新手机页面第 4 秒（插件尚未挂载完）首帧就已是 dark + 15px，证明改的是引导脚本本身，不是事后补救。

### 9.5 自启动与运维

| 事项 | 做法 |
| --- | --- |
| 开机自启（主） | 计划任务 **`DSH Mobile Bridge`**：登录触发，动作 = `wscript.exe start-bridge-hidden.vbs`（隐藏窗口） |
| 崩溃自动重启 | **VBS 自带监督循环**：`sh.Run(cmd, 0, True)` 等 node 结束 → 除非退出码是 2（端口被占用，说明已有实例在服务），否则 3 秒后再拉起；连续失败退避 3→10→30→60 秒。实测强杀后 **3 秒内自动恢复**（日志有痕）。任务本身也设了 `RestartCount=3`、`ExecutionTimeLimit=0`（不限时）、`MultipleInstances=IgnoreNew` 作为兜底。桥在跑时任务一直显示 `Running`，**这是正常的** |
| 开机自启（冗余） | 启动项 `DSH Mobile Bridge.lnk` 指向同一个 VBS。两者谁先起谁服务，慢的那个因端口占用 `exit 2`（日志留痕），无害 |
| 运行日志 | `bridge.log`，由桥自己写（启动 / 监听 / 未捕获异常 / 退出码，>1MB 自动清空）。**不依赖任何 shell 重定向** |
| 改注入文件 | `mobile-tweaks.css/js` 按 mtime 缓存，**存盘即生效**，不用重启桥；改 `bridge.cjs` 要重启：`schtasks /End /TN "DSH Mobile Bridge"` → `Start-ScheduledTask -TaskName "DSH Mobile Bridge"` |
| 停 | `stop-bridge.cmd`（先 `schtasks /End` 再杀掉端口占用进程，否则会被自动重启拉回来） |

踩过的坑（都别再犯）：

- **WSH 的 `sh.Run("cmd.exe /c … >> log")` 在本机静默失败**：进程不启动、日志文件也不生成、`Err` 还是 0。最小探针复现过——同一个 VBS 里 `sh.Run` 直接跑 node 是成功的。所以启动脚本**别包 cmd**，日志让 node 自己写。
- **WMI 创建的 `wscript.exe` 起不来**（`Win32_Process.Create` 落在非交互窗口站，WSH 需要交互会话）。别再想着用 WMI 拉 VBS 做自启动，用计划任务；WMI 只适合拉 cmd/node 这类不需要窗口站的东西。
- **日志函数里 `fs.statSync` 会抛**：文件不存在时抛 ENOENT。若和 `appendFileSync` 塞进同一个 `try`，异常被 catch 吞掉 → **首次运行一个字都写不出来**，日志功能等于没有。查大小和写要分开 try。
- **别指望计划任务的「失败后重启」**：进程被强杀时任务结果是 `0xFFFFFFFF`（4294967295），任务状态直接变 `Ready`，`RestartCount` 不会触发（实测等 80 秒没动静）。要自动恢复就在启动脚本里自己循环。
- 桥崩了先看 `bridge.log` 最后几行，再复现：`Get-Content bridge.log -Encoding utf8 -Tail 20`。

### 9.6 「设置 → 手机端」面板（二维码 + 设备管理）

电脑的**设置**里多一个原生分区「手机端」（在 Agent 预设 之后），内容：

- **二维码**：内容 = 桥的落地页 `http://<局域网地址>:8099/__bridge`
  —— 手机浏览器扫 → 打开网页版（页面上有下载 App 的按钮）；手机 App 里扫 → 直接连上这台电脑。
  多网卡时可下拉切换地址，默认按「Wi-Fi → 192.168.* → 10.* → 有线」排序挑一个；
- **下载最新 App**：按钮 + 文件名/大小 + sha256 前 16 位（来自 `/__apk`）；
- **设备管理**：按**设备**（不是浏览器）聚合的列表，界面只显示**随机 ID + 设备名**：

  | 分组 | 每行显示 | 可做的操作 |
  | --- | --- | --- |
  | **待认证** | 随机 ID、设备名、机型描述、来源 IP、请求时间 | **✓ 允许** / **✗ 拒绝** |
  | 已认证 | 随机 ID、设备名、IP、在线/最后活跃、是否有本机专属设置 | **踢出**（断开并改为已拒绝） |
  | 已拒绝 | 同上（灰显） | **恢复**（重新放行） |

  有新设备请求接入时，**任何已认证页面上都会弹一张卡片**（右上角，含允许/拒绝/稍后），
  不必先打开设置；卡片由注入的面板插件轮询 `/__devices` 得来（每 5 秒）。

| 环节 | 做法 |
| --- | --- |
| 面板从哪来 | 桥往每份 index 响应追加一条客户端插件条目，浏览器端由产品的模块加载器正常加载 —— **不用重启 harness**。真插件要写进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，而那边 `patchReload: startup` 只能重启生效 |
| 二维码生成 | vendored 的 `vendor/qrcode-generator.js`（MIT）出点阵，桥自己拼 8 位灰度 PNG（只用 `node:zlib`），零 npm 依赖 |
| 设备身份 | **机型级特征码**（见下），界面只出随机 ID；cookie 只当作「浏览器实例」，不再当设备身份 |
| 设备台账 | 桥在每个请求/WebSocket 升级时记录实例级 `{id, ip, ua, lastSeen, sockets}`，再按特征码聚合；**在线 = 90 秒内有请求 或 还挂着 WebSocket**（App 常驻 `/api/remote.mux`）。实例台账在内存里，设备名册持久化在 `device-settings.json` 的 `known` |
| 踢出/拒绝 | 把该设备置为 `denied` + 掐断它名下所有连接；它之后每个请求都收到 403 或「已被拒绝」页。**恢复**就是置回 `approved` |
| 接口 | `POST /__hello`（页面把粗粒度特征发上来，认设备）、`GET /__devices`、`POST /__approve?id=`、`POST /__deny?id=`、`POST /__kick?id=`、`POST /__unblock?id=`、`GET /__qr.png?host=&scale=`。除 `/__hello` 外都要求调用方**已认证**（本机回环永远算已认证） |

#### 设备身份与「首次接入要本机确认」

**为什么不用 cookie 当设备身份**（第一版的做法）：cookie 是**浏览器实例**的身份——
换浏览器、清一次数据就变成一台新设备，同一台手机被数成好几台（实测「只有两台设备却显示六台」）。

**特征码**只取机型级、非隐私的公共特征：

```
OS 家族 + 屏幕短边×长边 + 像素比 + CPU 核数 + 内存档位 + 触摸点数 + 时区 + 主语言
```

- 屏幕宽高**排序后**再用，横竖屏切换不会变成另一台设备；
- 刻意**不碰** canvas / WebGL / 音频 / 字体这类指纹追踪技术，不含账号、IMEI、MAC、序列号；
- 同型号手机得到同一个特征码——对「认设备」够用，对「认人」不够，这正是隐私上想要的；
- 特征码在桥内只以 **HMAC/加盐 SHA-256**（盐随机生成、持久化在 `device-settings.json`）形式存在，
  从不出现在接口响应、日志或界面里。`/__devices` 只给随机 ID（`D-XXXX-XXXX`）与设备名。

**认证流程**（默认全员要认证，本机除外）：

```
手机首次打开 …… 桥：这个 cookie 没凭据 ─┐
                                        ├─ 返回「等待本机确认」页（自带特征上报 + 每 2 秒轮询）
手机页 POST /__hello（特征）………………┘   → 桥认出特征码：新设备 → pending，已有 → 直接 approved
电脑「设置 → 手机端」/ 右上角弹窗 → ✓ 允许
手机页轮询到 approved → location.replace('/') → 正常进入应用
```

- **凭据**是一枚 HMAC 签名的 cookie `dshm-token = v1.<特征码>.<签名>`，只有 `approved` 的特征码签得出来；
- 认证闸门在**桥侧**（服务端），不是前端遮罩：未认证设备拿到的**就是另一张页面**，
  `/api/**`、`/plugins/**`、WebSocket 一律 403/断连 —— 所以不存在「先加载应用再弹提示」的空窗；
- **清掉 cookie / 换浏览器**：新实例没有凭据 → 照样看到等待页 → 但 `/__hello` 一上报特征码就认出是老设备，
  已经是 `approved` 的直接发凭据、页面自动进入，**不用再点一次允许**（实测：设备数 1 → 1，直接进应用）；
- **本机（127.0.0.1）永远放行并自动认证**：否则一旦把所有设备都拒了，就没有任何人能点「允许」，
  会把自己锁在门外；桌面窗口走桥时正是回环地址，所以面板永远可用；
- 认证之前也能访问：落地页 `/__bridge`、APK `/__apk`、二维码 `/__qr.png`、特征上报 `/__hello`、插件包 —— 
  新手机得先能下载 App、先能上报特征，才谈得上认证；
- 每个设备**独享的语言/外观/字号**也跟着特征码走了（换浏览器照样保留）。

**桌面窗口怎么才能看到这个面板**：面板是桥注入的，所以窗口必须由桥提供页面。
启动器（`dsh-desktop/launcher.ps1` 与安装目录那份）现在会先探一下桥
（`http://127.0.0.1:8099/__bridge`）：在跑就把窗口开到桥的地址，不在就照旧直连 3080 —— 桥是增强，不是硬依赖。
**已经开着的窗口**仍是旧地址，关掉重开一次（双击「启动 DeepSeek Harness」）才会出现面板。

#### 踩过的坑（务必别再犯）

- **光往 `__DSH_BOOT__.entries` 追加条目会让整页白屏**：加载器还要求每个条目被某个
  `__DSH_BOOT__.batches` 批次认领（batch 形状 `{phase:"bootstrap"|"application", url, rev, entries:[…]}`，
  且 `url` 必须含 `rev=`），否则抛 `entry "…" belongs to no initial-load batch` —— 这个错误出现在
  客户端启动阶段，**整页起不来**（不是某个面板坏掉）。所以注入时条目和批次要一起加。
- 批次的脚本是用 `<script src>` 加载的**经典脚本**，URL 形如 `/__plugin/client.js&rev=…`
  （注意 `&rev` 在**路径**里，没有 `?`）——桥的路由匹配要先按 `&` 切开。
- 面板宽度有限（设置面板内容列约 430px）：URL 和「扫码地址」下拉**不要放在同一个 flex 行**，
  否则 URL 会被下拉挤成一列一个字（第一版就是这个样子）。
- 手机端注入与桌面共用一个通道：`mobile-tweaks.js` 必须按 `window.innerWidth > 720` 时
  **拆掉**自己加的 ☰/插件药丸，否则桌面窗口顶栏会多出手机专用控件。
- `/__hello` 必须**只认 POST 且校验特征完整**：健康检查式的 `GET /__hello` 曾让桥凭空登记出一台
  「未知设备 · 未知系统 · 0x0」（空特征哈希也是稳定的，会一直在名册里）——现在 GET 返回 405、
  没有系统/屏幕信息的返回 400，都不登记。

### 9.7 手机 App 扫码连接

App 设置页的「扫码连接」调**系统相机**拍一张（或「从相册里的二维码图片连接」），
用 ZXing core 就地解码 → 折成服务器地址 → 自动重连。读的是同一个二维码，所以
「电脑上生成码 → 手机扫」是一条闭环（外网二维码带接入口令 `?k=…`，App 会原样保留）。
实现细节与坑见 `dsh-mobile-app/README.md`。

### 9.8 外网访问（隧道（frp 类工具皆可））

手机在户外也能连回本机。**只把桥的 8099 挂出去，别挂 3080**——3080 没有口令、没有设备认证，
一旦暴露等于把 shell 直接交出去。

#### 一、建隧道（任何 frp 类服务商，具体以面板提示为准）

1. 启动器登录 → **隧道** → 右上角 **+**；
2. **选节点**：挑延迟低的（免费节点有流量/限速，流量靠签到拿）；
3. **隧道类型**二选一：
   - **TCP 隧道**（最快能用，不需要域名）：本地地址 `127.0.0.1`、本地端口 `8099`、远程端口留空（节点分配）
     → 保存 → 启动 → 日志给出 `cn-xx.frp-provider.example:12345` → 外网地址填 **`http://cn-xx.frp-provider.example:12345`**；
   - **HTTPS 建站隧道**（推荐：有证书、地址短好记）：先按官网引导把域名（含他们提供的免费二级域名）绑到隧道，
     本地地址 `127.0.0.1`、本地端口 `8099` → 启动后地址形如 **`https://xxxx.frp-provider.example`**；
4. 在隧道列表里点**启动**，状态变「运行中」。

#### 二、把地址交给桥

设置 → 手机端 → **外网访问**：粘贴上面的外网地址 → 保存。桥会自动生成一枚**接入口令**，
并给出带口令的完整地址；二维码切到「外网」即可给手机扫（手机 App 的「扫码连接」也认这个码）。

#### 三、隧道下才生效的三层防护

| 隐患 | 做法 |
| --- | --- |
| frpc 在 127.0.0.1 上把公网流量转进来，旧判据「来源是回环就算本机」会把**整个互联网**当成本机、自动认证 | 「本机」改为要求**来源回环 且 Host 也是回环**。桌面窗口满足（开在 127.0.0.1:8099），隧道域名不满足 → 走正常的设备认证 |
| harness 的来源栅栏（`dsh-client-connection/api-request-trust`）要求 Host 为回环或命中 `--trusted-host`、且 Origin 与 Host 一致 —— 隧道域名两者都不满足，所有 `/api` 会 403 | 桥把**域名形式的 Host**（连同 Origin）在转发时归一化成受信任的局域网 authority，cookie 也按它签 → **不必重启 harness、不必改 `--trusted-host`**；局域网 IP 与回环 Host 原样透传，现有访问方式零变化 |
| 公网入口会被扫，把设备审批队列刷满、看到等待页 | **接入口令**（`DSH_BRIDGE_ACCESS_TOKEN` 可覆盖）：只对「经隧道进来」的请求生效；带 `?k=<口令>` 首次访问会种 cookie 并 302 跳转到去掉参数的地址。本机窗口与局域网 IP 的手机都不需要口令 |

新设备（哪怕来自外网）依旧是**待认证**，必须在本机「设置 → 手机端 → 设备管理」点 ✓ 才放行，
并会弹卡片提示；已认证的设备换浏览器/换网络也认得出。

#### 四、实测（用「回环来源 + 外部域名 Host」模拟 frpc）

| 场景 | 结果 |
| --- | --- |
| 隧道访客不带口令 | 403「需要接入口令」 |
| 带 `?k=<口令>` 首次访问 | 302 → 去掉参数的地址，并种下 `dshm-key` cookie |
| 有口令但设备未认证 | 200 **等待本机确认页**（关键：不再被当成本机） |
| 经隧道 `POST /__hello` | 进**待认证**（`D-xxxx-xxxx`），不是自动认证 |
| 未认证时打 `/api` | 403 `device-not-approved` |
| 本机批准后经隧道打 `/api/settings/describe` | **200**，17 个命名空间（Host/Origin 归一化通过了 harness 栅栏） |
| 回归：桌面(回环 Host) / 局域网手机 / 局域网 `/api` | 应用直进 / 等待页 / 200 —— 内网行为零变化 |

### 9.9 外网实战记录（隧道 + 自定义域名）

把手机从公网接回本机的完整落地过程与实测结论：

| 步骤 | 关键点 |
| --- | --- |
| 建隧道 | 节点选**非内地 + 带绿色「建站」标识**（本例节点域名 `node.example.com`，韩国首尔）→ 隧道类型 **HTTPS 建站隧道** → 本地 IP 留空、本地端口 **8099** → 绑定域名 `dsh.example.com` |
| DNS | 域名商处加 **CNAME：主机记录 `dsh` → 节点域名**。别用根域名 `@`（根上已有 A 记录，CNAME 与 A 不能共存）；绑定域名、解析域名、访问域名三者必须完全一致 |
| 备案 | **非内地节点不需要备案**；内地节点建 HTTP(S) 隧道必须已 ICP 备案，而备案是「委托实际接入商」办理的、必须先有境内服务器，frp 服务商本身不提供备案服务 |
| 访问密码 | **留空**：官方文档说明访问认证仅针对 TCP 隧道，HTTP 隧道的 Basic Auth 官方自己「不推荐」；且会让手机 App 的 WebView 弹账号密码框。我们用自己的**接入口令 + 设备认证** |
| **自动 HTTPS** | **必须开启**（本场景的关键，见下） |

#### 证书是部署方自己的事，桥只认「地址 + 端口」

桥不参与、也不需要知道你用哪种证书。它只做一件事：把你填进来的隧道地址（形如
`https://你的域名:端口`）连同接入口令做成一枚二维码，手机扫一下就能连上。

- **受信任的证书**（公网 CA）：手机浏览器、系统下载器、其它 App 都能正常访问，最省事；
- **自签证书**：App（≥ 1.3.7）第一次连接时会弹出指纹让你核对，确认后记住这一张（TOFU），
  之后照常使用；代价是浏览器和其它 App 会报证书错误，只有本 App 认它。

隧道怎么建、用哪个服务商、证书怎么签发与续期，都属于部署方自己的网络环境，不在本项目范围内。
#### 外网口令规则：「完全信任」而不是「认证过就免口令」

早期实现里，设备一旦在本机被认证，从外网进来也免口令——**这是错的**：内网认证 ≠ 外网可信。
现在规则是：

| 来源 | 是否需要接入口令 |
| --- | --- |
| 本机（回环 Host） | 不需要 |
| 局域网 IP 直连 | 不需要 |
| **经隧道（公网）** | **需要**，除非管理员在设备管理里给这台设备点了 **「完全信任」** |

「完全信任」是**每台设备**的开关（`POST /__trust?id=&on=1|0`，持久化在 `device-settings.json` 的 `known[fp].trusted`），
面板里对**已认证**设备显示按钮，可随时撤销；面板上会挂一枚「外网免口令」标签。
实测：陌生人 403 → 已认证未信任 403 → 信任后 200 → 撤销后又 403 ✓

#### 界面文案与图标（2026-10-07 凌晨，按用户反馈改）

| 反馈 | 处理 |
| --- | --- |
| sha256 没用 | 面板不再展示（下载响应头的 `x-apk-sha256` 保留，需要校验时仍可查） |
| 长解释太占地方 | 新增「ⓘ」折叠说明组件（4 处：接入说明、外网访问、显示设置、设备识别方式），默认收起 |
| 文案太口语 | 全部改成陈述句：如「手机和电脑连同一个 Wi-Fi，然后扫码：」→「同一 Wi-Fi 下扫码接入」 |
| 不该点名隧道服务商 | 改为「用任意内网穿透 / 反向代理服务，把隧道指向本机 127.0.0.1:8099」，占位符也换成 `https://your-domain.example` |
| 「手机端」图标是齿轮 | **DSH 的 `navIcon()` 按分区 id 硬编码**（只有 models / agent-presets / plugins 有专属图标，其余一律齿轮），插槽只收 id/order/label —— 所以改由页面注入：给那一行的 `svg[class*="navIcon"]` 加 `mask-image`（手机轮廓）+ `background-color: currentColor`，深浅色主题都跟着走 |

验证：用假 React 把面板整体渲染一遍（`panel-smoke.cjs`）——渲染无异常、4 处折叠说明、sha256/厂商名/占位符均已消失、长说明默认不出现在可见文本里 ✓。

#### 按设备隔离的显示设置：改走客户端方案（2026-10-07 凌晨）

起因：`/api/settings/describe` 在当前 DSH 上已 404 —— 设置改成了 remote/mux RPC，
原来「改写 describe + 就地拦截写请求」的做法**整条失效**（字号/语言会改到电脑那份）。

新做法**不碰 DSH 任何接口**，只用桥自己的存储 + 页面注入：

| 谁 | 做什么 |
| --- | --- |
| 桥 | `GET/POST /__display`：按设备存 `{preference, fontSize}`（存在 `known[fp].namespaces['ui-theme']`，换浏览器也跟着走）；任何已认证设备只能改自己那一份；`clear=1` 回到「跟随电脑」 |
| 注入 JS（mobile-tweaks.js） | 读 `/__display` 并按 DSH **自己那三行写法**应用：`documentElement.style.colorScheme`、`body[data-ds-dark-theme]`、`--dsh-content-font-size`（12–17px）；「跟随系统」时监听 `matchMedia` 变化；面板改完派 `dshm-display-changed` 事件即时生效，无需刷新 |
| 面板（本设备的显示） | 外观：跟随系统 / 浅色 / 深色 / 跟随电脑；正文字号：−/+ |

**实测**：该设备首帧 `preference=dark fontSize=16px`、其它设备首帧不受影响 ✓；
页面开着时改成 17px → **不刷新立刻变 17px** ✓；改成浅色+13px → 立刻变浅色 13px ✓；
系统配色切浅色而设置为显式深色 → **保持深色**（显式优先）✓；恢复 `跟随系统+14px` → 跟随系统 ✓。
自检新增 `theme` 字段：首帧主题脚本的两个字符串常量若被 DSH 改写，这一项会变 false（届时改走注入 JS 那条路，功能不受影响）。

**「跟随系统」是实时生效的**（用无头浏览器翻转 `prefers-color-scheme` 实测：不刷新，`color-scheme`/`body[data-ds-dark-theme]`/背景色立刻跟着变）；
DSH 运行时自己就监听了 `matchMedia('(prefers-color-scheme: dark)')` 的 change 事件。手机 App 里同样跟随（`MainActivity` 没有干预日夜模式，`configChanges` 已含 `uiMode`）——
只有 App 自己的窗口底色是写死的深色（纯外观，需要时可加 `values-night` 资源）。

**语言（2026-10-07 凌晨补上）**：一开始以为客户端没有挂点，实测发现**挂点就是浏览器语言** ——
`dsh-client-locale/lib/client.js` 在「没有显式 `locale.preference`」时遍历 `navigator.languages` 决定语言，
而**中英两套字符串本来就并排打包在 DSH 自己的客户端 bundle 里**（例如同一文件里 `"appearance.system": "跟随系统"` 与 `"System"` 相邻），
所以不需要自备语言包，只要在客户端运行时启动前把浏览器语言换掉。

实现：桥按设备把一段**同步** `<script id="dshm-locale">` 注入 `<head>` 最前（覆盖 `navigator.language` / `navigator.languages`），
面板「本设备的显示」里多了 中文 / English / 跟随浏览器 三态。

实测：该设备页面注入 `en-US` ✓、别的设备页面没有这段脚本 ✓；用无头浏览器按手机身份打开，界面真的变成英文
（`html lang=en`、菜单显示 *Standard mode / Describe what you want to build*）✓；清掉后回到跟随浏览器 ✓。

**代价**：语言在页面启动时解析一次 ⇒ **改完要刷新页面**（外观/字号是实时的，语言不是；面板里已写明并会自动刷新）。
另外只翻译界面文字（菜单/按钮/提示），模型回复、会话标题、工具输出这些内容本身不翻译（也不该翻）。

#### 抗 DSH 更新：三层防护（2026-10-06 深夜）

风险来源：桌面窗口默认走桥（8099），而桥要往 `__DSH_BOOT__` 里插插件条目 —— **DSH 换了清单结构，插错一步就是整页白屏**，
而白屏的恰好是唯一还能改设置的桌面窗口。

| 层 | 做什么 | 失效时的表现 |
| --- | --- | --- |
| 注入前自检（bridge） | 清单必须是 entries/batches 数组、条目都有 id、批次认领的是 id 字符串、**每个条目都被某批次认领**、序列化后能回读 | 整段放弃注入 ⇒ **只是少了「手机端」面板，页面照常** |
| `/__selftest`（bridge） | 直接向上游取一次首页，把注入管线完整跑一遍，返回 `{ok,panel,tweaks,boot,describe,upstream,note}` | 启动器据此决定走不走桥 |
| 启动器 | 只在 `ok=true` 时把窗口指向 8099，否则**退回官方端口** | 窗口一定开得出来（代价是没有面板，手机侧不受影响）；`DSH_DESKTOP_DIRECT=1` 可强制直连 |

实测（假上游 + 漂移清单）：结构正常 → 注入成功且注入后的清单仍自洽 ✓；
结构漂移（批次里放对象而不是 id 字符串）→ **拒绝注入、页面原样** ✓（不再白屏）。线上自检：`ok=true panel=true tweaks=true boot=true` ✓。

**顺带发现一个正在失效的功能**：`/api/settings/describe` 在当前 DSH 上已返回 404 —— 设置改成了 remote/mux 协议调用，
所以「按设备隔离 字号 / 语言」这条已经**悄悄失效**（外观不受影响，它走的是 boot 清单里的首帧主题注入）。
`/__selftest` 的 `describe` 字段就是用来盯这个的：为 false 即代表该功能已失效，别再把「手机改设置不会影响电脑」当承诺。

#### 手机端面板的权限分级（2026-10-06 夜）

起因：手机上打开「设置 → 手机端」时，**未信任的设备也能看到接入口令、外网二维码，还能点「换一个」**。
口令是「外网入口的凭证」——把它展示给正是被它拦在门外的那些设备，等于自毁闸门；
而且任何已认证设备都能**更换口令**（把别的设备踢下线）或**踢出别的设备**。

现在按来源分三档（后端 `panelScope()` 强制，界面只是不显示）：

| 档位 | 判据 | 看得到口令/外网二维码 | 设备管理 |
| --- | --- | --- | --- |
| `local` | 电脑上的窗口（回环 Host） | ✅ 全部（含「换一个」「清除」、外网二维码） | ✅ 允许/拒绝/踢出/恢复/完全信任 |
| `trusted` | 已「完全信任」的设备 | ❌ 看不到（`wan: null`、`/__qr.png?wan=1` 403） | ✅ 允许/拒绝/踢出/恢复 | ⛔ 授予或撤销「完全信任」只归本机 |
| `device` | 其它已认证设备 | ❌ 看不到 | ⛔ 全部 403，界面上只留它自己那一台 |

局域网二维码（不含口令）对所有已认证设备开放——用来把新设备加进来是安全的。

实测：本机 `scope=local` 且口令可见、`POST /__wan` 200 ✓；未信任设备 `scope=device`、`wan=null`、`/__wan|/__kick|/__approve|/__deny|/__trust|/__qr.png?wan=1` **全部 403** ✓；
已信任设备 `scope=trusted`、口令不可见、`/__kick` 放行（404=过了闸门）、`/__trust` 403 ✓。

应急开关：手动以 `DSH_BRIDGE_PANEL_OPEN=1` 启动 bridge 可恢复旧行为（任何已认证设备＝本机视图）。默认关。

#### 接入口令定期自动轮换（2026-10-06 夜）

外网入口的口令与二维码现在**每 7 天自动更换一次**（`DSH_BRIDGE_TOKEN_DAYS` 可改，设 0 = 关闭）：

| 机制 | 说明 |
| --- | --- |
| 触发 | 懒检查（任何读口令的请求，如面板接口）+ 每小时定时，长期无人访问也会按期换 |
| 老数据 | 只有口令、没有签发时间的记录**只补记时间、不当场换**——否则升级那一刻所有外网设备被踢 |
| 历史口令 | 一旦轮换立即失效（名字与签名都换了），面板里的二维码随之作废重生成 |
| **已「完全信任」的设备** | **不受影响**：`passAccessToken()` 在这类设备上直接放行，所以它们不会因为换口令而掉线 |
| 未信任的设备 | 需要重新扫面板里的新二维码（或输入新口令） |

面板「外网访问 → 接入口令」下方会显示倒计时：*口令每 7 天自动更换一次 —— 还剩 X 天 Y 小时。已「完全信任」的设备不受影响，其余设备需重新扫码。*

实测（把签发时间改成 8 天前制造到期）：到期后口令自动更换 ✓；旧口令 → **403 口令页**、新口令 → 200 ✓；
未信任设备不带口令 → **403**✓；把设备置为「完全信任」后不带口令 → **200**（绕开口令，正是设计意图）✓。

#### 设备身份精确到「个体」：Android ID（不是 IMEI/MAC）

| 候选标识 | 安卓现实 |
| --- | --- |
| IMEI | **Android 10+ 普通应用拿不到**（非设备所有者/非运营商权限时 `getImei()` 返回 null），且要「电话」权限、运行时弹窗 |
| Wi-Fi MAC | Android 6+ 的 `getMacAddress()` 只返回 `02:00:00:00:00:00`；Android 10+ `NetworkInterface` 也被封 |
| **`Settings.Secure.ANDROID_ID`** | ✅ **无需权限、不弹窗**；Android 8+ 按「应用签名 + 用户 + 设备」作用域，重装不变、恢复出厂才变 |

实现：App 里算 `SHA-256("dsh-mobile:" + ANDROID_ID)`，只把哈希通过 `addJavascriptInterface`（单一只读方法 `__dshAppDevice.deviceId()`）交给页面，
页面在 `collectTraits()` 里带上 `appId`；桥的 `fingerprintOf()` 把它并进特征码（`TRAITS_VERSION=2`）。
于是：**安卓 App = 设备个体级身份**（面板显示「设备唯一」），**浏览器 = 机型级**（拿不到，也不该用 canvas/字体那种指纹追踪去补）。
实测：同屏幕/同核数下，带 `appId` 与不带 `appId` 会得到两台不同设备 ✓

#### 设备身份：同一部手机的 App / 浏览器 / 内网 / 外网 = 一台设备（2026-10-06 深夜修）

实测症状：用户一部手机在台账里变成三台（`安卓手机` / `安卓手机 2` / `安卓手机 3`）。查明两个真因：

1. **指纹算法升到 v2（纳入 appId）时没有迁移旧记录** —— 同一条浏览器被算出两个指纹，各占一条；
2. **App 与浏览器必然分裂**：浏览器报不出 `navigator.deviceMemory`（是 0），App 的 WebView 报 8；浏览器也没有 appId。

规则改成两层（`resolveDevice()`）：

| 层 | 规则 |
| --- | --- |
| ① 严格指纹 | 完全一致（含 appId）→ 就是它。**两台同型号手机都装了 App 时各自带 appId，在这一层就被分开** |
| ② 特征吻合 | 逐字段比，**任一边「未知」（0 / 空）就跳过该字段**；appId 两边都有且不同则永不合并。唯一命中就并过去 |
| ③ 都不中 | 才新建「待认证」记录 |

另外两处配套修复：

- `ensureKnownDevice()` 写特征时改为**合并**而不是覆盖 —— 否则浏览器后到的一次请求会把 App 报的 appId/memory 抹掉，「设备唯一」随之丢失；
- `normalizeTraits()` 改为**幂等** —— 记录里存的是已归一化形态（`screen: "385x854"` 字符串），再喂进去会得到 `"0x0"`/`dpr:1`，合并设备时正是这么把自己的特征写坏的。

实测：模拟「内网浏览器 / 外网浏览器 / App」三种入口上报，三次都并入同一台（设备数 1→1）；换一个机型上报则新建待认证（不会误并）；
清理测试痕迹后台账为 **1 台设备 + 6 个真实实例**（3 个内网浏览器 + 1 个 IPv6 浏览器 + 2 个 App），IP 列表同时含局域网、IPv6 与隧道来源。

#### 隧道下才生效的三层安全网（本轮已实测）

- **本机判据**：来源回环 **且** Host 回环才算本机——否则 frpc 从 127.0.0.1 转发过来，全网访客都会被当成本机自动放行；
- **Host/Origin 归一化**：域名形式的 Host 在转发时折算成受信任的局域网 authority，过 harness 的来源栅栏，**不必重启 harness、不必加 --trusted-host**；
- **接入口令**：只对「经隧道进来」的请求生效，`?k=<口令>` 首次访问种 cookie 后 302 到干净地址；新设备（哪怕来自外网）仍进**待认证**，必须本机点 ✓。

### 9.10 传输优化：先修「自己造成的未压缩」，再上 brotli，最后是节点选择（2026-10-06 晚）

**症状**：手机经外网加载首屏要好几分钟。实测（本机经隧道自测）：`/__bridge` 单次 **458 ms**（本机直连 12 ms），
下载 418KB 的 APK 用 **12.7 s ≈ 0.25 Mbit/s**，而同一时刻账号的免费额度是 **10 Mbit/s**。

**根因一（自己造成的）**：桥为了让上游返回可注入的明文，在 `forwardHeaders()` 里把请求的 `accept-encoding` **剥掉了**
—— 于是所有响应都不压缩，首屏 61 个插件合并成一个 10.9MB 的明文包。
修法：`accept-encoding` 一律透传；需要改写的响应改成「按 `content-encoding` 先解压 → 注入 → 再按客户端能力重压」
（`decodeBody()`；重压优先 br，其次 gzip，都不支持才退回明文）。

**根因二**：上游只会 gzip。桥侧再对大文本响应压一层 **brotli**，并按带 `?rev=` 的不可变 URL 缓存压缩结果（最多 8 条）。
能力判定 `clientSupportsBrotli()`：**实测 Chromium 给子资源发的 `accept-encoding` 常常只有 `gzip, deflate`（连 br 都不声明）**，
所以自家 App（UA 带 `DSHMobile/`）与 WebView2（带 `Edg/`）按「必然支持 br」放行，其余客户端严格按 `accept-encoding` 判断。

**实测（一次完整首屏加载，冷缓存 + `Network.setCacheDisabled`）**：

| 阶段 | 传输字节 |
| --- | --- |
| 修之前（全程明文） | **12,857 KB** |
| 透传上游 gzip | **4,912 KB** |
| ＋桥侧 brotli | **4,020 KB** |

单包账：`/plugins/??…`（61 个插件拼一个包）10,909KB → 上游 gzip 4,255KB → 桥 brotli **3,418KB**
（解压后 sha1 与 identity 完全一致 ✓；同日第二次取走缓存：509 ms → 176 ms）。
小响应不折腾：首页 HTML 51KB 时 **gzip 11,212B 比 br 11,408B 更小**，所以门槛设在解压后 128KB（流式路径按编码后 32KB）。

**根因三（真正的大头）：节点路由。** 用官方 API 列出全部节点并从本机逐个测 TCP 握手：

| 节点 | 本机→节点 | 免费 | 非内地（免备案） |
| --- | --- | --- | --- |
| 韩国1 `node.example.com`（**当前**） | **241 ms** | ✓ | ✓ |
| 日本2 `node.example.com` | **59 ms** | ✓ | ✓ |
| 新加坡1 `node.example.com` | 91 ms | ✓ | ✓ |
| 中国台湾CHT1 `node.example.com` | 104 ms | ✓ | ✓ |
| 内地节点（天津/济南/枣庄…） | 17–43 ms | ✓ | ✗ 建 HTTP(S) 隧道必须 ICP 备案 |

本机国际出口本身也只有 1–3 Mbit/s（Cloudflare 5MB 实测 2.4 Mbit/s，走本地 VPN 代理 3.4 Mbit/s），
但隧道只有 0.25 Mbit/s ⇒ **瓶颈不是免费额度的 10 Mbit/s，而是节点/链路**（同一时刻日本2 的 RTT 只有韩国1 的四分之一）。
**已落地（2026-10-06 22:2x）**：用户充值 VIP 后把隧道切到 **香港特别行政区1（`node.example.com`）**，
阿里云 DNS 的 `dsh` CNAME 同步改成 `node.example.com`。实测（走域名、经隧道）：
首字节 ~1100ms → **~110ms**，请求延迟 458ms → **123ms**，下 418KB 从 12.7s → **0.3～0.6s**，
吞吐 0.25 → **5.6～10.7 Mbit/s**（≈20～40 倍）；账号限速也随套餐提升（隧道客户端日志可查）。
剩下 5～10 Mbit/s 已接近本机家宽的国际出口上限（同期 Cloudflare 实测只有 2.4～3.4 Mbit/s），换节点不会再快。

**口令闸门与 ACME 校验**：`needsAccessToken()` 只挡「经隧道进来的匿名请求」，而 ACME 的 HTTP-01 校验
正是匿名的——所以桥把 `/.well-known/acme-challenge/` 列为豁免。实测：经隧道匿名取挑战文件 200、不存在的 404、
`http://` 先 301 到 https（ACME 客户端会跟随重定向），而 `/__bridge` 无口令仍然 403。

换节点步骤：面板编辑隧道 → 节点改「日本2」→ 阿里云 DNS 把 `dsh` 的 CNAME 从 `node.example.com` 换成 `node.example.com`
（绑定域名、证书、自动续期都不用动）。

**开关与回滚**：

- `DSH_BRIDGE_NO_BROTLI=1`：关掉桥侧 brotli，回到「只透传上游压缩」；
- `DSH_BRIDGE_BROTLI_MIN`（默认 32768 字节，编码后）与 `DSH_BRIDGE_BROTLI_LIMIT`（默认 16MB）：阈值与单响应上限（超限改回边收边发，绝不整段驻留内存）；
- `DSH_BRIDGE_DEBUG_BROTLI=1`：打印每个 JS/插件响应的编码决策（AE / UA / 结论）；
- 彻底退回旧的「未压缩」行为：恢复 `forwardHeaders()` 里剥掉 `accept-encoding` 的那行即可 —— 不推荐，那是 3.2 倍流量。

### 9.11 IPv6 直连（绕过隧道那条路，2026-10-06 深夜）

本机拿到的是运营商公网 IPv6（`2400:xxxx:xxxx:xxxx::1/64`，中国移动），手机在流量下也能直连 `8099`，速度等于同一局域网、完全不经过frp 服务商节点。桥这侧要处理两件容易漏的事：

| 坑 | 处理 |
| --- | --- |
| IPv6 字面量 Host 不在 harness 的受信任名单里（`--trusted-host` 只有 IPv4） | `upstreamAuthority()` 把 IPv6 字面量也折算成受信任的局域网 authority，Origin 同步改 |
| 这条路上没有 frpc，`isProxiedRequest` 为假 ⇒ 口令闸门会漏掉公网访客 | 新增 `needsAccessToken()`：**来源不在本机任何 /64 里**即视为公网 IPv6 ⇒ 必须带接入口令（自家 /64 内视为局域网，免口令） |

Windows 上同一个网卡会有 1 条稳定地址 + 若干条 RFC 4941 临时地址（会定期失效），所以：

面板与二维码一度加过 IPv6 入口（稳定地址、`v6=1` 二维码），**2026-10-06 深夜实测后撤下**：
用户此前折腾 NAS 时该路只通得了头几天，之后被掐；本轮实测本机出站 IPv6 一直正常、入站从外部不可达。
结论：**中国移动这条线上 IPv6 入站不可依赖**（前缀还会变），面板入口已移除，`v6=1` 二维码路由保留但不再暴露入口。

**入站要过的三道闸**（缺一不可，且都不是桥能控制的）：

1. Windows 防火墙：本项目默认只放行局域网网段，公网 IPv6 需重跑 `allow-firewall.ps1 -Wan`（管理员）；
2. 第三方安全软件：本机同时装了 360 主动防御与火绒（均带网络过滤驱动，不依赖 Windows 防火墙规则）—— 弹窗要点「允许」；
3. 路由器的 IPv6 入站防火墙：国内家用路由器默认拦公网入站，要单独放行。

诊断顺序（先分离电脑侧与路由器侧）：手机连**家里 Wi-Fi** 打开 `http://[稳定地址]:8099/` ——通 ⇒ 电脑侧没问题、流量下不通就是路由器拦的；不通 ⇒ 先跑 `-Wan` 并处理安全软件弹窗。

**桥侧加固保留**（与面板入口无关，纯防御性）：`needsAccessToken()` 把「来源不在本机任何 /64 里」的请求视为公网，照样要接入口令；
`upstreamAuthority()` 对 IPv6 字面量 Host 做归一化。两条都不影响内网/隧道路径。

**代价**：这条直连是**明文 HTTP**（隧道那条是 HTTPS），接入口令与 DSH 会话 cookie 都在明文里。要在直连上也要 HTTPS，需要给桥加 TLS（复用现有 Let's Encrypt 证书）+ 一个独立的 AAAA 记录 + 对应证书，属于下一步。
**配套诊断脚本**（`_checkpoints/_diag/mobile-bridge/`）：`bytes-probe.cjs`（整页字节与渲染检查）、`req-log.cjs`（逐条请求的编码/体积）、
`ae-matrix.cjs`、`br-test.cjs`、`bundle-scan.cjs`、`node-rtt.cjs`（节点 RTT 排名）、`wan-speed.cjs` / `wan-dl.cjs`（外网延迟与吞吐）、`prune-devices.cjs`（清设备台账）。


