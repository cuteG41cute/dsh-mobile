# dsh-mobile-app —— DeepSeek Harness（安卓）

把**这台电脑上的 DeepSeek Harness WebUI** 包成一个安卓 App。

> 关键点：**不依赖任何第三方插件**。不需要 `dsh-workspace` / `dsh-android-app`
> （那两个在 dsh 0.1.5 上已经跑不起来——见 `../share/dsh-android/getting-started.md` 顶部的作废说明）。

## 架构

```
手机 App（WebView）  --HTTP-->  dsh-mobile-bridge（电脑，0.0.0.0:8099）  --HTTP-->  dsh web（127.0.0.1:3080）
```

- **认证由桥完成**：桥按手机看到的来源现场签发会话 cookie，App 不做登录、不保存任何密码或密钥；
- **复用产品自己的 WebUI**：会话列表、流式输出、审批、文件、模型选择、上下文注入……全都是真的那一个；
- **App 只补手机该有的东西**：返回键、附件选择、下载、屏幕常亮、地址切换、错误页。

## 安装

**方式一（推荐，手机上直接装）**
1. 手机连同一个 Wi-Fi，浏览器打开 `http://192.168.1.23:8099/__bridge`
2. 点「下载安卓 App：DeepSeek Harness」→ 下载完点安装（首次需允许「安装未知应用」）

**方式二（用数据线）**
```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r "dsh-mobile-app\dist\dsh-mobile-1.0.0.apk"
```

当前产物：`dist/dsh-mobile-1.1.0.apk`（90 KB，Android 8.0+）
SHA256：`76B2D5A99061D949739C4A3434361439B6ECCAEE2BCCB0BB132A30C822C8D796`

> **v1.1.0**：去掉右上角常驻的 ⚙/⋮ 半透明按钮，换成**可拖动、自动变淡的悬浮球** + **原生设置页**。
> v1.0.1：窄屏会自动展开项目/会话列表（见下）。
> 旧版本归档在 `dist/archive/`；升级用同一个 keystore，可直接覆盖安装。

前提：电脑上 **dsh-mobile-bridge 在运行**（默认开机自启；也可双击桌面「启动 DSH 手机接入桥」）。

## 使用

- 首次启动会弹出「服务器地址」，默认 `http://192.168.1.23:8099` → 「保存并连接」；
- **扫码连接**（v1.2.0 起）：设置页的「扫码连接」调系统相机拍一张，二维码内容用 ZXing 就地解出，
  自动填好地址并重连（也可以「从相册里的二维码图片连接」）。二维码来自电脑上
  **设置 → 手机端**，扫的就是那一个：手机浏览器扫会打开网页版/下载 App，App 里扫就直接连上这台电脑；
- **悬浮球**（v1.1.0 起，替代原来的 ⚙/⋮）：
  - **点一下** → 打开**原生设置页**（服务器地址 / 保持屏幕常亮 / 项目·会话列表 / 刷新页面 / 在系统浏览器打开 / 关于）；
  - **长按** → 直接刷新页面；
  - **拖动** → 拖到任意位置，松手自动吸附到最近的左右边缘，位置会记住；
  - 闲置 2 秒后变淡到 45% 透明度，触摸即恢复，不挡内容；
  - 首次安装启动会直接进设置页填地址；
- **窄屏的侧栏**：产品在视口 < 1024px 时会把侧栏**自动折叠成 56px 轨道**（`dsh-client-ui-layout` 里的 `SIDEBAR_AUTO_COLLAPSE = 1024`），项目/会话列表要点轨道顶部那个按钮才会滑出。
  App 会在页面加载后**自动帮点一次**（只在确实折叠时），另外随时可用上面的菜单项手动切换；
- **返回键**：先回网页上一页，没有上一页时连按两次退出；
- 附件：产品输入框的回形针会唤起安卓的文件选择器，选完直接上传；
- 下载：走系统的 DownloadManager，文件落在手机「下载」目录；**自签证书的服务器**（见下条）改用应用内下载，Android 10+ 落在「下载/DeepSeek Harness」；
- **备用地址**（v1.3.7 起）：设置页可填第二个地址（家里 / 外网各一个）。打开时先试主用，4.5 秒没响应就自动切备用并提示；只填一个则**完全按老路径走**，不预检、不改变任何时序；
- **自签证书**（v1.3.7 起）：连到证书不被系统信任的服务器时，弹窗把证书的 **SHA-256 指纹**摊给用户核对，确认后记住（TOFU），此后只认这一张——中间人换一张立刻被拒。应用**不做「信任所有证书」**，也不预置任何例外；
- **连接诊断**（v1.3.7 起）：设置页一个按钮，对主用/备用地址各跑一遍 **DNS → TCP → TLS（含证书主体/有效期/指纹）→ HTTP(/__ping)**，逐层标 ✓/✗ 与耗时，直接看出是"解析不了"、"端口不通"还是"证书没信任"；
- 连不上时 App 会显示一个带「重试」的错误页，并提示三件该检查的事。

## 构建

无需 Gradle、无需 AndroidX，纯 SDK 命令行（用 Android Studio 自带的 JDK 与本机 SDK）：

```powershell
powershell -ExecutionPolicy Bypass -File dsh-mobile-app\build.ps1
# 可选参数：-JdkHome "..." -SdkRoot "..." -VersionCode 4 -VersionName 1.2.0 -CompileSdk 34 -SkipIcons
```

流程：`aapt2 compile` → `aapt2 link` → `javac` → `d8` → `tools/RepackApk.java` → `zipalign` → `apksigner`（v2+v3）。

**签名**：`keystore/dsh-mobile.jks`（storepass/keypass `dshmobile`，别名 `dshmobile`）。
升级必须用同一个 keystore，**别删**——否则只能卸载重装。

## 实现要点（维护者看）

| 关注点 | 做法 |
| --- | --- |
| 打包顺序 | `resources.arsc` 必须**不压缩**（targetSdk ≥ 30 的硬要求），所以自己写了 `tools/RepackApk.java` —— 这台机器上 .NET 的 `ZipArchive.CreateEntry(NoCompression)` 实测不生效，仍会被 deflate |
| 只连自己的服务器 | `shouldOverrideUrlLoading` 里比 host，其他域名交给系统浏览器 |
| 附件上传 | `onShowFileChooser` → `ACTION_GET_CONTENT` → `onActivityResult` 回填 |
| 扫码 | 不自己写相机预览：`MediaStore.ACTION_IMAGE_CAPTURE` 拍原图（输出写 MediaStore，不需要 FileProvider，API 29+ 也不需要存储权限）→ `QrScan` 用 ZXing core 解码（`HybridBinarizer` + `TRY_HARDER`，试 0/90/180/270 四个方向）。`libs/core-3.5.3.jar` 由 build.ps1 同时进 javac classpath 和 d8 输入，dex 因此从 91KB 涨到 321KB |
| 扫码用法 | 系统相机拍的照片常常是横的；实测 ZXing 对 90/180/270 旋转的二维码直接可解，多方向重试只是兜底 |
| 明文 HTTP | `network_security_config.xml` 允许 cleartext（局域网自用） |
| 自签证书 | `WebViewClient.onReceivedSslError` 默认**一律拒绝**，只有指纹等于用户记住的那张才 `proceed()`；原生请求（延迟球的 `/__ping`、自签下载）另建 **只认该指纹**的 `SSLContext`，与 WebView 侧信任一致。指纹按 `ssl_pin_<host>` 存 prefs，换服务器各记一份 |
| 地址回退 | 有备用地址时先在后台线程预检主用（4.5s 超时，**任何状态码都算通**），不通才切；`serverUrl` 只是"当前生效地址"，`onResume` 比的是配置里的主地址（`lastPrimary`），否则回退后会每次回前台都重载 |
| 自签下的下载 | 系统 DownloadManager 用不了我们的 pin → 该主机已 pin 且是 https 时改走 `PinnedDownload`：应用自己 GET（带 Cookie），Android 10+ 经 MediaStore 写「下载/DeepSeek Harness」（无需存储权限），8/9 写应用外部下载目录；进度直接画到浮球外圈 |
| 旋转/重建 | manifest 里 `configChanges` 全接管，避免 WebView 重载丢状态 |
| 调试 | 已开启 `setWebContentsDebuggingEnabled(true)`，电脑 Chrome 打开 `chrome://inspect` 可看手机页面控制台 |

## 已知边界

- 手机上的 WebUI 仍是**桌面版排版**（能滚动、能点，但没有专门的移动布局）；侧栏靠上面的自动展开/菜单项解决；
- 页面里几乎**没有 CSS 媒体查询**（只有 prefers-reduced-motion），窄屏行为全靠 JS 的 `viewportWidth < 1024` 判定——所以调试移动端问题要看布局 store，而不是 CSS；
- 产品里那个 📷 截图按钮依赖 `getDisplayMedia`，WebView 里不可用；
- 桥**不做登录**：8099 只应存在于可信局域网，不要做公网映射；
- 换 Wi-Fi / 换 IP 后需要重启一次 harness（启动器会重新登记 `--trusted-host`），App 里改地址即可；
- 扫码走的是系统相机 App（本应用不申请 CAMERA 权限）：个别机型相机返回的是缩略图而不是原图，
  这时会提示"没识别到二维码"，改用「从相册里的二维码图片连接」即可；
- 自签证书的服务器，**手机上的其它 App（含系统浏览器）依然会报证书错误**——只有本应用记得那张指纹；
- 「连接诊断」只看连通性，不走页面逻辑：第 ④ 步返回 403 属于正常（没带接入口令）。

## 后续可做（按价值排序）

1. 下拉刷新 + 会话切换的手势；
2. 审批/任务完成的通知（桥侧转发事件）；
3. 系统分享（选中文字 → 发进当前会话）；
4. 移动端 CSS 微调（侧栏抽屉化）；
5. 把桥的启动并入桌面版启动器（一次启动，桥随服务走）。
