#!/usr/bin/env node
/**
 * dsh-mobile-bridge —— 手机/平板接入本机 DeepSeek Harness 的局域网反向代理
 *
 * 为什么需要它：
 *   dsh web 只监听 127.0.0.1（上游出于安全明确拒绝 --host 0.0.0.0），
 *   而浏览器认证 cookie 是按「来源 authority（host:port）」签名的，
 *   所以手机既不能直连 3080，也不能靠简单端口转发。
 *
 * 它做什么：
 *   监听 0.0.0.0:<port>，把手机来的每个请求原样转发给 127.0.0.1:3080，
 *   转发时按手机看到的 authority 现场签发一枚合法的 dsh 会话 cookie 注入进去，
 *   于是手机浏览器无需任何 token/登录动作就能看到完整 WebUI。
 *   Host 头保持手机真实 authority ⇒ 上游 /api 的 Host/Origin 信任栅栏天然通过。
 *
 * 安全边界（务必知晓）：
 *   桥本身不做登录。任何能访问该端口的人 = 直接拿到本机 Harness 完整控制权
 *   （文件读写 + shell）。仅在可信的家庭局域网内使用，不要做公网端口映射。
 *
 * 用法：
 *   node bridge.cjs                  # 默认 0.0.0.0:8099 → 127.0.0.1:3080
 *   node bridge.cjs --port 9000
 *   DSH_BRIDGE_PORT=9000 node bridge.cjs
 */
"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

/* ------------------------------- 配置 ------------------------------- */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
// "::" = 双栈（同时收 IPv4 与 IPv6）。改成双栈是为了「公网 IPv6 直连家里」这条快路：
// 手机走 IPv6 直接连本机，不必绕境外的 frp 节点（实测绕韩国单程就要 242ms）。
const LISTEN_HOST = process.env.DSH_BRIDGE_HOST || argValue("--host") || "::";
const LISTEN_PORT = Number(process.env.DSH_BRIDGE_PORT || argValue("--port") || 8099);
const TARGET = new URL(process.env.DSH_BRIDGE_TARGET || argValue("--target") || "http://127.0.0.1:3080");
const COOKIE_DAYS = Number(process.env.DSH_BRIDGE_COOKIE_DAYS || 30); // 必须 <= 上游 cookieMaxAgeDays(默认 30)
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const CREDENTIALS = process.env.DSH_BRIDGE_CREDENTIALS || path.join(DSH_HOME, ".credentials.yaml");
const QUIET = process.argv.includes("--quiet");

/* --------------------- 运行日志（隐藏启动时唯一的线索） ---------------------
 * 自启动是无窗口的（VBS + wscript），崩了既没控制台也没人看得到。
 * 坑：WSH 的 sh.Run("cmd.exe /c ... >> log") 在本机**静默失败**——既不启动进程也不建文件
 * （已用最小探针复现；同一探针里 sh.Run 直接跑 node 是成功的）。
 * 所以日志一律由 node 自己写，不依赖任何 shell 重定向。
 * ------------------------------------------------------------------------- */
const LOG_FILE = process.env.DSH_BRIDGE_LOG || path.join(__dirname, "bridge.log");
function logLine(message) {
  // 注意：statSync 在文件不存在时**抛异常**，所以「查大小」和「写」必须分开 try——
  // 否则第一次运行（没有日志文件）时整条 logLine 都会被 catch 吞掉，一个字都写不出来。
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.truncateSync(LOG_FILE, 0);
  } catch (error) { /* 轮转失败无所谓 */ }
  try {
    fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] " + message + "\n");
  } catch (error) { /* 日志写不进去也不该影响桥 */ }
}
process.on("uncaughtException", function (error) {
  logLine("uncaughtException: " + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
process.on("unhandledRejection", function (reason) {
  logLine("unhandledRejection: " + (reason && reason.stack ? reason.stack : String(reason)));
});
process.on("exit", function (code) { logLine("exit code=" + code); });
logLine("start pid=" + process.pid + " node=" + process.version + " → " + LISTEN_HOST + ":" + LISTEN_PORT + " ⇒ " + TARGET.origin);

/* ============================== 外网（frp 内网穿透） ==============================
 * 手机在户外要连回来，就得把 8099 挂到公网。这里解决三件在隧道下才会暴露的问题：
 *
 * 1) 「本机」判据会被隧道击穿：frpc 在 127.0.0.1 上把公网流量转进来，于是每个公网访客的
 *    socket 来源都是 127.0.0.1 —— 旧判据（只看来源 IP）会把他们当成本机、自动认证、直接放行。
 *    现在要求「来源回环 **且** Host 也是回环」才算本机（桌面窗口正是后者；隧道域名不是）。
 *
 * 2) harness 的来源栅栏（dsh-client-connection/api-request-trust）要求
 *    Host 为回环或命中 --trusted-host，Origin 还要与 Host 一致 —— 隧道域名两者都不满足，
 *    所有 /api 都会 403。桥把「域名形式的 Host」在转发时**归一化成受信任的局域网 authority**
 *    （cookie 也按这个 authority 签），于是不必重启 harness、不必改 --trusted-host。
 *    局域网 IP 与回环 Host 保持原样，现有访问方式一点不变。
 *
 * 3) 公网入口需要一道口令：否则任何人扫到域名就能把你的设备审批队列刷满、看到等待页。
 *    口令只对「经隧道进来」的请求生效（回环 Host 的桌面窗口、局域网 IP 的手机都不受影响）。
 *    带 ?k=<口令> 访问一次即写入 cookie 并跳转到去掉参数的地址。
 * ========================================================================== */
const ACCESS_TOKEN_COOKIE = "dshm-key";

function isLoopbackAuthority(authority) {
  const host = String(authority || "").split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
function isIpLiteralAuthority(authority) {
  const host = String(authority || "").split(":")[0].replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(":") >= 0;
}
/** 经隧道（或其它本机反代）进来的请求：来源回环，但 Host 不是回环。 */
function isProxiedRequest(req) {
  const ip = (req.socket && req.socket.remoteAddress) || "";
  const loopbackIp = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  return loopbackIp && !isLoopbackAuthority(req.headers.host);
}
/* ---------------------- IPv6 直连（不走隧道的那条路） ---------------------
 * 运营商给的是公网 IPv6（2409:… 这类 GUA），手机在流量下也能直连本机 8099，
 * 速度等于局域网、完全没有隧道节点那一跳。两条要额外注意：
 *   ① 来源不在自家 /64 里 = 真正从公网进来，这条路上没有 frpc，口令必须照带；
 *   ② IPv6 字面量的 Host 不在 harness 的受信任名单里，转发时要折算成局域网 authority。
 * ------------------------------------------------------------------------ */
function isGlobalV6(ip) {
  const v = String(ip || "").toLowerCase();
  if (v.indexOf(":") < 0 || v === "::1" || v === "::") return false;
  if (/^fe[89ab]/.test(v)) return false;          // 链路本地 fe80::/10
  if (/^f[cd]/.test(v)) return false;             // 唯一本地 fc00::/7
  if (/^ff/.test(v)) return false;                // 组播
  return true;
}
function v6Prefix64(ip) { return String(ip || "").toLowerCase().split(":").slice(0, 4).join(":"); }
/** 本机自己拥有的公网 IPv6 /64（同前缀的来源算局域网）。 */
function ownV6Prefixes() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = typeof iface.family === "string" ? iface.family : (iface.family === 6 ? "IPv6" : "IPv4");
      if (family !== "IPv6" || iface.internal) continue;
      if (isGlobalV6(iface.address)) out.push(v6Prefix64(iface.address));
    }
  }
  return out;
}
/** 从公网 IPv6 直接进来的请求。 */
function isPublicV6Request(req) {
  const ip = String(clientIp(req) || "").replace(/^::ffff:/i, "");
  if (!isGlobalV6(ip)) return false;
  return ownV6Prefixes().indexOf(v6Prefix64(ip)) < 0;
}
/** 哪些来源必须带接入口令：经隧道进来的，以及从公网 IPv6 直连进来的。
 *  例外：ACME 的 HTTP-01 校验由 Let's Encrypt 匿名发起、且必须从公网到达，
 *  它只读取本地 acme/ 目录里那几个临时验证文件；挡在闸门外会让证书续期直接失败。 */
function needsAccessToken(req) {
  if (String(req.url || "").indexOf("/.well-known/acme-challenge/") >= 0) return false;
  return isProxiedRequest(req) || isPublicV6Request(req);
}
/** 转发给上游用的 authority：域名（隧道）统一折算成受信任的局域网地址，回环/IP 保持原样。 */
function upstreamAuthority(req) {
  const host = req.headers.host || "";
  if (!host || isLoopbackAuthority(host)) return host;
  // IPv4 字面量原样（局域网地址本来就在 harness 的受信任名单里）；
  // 域名（隧道）与 IPv6 字面量都要折算，否则过不了 harness 的来源栅栏。
  if (isIpLiteralAuthority(host) && String(host).indexOf(":") < 0) return host;
  const hosts = qrHosts();
  const lan = hosts.length ? hosts[0].address : "127.0.0.1";
  return lan + ":" + LISTEN_PORT;
}
/** 接入口令的自动轮换周期（天）。0 = 不自动换；可用 DSH_BRIDGE_TOKEN_DAYS 覆盖。
 *  轮换只影响「没被完全信任」的设备：trusted 设备在 passAccessToken 里直接放行（见那边注释），
 *  所以它们不会因为换口令而掉线——这正是「完全信任」的用途。 */
const TOKEN_DAYS = Number(process.env.DSH_BRIDGE_TOKEN_DAYS || 7);
function accessTokenAt() { return Number(deviceStore.accessTokenAt || 0); }
function tokenRotatesAt() { return TOKEN_DAYS > 0 && accessTokenAt() ? accessTokenAt() + TOKEN_DAYS * 86400000 : 0; }
/** 到点就换。老数据（有口令但没有签发时间）只补记时间，不当场换掉——否则升级那一刻所有人被踢。 */
function maybeRotateToken() {
  const at = accessTokenAt();
  if (!at) {
    if (deviceStore.accessToken) { deviceStore.accessTokenAt = Date.now(); saveDeviceStoreSoon(); }
    return false;
  }
  if (TOKEN_DAYS > 0 && Date.now() - at >= TOKEN_DAYS * 86400000) { rotateAccessToken("到期自动更换"); return true; }
  return false;
}
function accessToken() {
  if (process.env.DSH_BRIDGE_ACCESS_TOKEN) return process.env.DSH_BRIDGE_ACCESS_TOKEN;
  if (!deviceStore.accessToken) { rotateAccessToken("首次生成"); return deviceStore.accessToken; }
  maybeRotateToken();
  return deviceStore.accessToken;
}
function rotateAccessToken(reason) {
  deviceStore.accessToken = crypto.randomBytes(12).toString("hex");
  deviceStore.accessTokenAt = Date.now();
  saveDeviceStoreSoon();
  logLine("接入口令已更换" + (reason ? "（" + reason + "）" : "") + "；已「完全信任」的设备不受影响");
  return deviceStore.accessToken;
}
function wanUrl() { return deviceStore.wanUrl || ""; }
/** 外网二维码内容：外网地址 + 口令（手机扫一次就把 cookie 种好）。 */
function wanQrText() {
  const base = wanUrl();
  if (!base) return "";
  const token = accessToken();
  if (!token) return base;
  return base + (base.indexOf("?") >= 0 ? "&" : "/?") + "k=" + token;
}
/** 口令校验：只要求「经隧道进来的请求」带口令；带 ?k= 的首次访问会种 cookie 并跳转。 */
function passAccessToken(req, res, query) {
  const expected = accessToken();
  if (!expected || !needsAccessToken(req)) return true;
  // 口令是外网入口的闸门：**内网认证过 ≠ 外网可信**，所以认证设备照样要口令，
  // 除非管理员在设备管理里给这台设备点了「完全信任」（trusted）。
  const access = deviceAccess(req, deviceContext(req));
  if (access.approved && access.record && access.record.trusted === true) return true;
  const fromQuery = query.get("k");
  const fromCookie = parseCookies(req.headers.cookie)[ACCESS_TOKEN_COOKIE];
  if (fromQuery && fromQuery === expected) {
    const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
    url.searchParams.delete("k");
    const headers = {
      "location": url.pathname + (url.search || ""),
      "set-cookie": ACCESS_TOKEN_COOKIE + "=" + expected + "; Path=/; Max-Age=" + DEVICE_COOKIE_MAX_AGE + "; SameSite=Lax",
      "cache-control": "no-store"
    };
    res.writeHead(302, headers);
    res.end();
    return false;
  }
  if (fromCookie === expected) return true;
  logLine("外网入口被拦（缺口令）：ua=" + String(req.headers["user-agent"] || "").slice(0, 60));
  const html = [
    "<!doctype html><meta charset=\"utf-8\"><meta name=viewport content=\"width=device-width,initial-scale=1\">",
    "<title>需要口令</title><body style=\"font:15px/1.8 system-ui;padding:28px;color:#333;max-width:520px\">",
    "<h2 style=\"margin:0 0 10px\">需要接入口令</h2>",
    "<p>这个地址是外网入口。把口令填进下面这个框，或扫电脑上「设置 → 手机端 → 外网访问」里的二维码：</p>",
    "<form method=GET action=\"/\" style=\"display:flex;gap:8px;margin:14px 0\">",
    "<input name=k placeholder=\"接入口令\" autocomplete=off style=\"flex:1;font:inherit;padding:9px 11px;border:1px solid #d1d5db;border-radius:9px\">",
    "<button style=\"font:inherit;padding:9px 16px;border-radius:9px;border:1px solid #d1d5db;background:#f9fafb\">进入</button>",
    "</form>",
    "<p style=\"color:#6b7280;font-size:13px\">已经认证过的设备不需要口令（换了浏览器的老设备会重新要求一次）。</p></body>"
  ].join("");
  const body = Buffer.from(html, "utf8");
  res.writeHead(403, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
  return false;
}

/* ---------------------- 移动端适配注入（只对 HTML 生效） ----------------------
 * 产品 WebUI 没有移动端布局：窄屏展开侧栏会把中间栏挤到 ~130px（文字竖排），
 * 设置面板固定两列（nav+content）导致标签逐字换行。这里在返回 HTML 时插入一小段
 * CSS/JS 覆盖样式（不碰产品代码，不改状态、不发请求）。用 DSH_BRIDGE_NO_TWEAKS=1 关闭。
 * 文件缺失不影响桥运行。
 * ------------------------------------------------------------------------- */
const TWEAKS_DISABLED = Boolean(process.env.DSH_BRIDGE_NO_TWEAKS);
/** 按 mtime 缓存地读取注入文件：**改完存盘即生效，不用重启桥**（迭代时高频改动）。 */
const tweakCache = new Map();
function readTweak(name) {
  try {
    const file = path.join(__dirname, name);
    const stat = fs.statSync(file);
    const hit = tweakCache.get(name);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
    const text = fs.readFileSync(file, "utf8");
    tweakCache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text;
  } catch (error) { return ""; }
}
function tweakSnippet() {
  if (TWEAKS_DISABLED) return "";
  const css = readTweak("mobile-tweaks.css");
  const js = readTweak("mobile-tweaks.js");
  if (!css && !js) return "";
  return '<style id="dshm-css">' + css + '</style><script id="dshm-js">' + js + "</script>";
}
/** 语言：DSH 客户端在「没有显式 locale 偏好」时**看浏览器语言**（dsh-client-locale 里就是
 *  navigator.languages 的遍历），所以按设备换语言的正确姿势是：在客户端运行时启动前，
 *  同步把 navigator.language/languages 换掉。字符串本来就同时打包在 DSH 自己的 bundle 里，
 *  不需要我们另外准备语言包。代价：语言在启动时解析一次 ⇒ 改完要刷新页面。 */
function localeSnippet(deviceId) {
  const local = deviceNamespace(deviceId, "locale");
  const pref = local && local.value && local.value.preference;
  if (pref !== "zh" && pref !== "en") return "";
  const tag = pref === "zh" ? "zh-CN" : "en-US";
  return '<script id="dshm-locale">(function(){try{var L=' + JSON.stringify(tag)
    + ';Object.defineProperty(navigator,"language",{get:function(){return L}});'
    + 'Object.defineProperty(navigator,"languages",{get:function(){return [L]}});}catch(e){}})();</script>';
}
function injectLocale(html, deviceId) {
  const snippet = localeSnippet(deviceId);
  if (!snippet || html.indexOf('id="dshm-locale"') >= 0) return html;
  const head = html.match(/<head[^>]*>/i);
  if (!head) return html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}
function injectTweaks(html) {
  const snippet = tweakSnippet();
  if (!snippet || html.indexOf('id="dshm-css"') >= 0) return html;
  const head = html.indexOf("</head>");
  return head >= 0 ? html.slice(0, head) + snippet + html.slice(head) : html + snippet;
}

/* ------------- 按设备隔离的「通用设置」（语言 / 外观 / 字号） -------------
 * 需求：手机改这三项只影响手机，电脑改只影响电脑（互不覆盖）。
 * 桥天然是设备边界：手机走 0.0.0.0:8099（这一层），电脑直连 127.0.0.1:3080（不经过这里）。
 *
 * 产品的机制（dsh-client-ui-theme / dsh-client-locale）：
 *   · 每个 index 响应里嵌了一段首帧引导脚本（bootThemeScript 生成）：
 *       const preference = "system" ... document.body.style.setProperty('--dsh-content-font-size', "14px")
 *   · 读：POST /api/settings/describe → result.value.namespaces[] 里带 ns / value / user / revision
 *   · 写：POST /api/settings/mutate（也可能 update / replace）→ payload.args = { ns, ops|patch|section, expectedRevision }
 *
 * 因此这里做四件事：
 *   1) 给每台设备发一枚长期 cookie（dshm-device），它的设置存 device-settings.json；
 *   2) index 响应里改写上面那两处字面量 → 首帧就是这台设备的配色和字号；
 *   3) describe 响应里把这两个命名空间的 value/user 换成该设备的值；
 *   4) 命中这两个命名空间的**写请求不上行**，只落本设备存储，并合成一份与上游同形的响应
 *      （schema 用之前 describe 缓存下来的，保证客户端校验通过）。
 * 关掉：DSH_BRIDGE_DEVICE_SETTINGS=0
 * ------------------------------------------------------------------------- */
const DEVICE_SETTINGS_ON = process.env.DSH_BRIDGE_DEVICE_SETTINGS !== "0";
/** 「设置 → 手机端」面板：见文件末尾 injectPanelEntry（条目格式要求见那边注释）。 */
const PANEL_ENABLED_BUILD = true;
const DEVICE_COOKIE = "dshm-device";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5;
/** 只有这三个设置项按设备隔离（用户明确要求的：语言 / 外观 / 字号）。 */
const DEVICE_NAMESPACES = ["ui-theme", "locale"];
/** unset 时回落到什么（与产品 schema 默认值一致）。 */
const NS_DEFAULTS = { "ui-theme": { preference: "system", fontSize: 14 }, locale: {} };
/** 产品字号步进是 12–17px（见 dsh-client-ui-theme）；客户端方案里我们沿用同一区间。 */
const FONT_MIN = 12, FONT_MAX = 17;
const PREFERENCES = ["system", "light", "dark"];
const SETTINGS_DESCRIBE_PATH = "/api/settings/describe";
const SETTINGS_WRITE_PATHS = new Set(["/api/settings/mutate", "/api/settings/update", "/api/settings/replace"]);
const DEVICE_STORE_FILE = process.env.DSH_BRIDGE_DEVICE_STORE || path.join(__dirname, "device-settings.json");

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function loadDeviceStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVICE_STORE_FILE, "utf8"));
    if (parsed && typeof parsed === "object") {
      parsed.devices = parsed.devices || {};
      parsed.serverValues = parsed.serverValues || {};
      return parsed;
    }
  } catch (error) { /* 首次运行没有这个文件 */ }
  return { devices: {}, serverValues: {} };
}
let deviceStore = DEVICE_SETTINGS_ON ? loadDeviceStore() : { devices: {}, serverValues: {} };
let deviceStoreDirty = false;
let deviceStoreTimer = null;
function saveDeviceStoreSoon() {
  deviceStoreDirty = true;
  if (deviceStoreTimer) return;
  deviceStoreTimer = setTimeout(function () {
    deviceStoreTimer = null;
    if (!deviceStoreDirty || !DEVICE_SETTINGS_ON) return;
    deviceStoreDirty = false;
    try { fs.writeFileSync(DEVICE_STORE_FILE, JSON.stringify(deviceStore, null, 2) + "\n"); }
    catch (error) { logLine("设备设置写盘失败：" + (error && error.message)); }
  }, 250);
}
/** 设置覆盖挂在**设备**（特征码）上而不是浏览器实例上：换个浏览器，语言/外观/字号照样跟着走。 */
function deviceSettingsKey(instanceId) {
  if (!instanceId) return "";
  return fingerprintOfInstance(instanceId) || ("instance:" + instanceId);
}
function deviceSettingsRecord(instanceId, create) {
  const key = deviceSettingsKey(instanceId);
  if (!key) return null;
  let holder;
  if (key.indexOf("instance:") === 0) {
    holder = deviceStore.devices[instanceId] || (create ? (deviceStore.devices[instanceId] = { firstSeen: new Date().toISOString(), namespaces: {} }) : null);
  } else {
    const record = knownDevices()[key];
    if (!record) return null;
    holder = record;
  }
  if (!holder) return null;
  if (!holder.namespaces && create) holder.namespaces = {};
  return holder;
}
/** 解析当前设备的设置（无则返回 null，表示「跟随电脑」）。 */
function deviceNamespace(deviceId, ns) {
  const holder = deviceSettingsRecord(deviceId, false);
  if (!holder || !holder.namespaces) return null;
  return holder.namespaces[ns] || null;
}
function ensureDeviceNamespace(deviceId, ns, label) {
  const record = deviceSettingsRecord(deviceId, true);
  if (!record) return { value: clone(NS_DEFAULTS[ns]) || {}, user: {} };
  record.label = label || record.label;
  record.lastSeen = Date.now();
  if (!record.namespaces) record.namespaces = {};
  if (!record.namespaces[ns]) {
    // 首次改写时，以「当时电脑上的值」为种子：之后这台设备就与电脑解耦了
    const seed = deviceStore.serverValues[ns] !== undefined ? clone(deviceStore.serverValues[ns]) : clone(NS_DEFAULTS[ns]);
    record.namespaces[ns] = { value: seed || {}, user: {} };
  }
  return record.namespaces[ns];
}
/** 把 mutate/update/replace 三种写法都折算到 { value, user } 上（这两个命名空间都是扁平结构）。 */
function applyNamespaceWrite(current, ns, args) {
  const defaults = NS_DEFAULTS[ns] || {};
  if (Array.isArray(args.ops)) {
    for (const op of args.ops) {
      const keys = Array.isArray(op.path) ? op.path : [];
      if (keys.length !== 1) continue;                      // 只支持扁平字段
      const key = keys[0];
      if (op.op === "unset") {
        delete current.user[key];
        if (defaults[key] === undefined) delete current.value[key];
        else current.value[key] = clone(defaults[key]);
      } else {
        current.value[key] = clone(op.value);
        current.user[key] = clone(op.value);
      }
    }
    return;
  }
  const patch = args.patch && typeof args.patch === "object" ? args.patch : (args.section && typeof args.section === "object" ? args.section : null);
  if (!patch) return;
  for (const key of Object.keys(patch)) { current.value[key] = clone(patch[key]); current.user[key] = clone(patch[key]); }
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function deviceContext(req) {
  const existing = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  if (existing && /^[0-9a-f]{8,32}$/.test(existing)) return { id: existing, isNew: false, blocked: isBlocked(existing) };
  if (!DEVICE_SETTINGS_ON) return { id: "", isNew: false, blocked: false };
  return { id: crypto.randomBytes(9).toString("hex"), isNew: true, blocked: false };
}
function attachDeviceCookie(headers, device) {
  if (!device || !device.isNew || !device.id) return headers;
  const value = DEVICE_COOKIE + "=" + device.id + "; Path=/; Max-Age=" + DEVICE_COOKIE_MAX_AGE + "; SameSite=Lax";
  const existing = headers["set-cookie"];
  headers["set-cookie"] = existing ? [].concat(existing, value) : [value];
  return headers;
}

/* ------------- 设备身份：粗粒度特征码 → 随机 ID → 本机认证 -------------
 * 为什么不能只看 cookie：cookie 是「浏览器实例」的身份——换浏览器、清一次数据就变成一台
 * 新设备，于是同一台手机被数成好几台（用户实测：只有两台设备却显示六台）。
 *
 * 特征码只取**机型级、非隐私**的公共特征：
 *   OS 家族 + 屏幕短边×长边 + 像素比 + CPU 核数 + 内存档位 + 触摸点数 + 时区 + 主语言
 * 刻意不碰 canvas/WebGL/音频/字体这类「指纹追踪」技术，也不含任何硬件序列号、账号、MAC。
 * 同型号手机会得到同一个特征码——对「认设备」够用，对「认人」不够，这正是隐私上想要的。
 * 特征码在桥内只以「加盐 SHA-256」的形式存在（盐随机、随存储持久化），从不出现在界面或日志里；
 * 对外一律用随机分配的 ID（如 D-7F3A-2C91）+ 设备名。
 *
 * 认证：新特征码先记成「待认证」，必须在本机（设置 → 手机端 → 设备管理）点 ✓ 才放行；
 * 已认证的特征码换浏览器也认得出，不再要求认证。
 * ------------------------------------------------------------------------- */
const TRAITS_VERSION = 2;   // v2：纳入安卓 App 提供的设备级标识（见 normalizeTraits.appId）
const DEVICE_TOKEN_COOKIE = "dshm-token";
const STATE_PENDING = "pending";
const STATE_APPROVED = "approved";
const STATE_DENIED = "denied";

function traitSalt() {
  if (!deviceStore.salt) {
    deviceStore.salt = crypto.randomBytes(16).toString("hex");
    saveDeviceStoreSoon();
  }
  return deviceStore.salt;
}
/** 只留稳定、粗粒度的字段；屏幕宽高排序后再用（横竖屏切换不能让设备「变成另一台」）。 */
function normalizeTraits(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const s = t.screen && typeof t.screen === "object" ? t.screen : {};
  const w = Number(s.w) || 0;
  const h = Number(s.h) || 0;
  // 安卓 App 能拿到 ANDROID_ID（无需权限、不弹窗）——已在 App 内哈希过，这里只收 16~64 位十六进制。
  // 有这个字段，指纹就从「机型级」精确到「设备个体」；浏览器里没有它，退回机型级。
  const appId = String(t.appId || "").toLowerCase();
  // 幂等：记录里存的就是归一化后的形态（screen 已是 "385x854" 字符串）。
  // 不认这一点的话，把已归一化的特征再喂进来会得到 "0x0"、dpr=1 —— 合并设备时正是这么被写坏的。
  const normalizedScreen = typeof t.screen === "string" && /^\d+x\d+$/.test(t.screen) ? t.screen : "";
  return {
    appId: /^[0-9a-f]{16,64}$/.test(appId) ? appId : "",
    os: String(t.os || "").slice(0, 16),
    screen: normalizedScreen || (Math.min(w, h) + "x" + Math.max(w, h)),
    dpr: normalizedScreen ? Math.round((Number(t.dpr) || 1) * 100) / 100 : Math.round((Number(s.dpr) || 1) * 100) / 100,
    cores: Math.min(Number(t.cores) || 0, 32),
    memory: Number(t.memory) || 0,
    touch: Math.min(Number(t.touch) || 0, 20),
    tz: String(t.tz || "").slice(0, 40),
    lang: String(t.lang || "").slice(0, 8)
  };
}
function describeTraits(traits) {
  const t = normalizeTraits(traits);
  const os = t.os || "未知系统";
  // appId 存在 = 这是「设备个体」级身份（安卓 App 报上来的），浏览器只到机型级
  return os + " · " + t.screen + (t.dpr && t.dpr !== 1 ? "@" + t.dpr + "x" : "") + (t.appId ? " · 设备唯一" : "");
}
function fingerprintOf(traits) {
  const t = normalizeTraits(traits);
  const parts = [TRAITS_VERSION, t.appId || "-", t.os, t.screen, t.dpr, t.cores, t.memory, t.touch, t.tz, t.lang];
  return crypto.createHash("sha256").update(traitSalt() + "|" + parts.join("|")).digest("hex").slice(0, 16);
}
/** 这个字段有没有「值」。浏览器报不出 deviceMemory（是 0），而 App 的 WebView 能报 8 ——
 *  这类「一边知道、一边不知道」的字段不能拿来判定「不是同一台」。 */
function traitKnown(value) { return !(value === undefined || value === null || value === "" || value === 0); }
/** 两条特征算不算同一台机器：逐字段比，任一边未知就跳过该字段；
 *  appId 两边都有且不同 = 两台不同的机器（同型号也不并）。 */
function traitsSameDevice(a, b) {
  const x = normalizeTraits(a);
  const y = normalizeTraits(b);
  if (x.appId && y.appId && x.appId !== y.appId) return false;
  const fields = ["os", "screen", "dpr", "cores", "memory", "touch", "tz", "lang"];
  for (const field of fields) {
    if (!traitKnown(x[field]) || !traitKnown(y[field])) continue;
    if (String(x[field]) !== String(y[field])) return false;
  }
  return true;
}
/** 合并两套特征：有值的一方胜出（App 报的 memory=8 会盖掉浏览器的未知 0；appId 优先保留）。 */
function traitsMerge(a, b) {
  const x = normalizeTraits(a);
  const y = normalizeTraits(b);
  const out = {};
  for (const field of Object.keys(x)) {
    if (field === "appId") { out.appId = x.appId || y.appId; continue; }
    out[field] = traitKnown(x[field]) ? x[field] : y[field];
  }
  return out;
}
/** 把本次上报的特征解析到既有设备上：
 *  ① 特征码完全一致（含 appId）→ 就是它；
 *  ② 否则找「同一台机器」的既有记录（未知字段当通配）→ 并过去（手机 App ↔ 手机浏览器因此算一台）；
 *  ③ 都不中才新建。
 *  两台同型号手机都装了 App 时各自带 appId，① 已经把她们分开，② 不会误并。 */
function resolveDevice(traits) {
  const strict = fingerprintOf(traits);
  const known = knownDevices();
  if (known[strict]) return { fp: strict, record: known[strict], merged: false };
  const hits = Object.keys(known).filter(function (key) { return traitsSameDevice(known[key].traits, traits); });
  if (hits.length) {
    hits.sort(function (a, b) { return (known[b].lastSeen || 0) - (known[a].lastSeen || 0); });
    return { fp: hits[0], record: known[hits[0]], merged: true };
  }
  return { fp: strict, record: null, merged: false };
}
function randomDeviceId() {
  const hex = crypto.randomBytes(4).toString("hex").toUpperCase();
  return "D-" + hex.slice(0, 4) + "-" + hex.slice(4);
}
function deviceNameFor(traits) {
  switch (normalizeTraits(traits).os) {
    case "Android": return "安卓手机";
    case "iOS": return "iPhone / iPad";
    case "Windows": return "Windows 电脑";
    case "macOS": return "Mac";
    case "Linux": return "Linux 电脑";
    default: return "未知设备";
  }
}
function knownDevices() {
  if (!deviceStore.known || typeof deviceStore.known !== "object") deviceStore.known = {};
  return deviceStore.known;
}
function uniqueDeviceName(base) {
  const known = knownDevices();
  const used = Object.keys(known).map(function (key) { return known[key].name; });
  if (used.indexOf(base) < 0) return base;
  for (let i = 2; i < 99; i++) if (used.indexOf(base + " " + i) < 0) return base + " " + i;
  return base;
}
function ensureKnownDevice(fp, traits, ip) {
  const known = knownDevices();
  const now = Date.now();
  let record = known[fp];
  if (!record) {
    record = known[fp] = {
      id: randomDeviceId(),
      name: uniqueDeviceName(deviceNameFor(traits)),
      state: STATE_PENDING,
      firstSeen: now,
      lastSeen: now,
      traits: normalizeTraits(traits),
      ips: [],
      instances: [],
      namespaces: {}
    };
    logLine("新设备待认证 " + record.id + "（" + record.name + " · " + describeTraits(traits) + "）");
  }
  record.lastSeen = now;
  // 用合并而不是覆盖：App 上报的 appId / memory 不能被随后来的浏览器请求抹掉
  // （浏览器报 deviceMemory=0、也没有 appId；覆盖会把「设备唯一」和个体识别一起丢掉）。
  record.traits = traitsMerge(record.traits, traits);
  record.platform = describeTraits(record.traits);
  if (ip && record.ips.indexOf(ip) < 0) record.ips = record.ips.concat(ip).slice(-4);
  saveDeviceStoreSoon();
  return record;
}
function knownByDeviceId(deviceId) {
  const known = knownDevices();
  for (const fp of Object.keys(known)) if (known[fp].id === deviceId) return { fp: fp, record: known[fp] };
  return null;
}
/** 实例（cookie）→ 特征码的关联：清了 cookie 也能靠特征码认出是同一台设备。 */
function fingerprintOfInstance(instanceId) {
  const record = instanceId ? deviceStore.devices[instanceId] : null;
  return record && record.fp ? record.fp : "";
}
function linkInstanceToFingerprint(instanceId, fp) {
  if (!instanceId || !fp) return;
  const record = deviceStore.devices[instanceId] || (deviceStore.devices[instanceId] = { firstSeen: new Date().toISOString(), namespaces: {} });
  record.fp = fp;
  const known = knownDevices()[fp];
  if (known && known.instances.indexOf(instanceId) < 0) known.instances = known.instances.concat(instanceId).slice(-8);
  saveDeviceStoreSoon();
}
/** 放行凭据：HMAC(盐, 特征码)。只有 state=approved 的特征码才签得出有效凭据。 */
function deviceTokenFor(fp) {
  return "v1." + fp + "." + crypto.createHmac("sha256", traitSalt()).update(fp, "utf8").digest("hex").slice(0, 32);
}
function approvedFingerprintOf(req) {
  const token = parseCookies(req.headers.cookie)[DEVICE_TOKEN_COOKIE];
  if (!token || token.indexOf("v1.") !== 0) return "";
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  const fp = parts[1];
  if (deviceTokenFor(fp) !== token) return "";           // 伪造/过期
  const record = knownDevices()[fp];
  return record && record.state === STATE_APPROVED ? fp : "";
}
function attachTokenCookie(headers, fp) {
  const value = DEVICE_TOKEN_COOKIE + "=" + deviceTokenFor(fp) + "; Path=/; Max-Age=" + DEVICE_COOKIE_MAX_AGE + "; SameSite=Lax";
  const existing = headers["set-cookie"];
  headers["set-cookie"] = existing ? [].concat(existing, value) : [value];
  return headers;
}
/** 本机 = 来源回环 **且** Host 也是回环。
 *  只看来来源 IP 会被隧道击穿：frpc 把公网流量从 127.0.0.1 转进来，那样全网访客都成了「本机」。 */
function isLocalRequest(req) {
  const ip = clientIp(req);
  const loopbackIp = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  return loopbackIp && isLoopbackAuthority(req.headers.host);
}
/** 这台设备现在能不能进应用。 */
function deviceAccess(req, device) {
  const local = isLocalRequest(req);
  const fp = approvedFingerprintOf(req) || fingerprintOfInstance(device.id);
  const record = fp ? knownDevices()[fp] : null;
  if (record && record.state === STATE_APPROVED) return { approved: true, local: local, fp: fp, record: record };
  if (local) return { approved: true, local: true, fp: fp, record: record };   // 本机（桌面窗口）永远放行，否则没人能点「允许」
  return { approved: false, local: false, fp: fp, record: record, state: record ? record.state : "unknown" };
}
/** 手机端面板的权限分级。
 *  口令是「外网入口的凭证」——把它展示给正是被它拦在门外的那些设备，等于自毁闸门。
 *   local   本机窗口（回环 Host）：审批、口令、二维码、轮换，全部功能
 *   trusted 已「完全信任」的设备：可以管理设备（踢出 / 取消信任），但看不到口令与外网二维码
 *   device  其它已认证设备：只看得到自己这一台的状态
 *   none    未认证（面板本来也进不去） */
function panelScope(req, device) {
  // 应急开关：DSH_BRIDGE_PANEL_OPEN=1 时恢复旧行为（任何已认证设备都当本机视图，能看口令）。
  // 只有手动带环境变量启动 bridge 才用得上；默认关。
  if (process.env.DSH_BRIDGE_PANEL_OPEN === "1") return "local";
  if (isLocalRequest(req)) return "local";
  const access = deviceAccess(req, device);
  if (!access.approved) return "none";
  if (access.record && access.record.trusted === true) return "trusted";
  return "device";
}
/** 面板动作的权限闸门：true = 放行。 */
function panelGuard(req, res, allowed, what) {
  const scope = panelScope(req, deviceContext(req));
  if (allowed.indexOf(scope) >= 0) return true;
  jsonResponse(res, 403, {
    ok: false, scope: scope,
    error: (what || "这个操作") + "需要在电脑的「设置 → 手机端」里做"
      + (scope === "trusted" ? "（「完全信任」的设备可以管理设备，但看不到接入口令）" : "")
  });
  return false;
}
/** 等待本机确认的页面（自带特征码上报 + 轮询，确认后自动跳转）。 */
function waitingPage(req, res, device, access) {
  const pending = access.record;
  const title = !pending ? "等待本机确认" : (pending.state === STATE_DENIED ? "这台设备被拒绝了" : "等待本机确认");
  const hint = !pending
    ? "正在把你的设备信息发给电脑…"
    : (pending.state === STATE_DENIED
      ? "管理员拒绝了这台设备的接入请求。如果这是误操作，请在电脑的「设置 → 手机端 → 设备管理」里恢复。"
      : "已向电脑发送接入请求。请在电脑上打开「设置 → 手机端 → 设备管理」，点这台设备的 ✓ 允许。");
  const html = [
    "<!doctype html><meta charset=\"utf-8\">",
    "<meta name=viewport content=\"width=device-width,initial-scale=1\">",
    "<title>" + title + "</title>",
    "<style>",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    "font:15px/1.75 system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f1115;color:#e5e7eb}",
    ".card{max-width:420px;padding:28px 24px;text-align:center}",
    ".dot{width:44px;height:44px;border-radius:50%;border:3px solid #4d6bfe;border-top-color:transparent;",
    "margin:0 auto 18px;animation:spin 1s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    ".id{margin-top:14px;font-family:ui-monospace,Consolas,monospace;font-size:20px;letter-spacing:.06em;color:#9ecbff}",
    ".name{margin-top:4px;color:#9ca3af;font-size:14px}",
    ".hint{margin-top:18px;color:#9ca3af;font-size:13.5px}",
    ".stop .dot{animation:none;border-color:#ef4444}",
    "</style>",
    "<div class=card id=card><div class=dot></div><div style=\"font-size:17px;font-weight:600\">" + title + "</div>",
    "<div class=hint>" + hint + "</div>",
    "<div class=id id=devid>" + (pending ? pending.id : "…") + "</div>",
    "<div class=name id=devname>" + (pending ? pending.name + " · " + (pending.platform || "") : "") + "</div>",
    "</div>",
    "<script>",
    "function appDeviceId(){",
    "  try {",
    "    if (window.__dshAppDevice && typeof window.__dshAppDevice.deviceId === 'function') {",
    "      var v=String(window.__dshAppDevice.deviceId()||'').toLowerCase();",
    "      return /^[0-9a-f]{16,64}$/.test(v) ? v : '';",
    "    }",
    "  } catch(e) {}",
    "  return '';",
    "}",
    "function collectTraits(){",
    "  var ua=navigator.userAgent||'';",
    "  var os='未知';",
    "  if(/Android/i.test(ua)) os='Android';",
    "  else if(/iPhone|iPad|iPod/i.test(ua)) os='iOS';",
    "  else if(/Windows/i.test(ua)) os='Windows';",
    "  else if(/Macintosh|Mac OS X/i.test(ua)) os='macOS';",
    "  else if(/Linux/i.test(ua)) os='Linux';",
    "  return { appId:appDeviceId(), os:os, cores:navigator.hardwareConcurrency||0, memory:navigator.deviceMemory||0,",
    "    touch:navigator.maxTouchPoints||0,",
    "    screen:{ w:screen.width, h:screen.height, dpr:devicePixelRatio||1 },",
    "    tz:(function(){ try { return Intl.DateTimeFormat().resolvedOptions().timeZone||''; } catch(e){ return ''; } })(),",
    "    lang:(navigator.language||'').split('-')[0] };",
    "}",
    "var stopped=false;",
    "function show(id,name,platform){ if(id) document.getElementById('devid').textContent=id; if(name) document.getElementById('devname').textContent=name+(platform?(' · '+platform):''); }",
    "function ask(){",
    "  return fetch('/__hello',{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(collectTraits())})",
    "    .then(function(r){return r.json();});",
    "}",
    "function loop(){",
    "  ask().then(function(info){",
    "    show(info.id, info.name, info.platform);",
    "    if(info.state==='approved'){ location.replace('/'); return; }",
    "    if(info.state==='denied'){ document.getElementById('card').className='card stop'; document.querySelector('.hint').textContent='管理员拒绝了这台设备的接入请求。'; return; }",
    "    setTimeout(loop, 2000);",
    "  }).catch(function(){ setTimeout(loop, 3000); });",
    "}",
    "loop();",
    "<\/script>"
  ].join("");
  const body = Buffer.from(html, "utf8");
  const headers = { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store" };
  attachDeviceCookie(headers, device);
  res.writeHead(200, headers);
  res.end(body);
}
/** POST /__hello：页面把粗粒度特征发上来 → 认设备 / 建待认证记录 / 发凭据。 */
function serveHello(req, res, device) {
  // 只认 POST：空 body 的 GET（健康检查、爬虫、误点）不该在设备名册里留下「未知设备」
  if (req.method !== "POST") return jsonResponse(res, 405, { ok: false, error: "请用 POST 上报设备特征" });
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", function (chunk) {
    size += chunk.length;
    if (size > 64 * 1024) { aborted = true; req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("aborted", function () { aborted = true; });
  req.on("end", function () {
    if (aborted) return;
    let traits = null;
    try { traits = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (error) { traits = null; }
    if (!traits) return jsonResponse(res, 400, { ok: false, error: "特征数据解析失败" });
    const normalized = normalizeTraits(traits);
    if (!normalized.os && normalized.screen === "0x0") {
      return jsonResponse(res, 400, { ok: false, error: "特征数据不完整（缺少系统/屏幕信息），不登记设备" });
    }
    const resolved = resolveDevice(traits);
    const fp = resolved.fp;
    if (resolved.merged && resolved.record) {
      logLine("特征与既有设备吻合，并入 " + resolved.record.id + "（" + resolved.record.name + "）");
    }
    const record = ensureKnownDevice(fp, traits, clientIp(req));
    linkInstanceToFingerprint(device.id, fp);
    if (isLocalRequest(req) && record.state !== STATE_DENIED) record.state = STATE_APPROVED;   // 本机自动认证
    const headers = {};
    if (record.state === STATE_APPROVED) attachTokenCookie(headers, fp);
    attachDeviceCookie(headers, device);
    const body = Buffer.from(JSON.stringify({
      ok: true,
      id: record.id,
      name: record.name,
      platform: record.platform || describeTraits(traits),
      state: record.state
    }), "utf8");
    headers["content-type"] = "application/json; charset=utf-8";
    headers["content-length"] = body.length;
    headers["cache-control"] = "no-store";
    res.writeHead(200, headers);
    res.end(body);
  });
}
/** POST /__approve?id= / __deny?id= / __kick?id= —— 都以「随机 ID」指代设备。 */
function setDeviceState(req, res, query, state) {
  const found = knownByDeviceId(query.get("id"));
  if (!found) return jsonResponse(res, 404, { ok: false, error: "没有这台设备" });
  found.record.state = state;
  found.record.stateChangedAt = Date.now();
  saveDeviceStoreSoon();
  let killed = 0;
  if (state !== STATE_APPROVED) {
    for (const instanceId of found.record.instances) {
      const live = deviceRegistry.get(instanceId);
      if (!live) continue;
      for (const socket of live.openSockets) { try { socket.destroy(); killed++; } catch (error) { /* 已断 */ } }
      live.openSockets.clear();
      live.sockets = 0;
    }
  }
  logLine("设备 " + found.record.id + " → " + state + (killed ? "（断开 " + killed + " 条连接）" : ""));
  jsonResponse(res, 200, { ok: true, id: found.record.id, state: state, killed: killed });
}


/** 客户端会按 zod schema 校验结果，所以合成写响应时必须沿用上游下发的 schema。 */
const cachedSettingsSchema = {};
/** index 响应里的首帧引导脚本：按设备改写配色与字号（语言不嵌在 HTML 里，靠 describe）。 */
function rewriteBootTheme(html, deviceId) {
  const local = deviceNamespace(deviceId, "ui-theme");
  if (!local || !local.value) return html;
  let out = html;
  try {
    if (typeof local.value.preference === "string") out = out.replace(/const preference = "[^"]*"/, 'const preference = "' + local.value.preference + '"');
    if (typeof local.value.fontSize === "number") out = out.replace(/('--dsh-content-font-size',\s*)"[0-9.]+px"/, "$1\"" + local.value.fontSize + "px\"");
  } catch (error) { logLine("改写首帧引导脚本失败：" + (error && error.message)); return html; }
  return out;
}
/** describe 响应：把这三个设置项换成本设备的值；同时记下上游的解析值/schema 备用。 */
function rewriteDescribe(text, deviceId) {
  let message;
  try { message = JSON.parse(text); } catch (error) { return null; }
  const value = message && message.result && message.result.ok ? message.result.value : null;
  if (!value || !Array.isArray(value.namespaces)) return null;
  let changed = false;
  let learned = false;
  for (const entry of value.namespaces) {
    if (!entry || DEVICE_NAMESPACES.indexOf(entry.ns) < 0) continue;
    if (entry.value !== undefined) { deviceStore.serverValues[entry.ns] = clone(entry.value); learned = true; }
    if (entry.schema !== undefined) cachedSettingsSchema[entry.ns] = entry.schema;
    const local = deviceNamespace(deviceId, entry.ns);
    if (!local) continue;                                  // 还没改过 → 跟随电脑
    entry.value = clone(local.value) || {};
    entry.user = clone(local.user) || {};
    changed = true;
  }
  if (learned || changed) saveDeviceStoreSoon();
  return changed ? JSON.stringify(message) : null;
}
/** 写请求：命中这三个设置项就就地处理（绝不转发，否则会改到电脑那份 settings.yaml）。 */
/** GET/POST /__display —— 本设备的显示设置（外观 / 字号）。
 *  客户端方案：值存在桥这边，由注入的 JS 在页面里应用（用 DSH 自己那三行写法，观感与原生一致），
 *  不再去挂 DSH 的设置接口 —— 那套已经改成 remote/mux RPC，挂一次碎一次。
 *  任何「已认证设备」都只能改自己那一份；clear=1 = 清除覆盖（回到「跟随电脑」）。 */
function serveDisplay(req, res, device, query) {
  const access = deviceAccess(req, device);
  if (!access.approved) return jsonResponse(res, 403, { ok: false, error: "设备未认证" });
  const record = deviceSettingsRecord(device.id, false);
  const current = (record && record.namespaces && record.namespaces["ui-theme"] && record.namespaces["ui-theme"].value) || null;
  const payload = function (value) {
    return { ok: true, value: value, inherited: !value, range: [FONT_MIN, FONT_MAX], defaultPreference: NS_DEFAULTS["ui-theme"].preference };
  };
  if (req.method !== "POST") return jsonResponse(res, 200, payload(current));
  const label = access.record ? access.record.id : "?";
  if (query.get("clear") === "1") {
    if (record && record.namespaces) delete record.namespaces["ui-theme"];
    saveDeviceStoreSoon();
    logLine("设备 " + label + " 的显示设置已清除（回到跟随电脑）");
    return jsonResponse(res, 200, payload(null));
  }
  const value = Object.assign({}, current || {});
  const pref = query.get("preference");
  if (pref) value.preference = PREFERENCES.indexOf(pref) >= 0 ? pref : NS_DEFAULTS["ui-theme"].preference;
  const lang = query.get("locale");
  if (lang) {
    const slot = ensureDeviceNamespace(device.id, "locale", access.record ? access.record.name : "");
    if (lang === "clear") { delete slot.value; }
    else { slot.value = { preference: lang === "en" ? "en" : "zh" }; }
    saveDeviceStoreSoon();
    logLine("设备 " + label + " 语言 → " + (lang === "clear" ? "跟随浏览器" : lang));
  }
  const size = Number(query.get("fontSize"));
  if (Number.isFinite(size) && size > 0) value.fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)));
  const slot = ensureDeviceNamespace(device.id, "ui-theme", access.record ? access.record.name : "");
  slot.value = value;
  saveDeviceStoreSoon();
  logLine("设备 " + label + " 显示设置 → " + JSON.stringify(value));
  return jsonResponse(res, 200, payload(value));
}
/** GET /__device —— 查看本设备的覆盖；带 ?reset=1 则清空（回到「跟随电脑」，刷新页面后生效）。 */
function serveDeviceInfo(req, res) {
  const device = deviceContext(req);
  const fp = fingerprintOfInstance(device.id);
  const known = fp ? knownDevices()[fp] : null;
  const reset = /[?&]reset=1/.test(req.url || "");
  if (reset) {
    if (deviceStore.devices[device.id]) delete deviceStore.devices[device.id];
    if (known && known.namespaces) delete known.namespaces;      // 覆盖挂在设备（特征码）上，一起清
    saveDeviceStoreSoon();
  }
  const holder = known && known.namespaces ? known : deviceStore.devices[device.id];
  const body = Buffer.from(JSON.stringify({
    device: known ? known.id : device.id,
    name: known ? known.name : "未识别的浏览器",
    note: reset ? "已清空本设备的覆盖，刷新页面后重新跟随电脑。" : "本设备（按特征码识别）独享的语言/外观/字号；带 ?reset=1 可清空。",
    overrides: reset || !holder || !holder.namespaces ? {} : holder.namespaces,
    serverValues: deviceStore.serverValues
  }, null, 2) + "\n", "utf8");
  const headers = { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" };
  attachDeviceCookie(headers, device);
  res.writeHead(200, headers);
  res.end(body);
}
function interceptSettingsWrite(req, res, device, authority, cookie) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", function (chunk) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) { aborted = true; req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("aborted", function () { aborted = true; });
  req.on("end", function () {
    if (aborted) return;
    const raw = Buffer.concat(chunks);
    let message = null;
    try { message = JSON.parse(raw.toString("utf8")); } catch (error) { message = null; }
    const args = message && message.payload && message.payload.args ? message.payload.args : null;
    const ns = args && typeof args.ns === "string" ? args.ns : null;
    if (!message || !ns || DEVICE_NAMESPACES.indexOf(ns) < 0) return proxy(req, res, raw);   // 别的设置项照旧上行
    const record = ensureDeviceNamespace(device.id, ns, clientIp(req));
    try { applyNamespaceWrite(record, ns, args); }
    catch (error) { logLine("设备设置更新失败：" + (error && error.message)); }
    saveDeviceStoreSoon();
    const result = {
      ns: ns,
      schema: cachedSettingsSchema[ns] !== undefined ? cachedSettingsSchema[ns] : null,
      value: clone(record.value) || {},
      user: clone(record.user) || {},
      applies: "live",
      secrets: [],
      revision: Number(args.expectedRevision || 0) + 1
    };
    const body = Buffer.from(JSON.stringify({ type: "server-response", rpcId: message.rpcId, result: { ok: true, value: result } }), "utf8");
    const headers = { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" };
    attachDeviceCookie(headers, device);
    res.writeHead(200, headers);
    res.end(body);
    logLine("设备设置[" + device.id.slice(0, 6) + "] " + ns + " → " + JSON.stringify(result.user) + "（未上行，只影响这台设备）");
  });
}

/* ---------------------------- 认证 cookie ---------------------------- */
/** 从 ~/.dsh/.credentials.yaml 读取 browser-session 的持久签名密钥。 */
function readSecret() {
  const text = fs.readFileSync(CREDENTIALS, "utf8");
  const block = text.match(/client-connection\/browser-session:[\s\S]*?(?=\n\S|\s*$)/);
  const scope = block ? block[0] : text;
  const m = scope.match(/secret:\s*["\']?([A-Za-z0-9_\-=\+\/]+)["\']?/);
  if (!m) throw new Error("在 " + CREDENTIALS + " 里找不到 client-connection/browser-session 的 secret");
  return m[1];
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeSecret(secret) {
  const b64 = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (b64.length >= 16) return b64;
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) return Buffer.from(secret, "hex");
  return Buffer.from(secret, "utf8");
}
const SECRET = readSecret();
const SECRET_KEY = decodeSecret(SECRET);
/** cookie 名 = "dsh-auth-" + base64url(sha256(authority))；值 = v1.<payload>.<hmac> */
function mintCookie(authority, days) {
  const ttl = days || COOKIE_DAYS;
  const name = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority, "utf8").digest());
  const now = Date.now();
  const expiresAt = now + ttl * 24 * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ version: 1, authority: authority, issuedAt: now, expiresAt: expiresAt }), "utf8");
  const body = b64url(payload);
  const sig = b64url(crypto.createHmac("sha256", SECRET_KEY).update(body, "utf8").digest());
  return { name: name, value: "v1." + body + "." + sig };
}

/* ------------------------ 设备注册表（谁连进来了 / 踢谁下线） ------------------------
 * 桥是唯一能看清「有哪些设备在用」的地方，所以台账记在这里。
 *   · 在线 = 最近 90 秒内有请求，或还挂着 WebSocket（App 会常驻 /api/remote.mux）
 *   · 踢出 = 拉黑该设备 cookie + 掐断它所有连接；被拉黑的设备再来会收到「已下线」页
 *   · 拉黑名单持久化在 device-settings.json 的 blocked 里（桥重启也还在）
 * 注意：桥本身不做登录，踢出是「断开并拒绝这台设备」，不是安全边界——
 *       清空浏览器数据换个 cookie 就又能进来（家庭局域网够用，别当权限系统）。
 * ------------------------------------------------------------------------- */
/** 认证之前也必须能访问的端点：落地页、APK、二维码、特征上报、插件包本体。 */
const OPEN_PATHS = ["/__bridge", "/__apk", "/__qr.png", "/__hello", "/__plugin/client.js", "/favicon.ico"];

/* ------------------- ACME 验证文件（给 Let's Encrypt 用） -------------------
 * 走 HTTP-01 验证就不必把 DNS 账号交给脚本：LE 会来取
 *   http://<域名>/.well-known/acme-challenge/<token>
 * 桥把这个路径映射到本地 acme/ 目录（只读、且只允许这一个目录、拒绝路径穿越）。
 * ------------------------------------------------------------------------- */
const ACME_WEBROOT = process.env.DSH_BRIDGE_ACME_DIR || path.join(__dirname, "acme");
function serveAcmeChallenge(req, res, pathname) {
  const name = decodeURIComponent(pathname.slice("/.well-known/acme-challenge/".length));
  if (!/^[A-Za-z0-9_\-.]+$/.test(name)) { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad name"); return; }
  const file = path.join(ACME_WEBROOT, name);
  if (path.dirname(file) !== ACME_WEBROOT) { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden"); return; }
  let body;
  try { body = fs.readFileSync(file); }
  catch (error) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
  res.writeHead(200, { "content-type": "text/plain", "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
}
/** 设备管理端点：必须由**已认证**的设备调用（本机永远算已认证），否则谁都能给自己发证。 */
const MANAGEMENT_PATHS = ["/__devices", "/__approve", "/__deny", "/__kick", "/__unblock", "/__trust", "/__device"];
const deviceRegistry = new Map();   // id → { id, ip, ua, firstSeen, lastSeen, requests, sockets, openSockets }
const blockedDevices = new Set(deviceStore.blocked || []);

function persistBlocked() {
  deviceStore.blocked = Array.from(blockedDevices);
  deviceStoreDirty = true;
  saveDeviceStoreSoon();
}
function isBlocked(id) { return Boolean(id) && blockedDevices.has(id); }
function deviceLabelFromUa(ua) {
  const s = String(ua || "");
  if (/Android/i.test(s)) return "Android" + (/Chrome\//.test(s) ? " · Chrome" : "");
  if (/iPhone|iPad|iPod/i.test(s)) return "iOS · Safari";
  if (/Windows/i.test(s)) return "Windows" + (/Edg\//.test(s) ? " · Edge" : /Chrome/.test(s) ? " · Chrome" : /Firefox/.test(s) ? " · Firefox" : "");
  if (/Macintosh|Mac OS X/i.test(s)) return "macOS";
  if (/Linux/i.test(s)) return "Linux";
  return s ? s.slice(0, 36) : "未知设备";
}
function touchDevice(device, req) {
  if (!device || !device.id) return null;
  const raw = displayIp(req);
  const ip = raw === "::1" || raw === "::ffff:127.0.0.1" ? "127.0.0.1" : raw;
  let record = deviceRegistry.get(device.id);
  if (!record) {
    record = { id: device.id, firstSeen: Date.now(), requests: 0, sockets: 0, openSockets: new Set() };
    deviceRegistry.set(device.id, record);
  }
  record.ip = ip;
  record.ua = req.headers["user-agent"] || record.ua || "";
  record.lastSeen = Date.now();
  record.requests++;
  const fp = fingerprintOfInstance(device.id);
  if (fp) record.fp = fp;
  return record;
}
/** 设备台账（**按特征码聚合**）：界面只拿得到随机 ID 与设备名，拿不到特征码本身。 */
function deviceSnapshot(selfInstanceId) {
  const now = Date.now();
  const live = {};
  for (const instance of deviceRegistry.values()) {
    const fp = instance.fp || fingerprintOfInstance(instance.id);
    if (!fp) continue;
    const entry = live[fp] || (live[fp] = { online: false, sockets: 0, lastSeen: 0, ips: [], browsers: 0 });
    entry.browsers++;
    entry.sockets += instance.sockets;
    if (instance.lastSeen > entry.lastSeen) entry.lastSeen = instance.lastSeen;
    if (instance.ip && entry.ips.indexOf(instance.ip) < 0) entry.ips.push(instance.ip);
    if (instance.sockets > 0 || now - instance.lastSeen < 90000) entry.online = true;
  }
  const known = knownDevices();
  const list = Object.keys(known).map(function (fp) {
    const record = known[fp];
    const info = live[fp] || { online: false, sockets: 0, lastSeen: 0, ips: [], browsers: 0 };
    const ips = info.ips.length ? info.ips : (record.ips || []);
    const seenAt = Math.max(info.lastSeen, record.lastSeen || 0);
    return {
      id: record.id,
      name: record.name,
      state: record.state,
      platform: record.platform || describeTraits(record.traits || {}),
      online: info.online || (now - seenAt < 90000),
      lastSeen: seenAt,
      ips: ips,
      browsers: info.browsers || (record.instances ? record.instances.length : 0),
      local: ips.indexOf("127.0.0.1") >= 0,
      hasOverrides: Boolean(record.namespaces && Object.keys(record.namespaces).length),
      trusted: record.trusted === true,     // 「完全信任」：外网访问免口令（可在设备管理里撤销）
      self: Boolean(selfInstanceId && record.instances && record.instances.indexOf(selfInstanceId) >= 0)
    };
  });
  const rank = function (device) { return device.state === STATE_PENDING ? 0 : device.state === STATE_APPROVED ? 1 : 2; };
  list.sort(function (a, b) { return rank(a) - rank(b) || Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen; });
  return list;
}
/** 被拉黑的设备该看到什么：说清楚原因，并告诉它找谁解开。 */
function blockedResponse(req, res) {
  if (String(req.url || "").indexOf("/api/") === 0) {
    const body = Buffer.from(JSON.stringify({ type: "server-response", result: { ok: false, error: { code: "device-blocked", message: "此设备已被移除在线列表" } } }), "utf8");
    res.writeHead(403, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
    res.end(body);
    return;
  }
  const html = "<!doctype html><meta charset=\"utf-8\"><meta name=viewport content=\"width=device-width,initial-scale=1\">"
    + "<title>已下线</title><body style=\"font:15px/1.7 system-ui;padding:28px;color:#333\">"
    + "<h2 style=\"margin:0 0 8px\">这台设备已被移除</h2>"
    + "<p>管理员在电脑的「设置 → 手机端 → 设备管理」里把你这台设备踢下线了。</p>"
    + "<p>要重新接入：在电脑上把该设备恢复，或刷新本页重新扫码进入。</p></body>";
  const body = Buffer.from(html, "utf8");
  res.writeHead(403, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
}

/* ------------------------------- 二维码 -------------------------------
 * 手机扫码要能：① 下载/打开 App ② 直接进网页版 ③ 用 App 扫码连接本机。
 * 所以二维码内容统一是桥的落地页 http://<局域网地址>:<port>/__bridge。
 * 生成用 vendored 的 qrcode-generator（MIT，零 npm 依赖），自己拼 PNG（只用 node:zlib）。
 * ------------------------------------------------------------------- */
const qrcode = require(path.join(__dirname, "vendor", "qrcode-generator.js"));
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** 8 位灰度 PNG（0 = 黑，255 = 白）：二维码就是黑白点阵，不需要调色板。 */
function grayscalePng(pixels, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;                                  // filter: none
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;    // bit depth
  header[9] = 0;    // color type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", require("node:zlib").deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
/** 本机有哪些地址可以给手机扫（跳过回环与虚拟网卡常见的 169.254/虚拟交换机）。 */
function qrHosts() {
  const list = [];
  const interfaces = os.networkInterfaces();
  const score = function (name, address) {
    if (/wi-?fi|wlan|无线/i.test(name)) return 0;
    if (address.startsWith("192.168.")) return 1;
    if (address.startsWith("10.")) return 2;
    if (/ethernet|以太网/i.test(name)) return 3;
    return 4;
  };
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (iface.address.startsWith("169.254.")) continue;
      list.push({ name: name, address: iface.address, rank: score(name, iface.address) });
    }
  }
  list.sort(function (a, b) { return a.rank - b.rank; });
  return list.map(function (item) { return { name: item.name, address: item.address, url: "http://" + item.address + ":" + LISTEN_PORT + "/__bridge" }; });
}
function qrPayloadFor(host) {
  const hosts = qrHosts();
  const chosen = host && hosts.some(function (h) { return h.address === host; }) ? host : (hosts[0] ? hosts[0].address : "127.0.0.1");
  return { host: chosen, text: "http://" + chosen + ":" + LISTEN_PORT + "/__bridge", hosts: hosts };
}
function qrPng(text, scale, quiet) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const side = (count + quiet * 2) * scale;
  const pixels = Buffer.alloc(side * side, 255);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      const x0 = (col + quiet) * scale;
      const y0 = (row + quiet) * scale;
      for (let y = 0; y < scale; y++) pixels.fill(0, (y0 + y) * side + x0, (y0 + y) * side + x0 + scale);
    }
  }
  return grayscalePng(pixels, side, side);
}
function serveQr(req, res, query) {
  const host = query.get("host") || undefined;
  const scale = Math.max(2, Math.min(20, Number(query.get("scale") || 8)));
  const wan = query.get("wan") === "1";
  const v6 = query.get("v6") === "1";
  // 外网二维码里带着接入口令 ⇒ 只有本机窗口能取
  if ((wan || v6) && !panelGuard(req, res, ["local"], "查看外网二维码")) return;
  const text = v6 ? ipv6Info().qrText : (wan ? wanQrText() : qrPayloadFor(host).text);
  if (!text) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end(v6 ? "本机现在没有公网 IPv6 地址" : "还没填外网地址"); return; }
  const body = qrPng(text, scale, 4);
  res.writeHead(200, { "content-type": "image/png", "content-length": body.length, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(body);
}

/* ------------------- IPv6 直连地址（面板要能随时查到当前值） -------------------
 * 运营商前缀会变、Windows 的临时地址（RFC 4941）也会定期换，所以这里每次现算，
 * 只把「哪条是稳定地址」交给系统回答一次并缓存（临时地址照样能连，只是会失效）。
 * ------------------------------------------------------------------------- */
let ipv6Cache = { at: 0, stable: "" };
function ipv6UrlsNow() {
  const urls = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = typeof iface.family === "string" ? iface.family : (iface.family === 6 ? "IPv6" : "IPv4");
      if (family !== "IPv6" || iface.internal || !isGlobalV6(iface.address)) continue;
      if (urls.indexOf(iface.address) < 0) urls.push(iface.address);
    }
  }
  return urls;
}
function refreshIpv6Stable() {
  if (process.platform !== "win32") return;
  const script = 'Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -eq "RouterAdvertisement" -and $_.SuffixOrigin -eq "Link" -and $_.AddressState -eq "Preferred" } | Select-Object -First 1 -ExpandProperty IPAddress';
  try {
    require("node:child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 8000, windowsHide: true }, function (error, stdout) {
      if (error) return;
      const value = String(stdout || "").trim();
      if (value.indexOf(":") >= 0 && /^[0-9a-f:]+$/i.test(value)) ipv6Cache.stable = value;
    });
  } catch (error) { /* 问不到就用第一个地址兜底 */ }
}
function ipv6Info() {
  const urls = ipv6UrlsNow();
  if (urls.indexOf(ipv6Cache.stable) < 0 && Date.now() - ipv6Cache.at > 5 * 60 * 1000) { ipv6Cache.at = Date.now(); refreshIpv6Stable(); }
  const stable = urls.indexOf(ipv6Cache.stable) >= 0 ? ipv6Cache.stable : (urls[0] || "");
  return {
    available: urls.length > 0,
    stable: stable,
    url: stable ? "http://[" + stable + "]:" + LISTEN_PORT + "/" : "",
    // 公网 IPv6 直连也要接入口令（needsAccessToken），所以二维码里直接带上 ?k= 一次种好 cookie
    qrText: stable ? ("http://[" + stable + "]:" + LISTEN_PORT + "/" + (accessToken() ? "?k=" + accessToken() : "")) : "",
    urls: urls.map(function (ip) { return { ip: ip, url: "http://[" + ip + "]:" + LISTEN_PORT + "/", stable: ip === stable }; })
  };
}

/* --------------------------- 设备管理 JSON API --------------------------- */
function jsonResponse(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*"      // 插件从 3080（电脑窗口直连）读时是跨源
  });
  res.end(body);
}
function serveDevices(req, res, device, query) {
  const scope = panelScope(req, device);
  const payload = qrPayloadFor(query.get("host") || undefined);
  const apk = findLatestApk();
  const snapshot = deviceSnapshot(device.id);
  const selfFp = approvedFingerprintOf(req) || fingerprintOfInstance(device.id);
  const selfId = (knownDevices()[selfFp] || {}).id || "";
  // 「只看得到自己」的设备：清单里只留它这一台（别人的名字/IP 也不该顺手给它看）
  const devices = scope === "device" ? snapshot.filter(function (item) { return item.id === selfId; }) : snapshot;
  jsonResponse(res, 200, {
    scope: scope,
    devices: devices,
    pending: devices.filter(function (item) { return item.state === STATE_PENDING; }).length,
    self: device.id,
    hosts: payload.hosts,          // 局域网二维码（不含口令）——任何已认证设备都能看，用来把新设备加进来
    qrHost: payload.host,
    qrText: payload.text,
    // 口令 / 外网二维码 / 外网地址：只在本机窗口里出现
    wan: scope === "local" ? {
      url: wanUrl(), token: accessToken(), qrText: wanQrText(),
      tokenDays: TOKEN_DAYS, tokenIssuedAt: accessTokenAt(), tokenRotatesAt: tokenRotatesAt()
    } : null,
    apk: apk ? { name: apk.name, size: apk.size, sha256: apk.sha256 } : null,
    port: LISTEN_PORT,
    display: (function () {
      const record = deviceSettingsRecord(device.id, false);
      const value = (record && record.namespaces && record.namespaces["ui-theme"] && record.namespaces["ui-theme"].value) || null;
      const locale = deviceSettingsRecord(device.id, false);
      const lang = (locale && locale.namespaces && locale.namespaces["locale"] && locale.namespaces["locale"].value) || null;
      return { value: value, inherited: !value, range: [FONT_MIN, FONT_MAX], locale: lang ? lang.preference : null };
    })()
  });
}
/** POST /__wan?url=… 设置外网地址；?rotate=1 换口令；?clear=1 清空。 */
function serveWan(req, res, query) {
  if (req.method !== "POST") return jsonResponse(res, 405, { ok: false, error: "请用 POST" });
  if (query.get("rotate") === "1") rotateAccessToken();
  if (query.get("clear") === "1") { deviceStore.wanUrl = ""; saveDeviceStoreSoon(); }
  const raw = query.get("url");
  if (raw) {
    let value = String(raw).trim();
    if (!/^https?:\/\//i.test(value)) value = "https://" + value;
    value = value.replace(/\/+$/, "").replace(/\?k=.*$/, "");
    try { new URL(value); } catch (error) { return jsonResponse(res, 400, { ok: false, error: "地址格式不对：" + raw }); }
    deviceStore.wanUrl = value;
    if (!accessToken()) rotateAccessToken();
    saveDeviceStoreSoon();
    logLine("设置外网地址：" + value);
  }
  jsonResponse(res, 200, { ok: true, url: wanUrl(), token: accessToken(), qrText: wanQrText() });
}
/* 设备管理动作：全部按「随机 ID」寻址（/__approve 允许、/__deny 拒绝、/__kick 踢出、/__unblock 恢复）。 */
function serveKick(req, res, query) { return setDeviceState(req, res, query, STATE_DENIED); }
function serveDeny(req, res, query) { return setDeviceState(req, res, query, STATE_DENIED); }
function serveUnblock(req, res, query) { return setDeviceState(req, res, query, STATE_APPROVED); }

/** 「完全信任」开关：开了这台设备从外网进来免口令，关掉立刻恢复要口令。 */
function serveTrust(req, res, query) {
  const found = knownByDeviceId(query.get("id"));
  if (!found) return jsonResponse(res, 404, { ok: false, error: "没有这台设备" });
  const on = query.get("on") !== "0";
  if (on && found.record.state !== STATE_APPROVED) {
    return jsonResponse(res, 400, { ok: false, error: "只有已认证的设备才能设为完全信任" });
  }
  found.record.trusted = on;
  saveDeviceStoreSoon();
  logLine("设备 " + found.record.id + " 完全信任 → " + (on ? "开（外网免口令）" : "关"));
  jsonResponse(res, 200, { ok: true, id: found.record.id, trusted: on });
}
function serveApprove(req, res, query) { return setDeviceState(req, res, query, STATE_APPROVED); }

/* ------------------- 客户端插件包（设置里的「手机端」面板） -------------------
 * 产品前端会按 __DSH_BOOT__ 里的条目加载客户端插件；桥把这条目追加进去，
 * 于是「设置」里多出一个原生分区，且不依赖任何一次 harness 重启。
 * 文件按 mtime 读盘 —— 改完存盘刷新页面即可，不用重启桥。
 * ------------------------------------------------------------------------- */
function panelSource() {
  try {
    const file = path.join(__dirname, "mobile-panel.js");
    const stat = fs.statSync(file);
    if (panelCache.mtimeMs !== stat.mtimeMs || panelCache.size !== stat.size) {
      panelCache = { mtimeMs: stat.mtimeMs, size: stat.size, text: fs.readFileSync(file, "utf8"), rev: stat.mtimeMs.toString(36) };
    }
    return panelCache;
  } catch (error) { return { text: "", rev: "0" }; }
}
let panelCache = { mtimeMs: 0, size: 0, text: "", rev: "0" };
function servePlugin(req, res) {
  const panel = panelSource();
  if (!panel.text) { res.writeHead(404, { "content-type": "text/plain" }); res.end("mobile-panel.js 缺失"); return; }
  const body = Buffer.from(panel.text, "utf8");
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
}
/** 往发出去的 HTML 里追加插件条目（改了 __DSH_BOOT__ 的那段 JSON）。 */
/** 总开关：条目格式不对会让客户端启动直接失败（整页白屏），所以留一枚可以一键关掉的开关。 */
const PANEL_ENABLED = process.env.DSH_BRIDGE_PANEL !== "0" && PANEL_ENABLED_BUILD;
function injectPanelEntry(html) {
  const panel = panelSource();
  if (!panel.text || html.indexOf('"dsh-mobile-panel"') >= 0) return html;
  const marker = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(marker);
  if (start < 0) return html;
  const from = start + marker.length;
  const end = html.indexOf("</script>", from);
  if (end < 0) return html;
  let boot;
  try { boot = JSON.parse(html.slice(from, end)); } catch (error) { return html; }
  if (!boot || !Array.isArray(boot.entries)) return html;
  const entryId = "dsh-mobile-panel";
  const url = "/__plugin/client.js&rev=" + panel.rev;
  boot.entries.push({
    id: entryId,
    url: url,
    rev: panel.rev,
    inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-slots"],
    immediately: false
  });
  // 光有条目还不够：加载器要求每个条目都被某个批次（batches）认领，否则直接抛
  // “belongs to no initial-load batch” 把整个客户端启动打断（页面白屏）。
  // 批次是用 <script src> 加载的经典脚本，所以这里给插件单开一个 application 批次。
  boot.batches = Array.isArray(boot.batches) ? boot.batches : [];
  boot.batches.push({ phase: "application", url: url, rev: panel.rev, entries: [entryId] });
  boot.rev = boot.rev + "-mobile";
  // 注入后自检：DSH 换了清单结构时，错的条目会直接把客户端启动打断（整页白屏）。
  // 这里宁可放弃「手机端」面板，也绝不能让页面白屏 —— 白屏的恰恰是唯一能改设置的桌面窗口。
  const problem = bootManifestProblem(boot, entryId);
  if (problem) { logLine("boot 清单自检未通过（" + problem + "），本次跳过面板注入"); return html; }
  let serialized;
  try { serialized = JSON.stringify(boot); JSON.parse(serialized); } catch (error) { logLine("boot 清单序列化失败，跳过面板注入"); return html; }
  return html.slice(0, from) + serialized + html.slice(end);
}
/** 清单自检：所有条目都要有 id，且我们加的那条必须被某个批次认领（历史上漏了这条就是白屏）。 */
function bootManifestProblem(boot, entryId) {
  if (!boot || !Array.isArray(boot.entries) || !Array.isArray(boot.batches)) return "结构不是 entries/batches 数组";
  const ids = [];
  for (const item of boot.entries) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) return "有条目缺 id 字段";
    ids.push(item.id);
  }
  const batched = new Set();
  for (const batch of boot.batches) {
    if (!batch || typeof batch !== "object" || !Array.isArray(batch.entries)) return "批次结构不对";
    for (const id of batch.entries) {
      if (typeof id !== "string") return "批次里的条目不是 id 字符串";   // 结构漂移的典型形态
      batched.add(id);
    }
  }
  // 整份清单都必须自洽：历史上「某条目没被任何批次认领」正是整页白屏的成因。
  for (const id of ids) if (!batched.has(id)) return "条目 " + id + " 没被任何批次认领";
  return batched.has(entryId) ? "" : "新条目没有被批次认领";
}

/** 自检：直接向上游取一次首页，把注入管线完整跑一遍，报告「能不能安全地把桌面窗口指到桥上」。
 *  启动器只在 ok=true 时走 8099；panel=false 表示 DSH 可能改了清单结构（此时仍可正常用，只是没有面板）。
 *  任何异常都被吞掉并转成 ok:false —— 自检自己绝不能把桥带崩。 */
function bridgeSelftest(callback) {
  const report = { ok: false, panel: false, tweaks: false, boot: false, describe: false, upstream: 0, note: "" };
  let cookie;
  try { cookie = mintCookie(qrHosts().length ? qrHosts()[0].address + ":" + LISTEN_PORT : "127.0.0.1:" + LISTEN_PORT); }
  catch (error) { report.note = "签发 cookie 失败"; return callback(report); }
  const done = function () { callback(report); };
  const request = http.request({
    hostname: TARGET.hostname, port: TARGET.port || 80, method: "GET", path: "/",
    headers: { host: qrHosts().length ? qrHosts()[0].address + ":" + LISTEN_PORT : "127.0.0.1:" + LISTEN_PORT, cookie: cookie.name + "=" + cookie.value, "user-agent": "dsh-bridge-selftest", "accept-encoding": "identity" }
  }, function (upstream) {
    report.upstream = upstream.statusCode || 0;
    const chunks = [];
    upstream.on("data", function (chunk) { chunks.push(chunk); if (chunks.length > 400) upstream.destroy(); });
    upstream.on("end", function () {
      try {
        const html = Buffer.concat(chunks).toString("utf8");
        if (upstream.statusCode !== 200 || html.indexOf("__DSH_BOOT__") < 0) { report.note = "上游首页不是 DSH 应用页（可能改了认证或结构）"; return done(); }
        report.boot = true;
        // 首帧主题注入靠两个字符串常量改写；DSH 改了写法这里就会 false（面板/移动端不受影响）
        report.theme = html.indexOf("const preference = \"") >= 0 && html.indexOf("'--dsh-content-font-size'") >= 0;
        const paneled = PANEL_ENABLED ? injectPanelEntry(html) : html;
        report.panel = paneled !== html;
        const tweaked = injectTweaks(html);
        report.tweaks = tweaked !== html;
        report.ok = true;
        report.note = report.panel ? "注入正常" : "面板未注入（清单结构可能已变；页面本身仍可正常使用）";
      } catch (error) { report.note = "自检异常：" + (error && error.message ? error.message : String(error)); }
      done();
    });
    upstream.on("error", function () { report.note = "上游读取失败"; done(); });
  });
  request.on("error", function (error) { report.note = "上游不可达：" + (error && error.message ? error.message : String(error)); done(); });
  request.setTimeout(8000, function () { request.destroy(); report.note = "上游超时"; done(); });
  request.end();
  // 顺带验证「按设备隔离设置」用的 describe 路径还在
  try {
    const q = http.request({ hostname: TARGET.hostname, port: TARGET.port || 80, method: "GET", path: SETTINGS_DESCRIBE_PATH, headers: { host: qrHosts().length ? qrHosts()[0].address + ":" + LISTEN_PORT : "127.0.0.1:" + LISTEN_PORT, cookie: cookie.name + "=" + cookie.value, "user-agent": "dsh-bridge-selftest" } }, function (r) { report.describe = r.statusCode === 200; r.resume(); });
    q.on("error", function () { /* 报告里保持 false */ });
    q.setTimeout(5000, function () { q.destroy(); });
    q.end();
  } catch (error) { /* 忽略 */ }
}

/* ------------------------------ 转发逻辑 ------------------------------ */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function forwardHeaders(headers, authority, cookie) {
  const out = {};
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "cookie") continue;      // 换成桥自己签的
    // accept-encoding 原样透传：上游压缩后体积只有 1/3～1/5，手机在弱网下全靠它。
    // 需要注入的响应改由下面的 decodeBody/gzipSync 显式解压→改写→重压。
    out[key] = headers[key];
  }
  out["host"] = authority;                 // 栅栏要求：Host 必须是回环或受信任的 authority
  // 栅栏还要求「带了 Origin 就必须与该 Host 一致」：隧道域名在这里被归一化成局域网 authority，
  // 所以 Origin 也要跟着改，否则 /api 会 403（本地/局域网访问时 authority 原样，等于没改）。
  const incomingOrigin = headers["origin"] || headers["Origin"];
  if (incomingOrigin) out["origin"] = "http://" + authority;
  out["cookie"] = cookie.name + "=" + cookie.value;
  return out;
}
/**
 * WebSocket/upgrade 专用：Connection / Upgrade / Sec-WebSocket-* 必须原样送达，
 * 否则上游不认为是升级请求（实测表现为 /api/remote.mux 握手 404 → 客户端一直「自动重连中」）。
 */
/** WebSocket 版的口令闸门：规则与 HTTP 一致（经隧道/公网 IPv6 必须带口令，除非「完全信任」）。
 *  升级请求没法回一个 HTML 表单，所以直接 403 后断开。 */
function upgradeAllowed(req, socket) {
  const expected = accessToken();
  if (!expected || !needsAccessToken(req)) return true;
  const access = deviceAccess(req, deviceContext(req));
  if (access.approved && access.record && access.record.trusted === true) return true;
  let fromQuery = "";
  try { fromQuery = new URL(req.url || "/", "http://" + (req.headers.host || "localhost")).searchParams.get("k") || ""; } catch (error) { fromQuery = ""; }
  const fromCookie = parseCookies(req.headers.cookie)[ACCESS_TOKEN_COOKIE];
  if (fromQuery === expected || fromCookie === expected) return true;
  logLine("WebSocket 被拦（缺口令）：ua=" + String(req.headers["user-agent"] || "").slice(0, 40));
  try { socket.write("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); } catch (error) { /* 对端已断就算了 */ }
  socket.destroy();
  return false;
}
function forwardUpgradeHeaders(headers, authority, cookie) {
  const out = {};
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "cookie" || lower === "host") continue;   // 下面替换
    out[key] = headers[key];
  }
  out["host"] = authority;
  const incomingOrigin = headers["origin"] || headers["Origin"];
  if (incomingOrigin) out["origin"] = "http://" + authority;
  out["cookie"] = cookie.name + "=" + cookie.value;
  return out;
}
/** 把上游响应体还原成文本：不认识的编码返回 null，调用方原样放行。 */
function decodeBody(buffer, encoding) {
  if (!encoding || encoding === "identity") return buffer.toString("utf8");
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(buffer).toString("utf8");
  if (encoding === "br") return zlib.brotliDecompressSync(buffer).toString("utf8");
  if (encoding === "deflate") {
    try { return zlib.inflateSync(buffer).toString("utf8"); }
    catch (error) { return zlib.inflateRawSync(buffer).toString("utf8"); }
  }
  return null;
}
/* 慢速外网上首屏 4MB 的插件 JS 是最大一笔开销。上游只会 gzip，桥这里再压一层 brotli
 * （实测 3844KB → 3418KB，再省 11%），并按「带 ?rev= 的不可变 URL」缓存压缩结果。
 * 只有能整段拿到、且客户端声明支持 br 的文本响应才走这条路，其余一律原样流式转发。 */
const BROTLI_LIMIT = Number(process.env.DSH_BRIDGE_BROTLI_LIMIT || 16 * 1024 * 1024);
const BROTLI_MIN_BYTES = Number(process.env.DSH_BRIDGE_BROTLI_MIN || 32 * 1024);   // 小于它就别压：gzip 更划算
const BROTLI_OPTS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_LGWIN]: 22 } };
const brotliCache = new Map();
function brotliOf(key, encoded, encoding) {
  const sum = crypto.createHash("sha1").update(encoded).digest("hex");
  const hit = brotliCache.get(key);
  if (hit && hit.sum === sum) return hit;
  const text = decodeBody(encoded, encoding);   // 不认识的编码返回 null
  if (text === null) return null;
  const entry = { sum: sum, buf: zlib.brotliCompressSync(Buffer.from(text, "utf8"), BROTLI_OPTS) };
  if (brotliCache.size >= 8) brotliCache.clear();   // 简单粗暴的上限：最多留 8 条
  brotliCache.set(key, entry);
  return entry;
}
/** 客户端能不能解 brotli。
 *  实测 Chromium 给子资源发的 accept-encoding 常常只有「gzip, deflate」（连 br 都不声明），
 *  但安卓 WebView ≥50 / WebView2 都必然支持 br —— 自家 App 与桌面窗口因此按能力放行，
 *  其余客户端严格按 accept-encoding 判断。 */
function clientSupportsBrotli(req) {
  const ae = String(req.headers["accept-encoding"] || "");
  if (/\bbr\b/i.test(ae)) return true;
  if (!ae) return false;                    // 连 accept-encoding 都不发：不按浏览器看，别冒险
  const ua = String(req.headers["user-agent"] || "");
  return /DSHMobile|Edg\//.test(ua);
}
function brotliWanted(req, ctype, encoding, declared) {
  if (process.env.DSH_BRIDGE_NO_BROTLI === "1") return false;   // 一键关掉桥侧压缩
  if (req.method !== "GET") return false;
  if (!clientSupportsBrotli(req)) return false;
  if (encoding && encoding !== "gzip" && encoding !== "x-gzip" && encoding !== "identity") return false;
  if (/event-stream/.test(ctype)) return false;   // 流式响应绝不能缓冲
  if (!/(javascript|ecmascript|text\/css|application\/json|\+json|text\/html|text\/plain|image\/svg)/.test(ctype)) return false;
  if (declared && declared > BROTLI_LIMIT) return false;
  return true;
}
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || "?"; }
/** 台账里显示的来源 IP：经隧道进来时用 X-Forwarded-For（frps 会填），只用于显示，不参与信任判断。 */
function displayIp(req) {
  if (isProxiedRequest(req)) {
    // XFF 是「客户端, 代理1, …, 连到 frps 的 IP」：前半段用户可伪造，官方建议只信**最后一段**。
    const parts = String(req.headers["x-forwarded-for"] || "").split(",");
    const last = parts[parts.length - 1].trim();
    if (/^[0-9a-fA-F:.]{3,45}$/.test(last)) return last;
    // HTTPS/TCP 隧道不追加 XFF（只有 HTTP 隧道才有），这时来源 IP 在桥看来就是 127.0.0.1——不如直说
    return "隧道访客";
  }
  return clientIp(req);
}
function log(line) { process.stdout.write("[bridge " + new Date().toLocaleTimeString() + "] " + line + "\n"); }

function proxy(req, res, presetBody) {
  const authority = req.headers.host;
  if (!authority) { res.writeHead(400, { "content-type": "text/plain" }); res.end("missing Host"); return; }
  let cookie;
  try { cookie = mintCookie(upstreamAuthority(req)); }
  catch (error) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("bridge: " + error.message); return; }
  const targetPath = req.url && req.url.startsWith("/") ? req.url : "/" + (req.url || "");
  const pathname = targetPath.split("?")[0];
  const device = deviceContext(req);
  if (device.blocked) return blockedResponse(req, res);       // 旧版按浏览器实例拉黑的名单（兼容保留）
  touchDevice(device, req);
  // 转发前把「域名形式的 Host」（隧道）折算成受信任的局域网 authority —— 见文件开头的隧道说明
  const upstream = upstreamAuthority(req);
  // ---- 设备认证闸门：没通过本机认证的设备，只能看到「等待确认」页 ----
  const access = deviceAccess(req, device);
  if (!access.approved) {
    if (MANAGEMENT_PATHS.indexOf(pathname) >= 0) {
      return jsonResponse(res, 403, {
        ok: false,
        error: "这台设备还没通过本机认证",
        device: access.record ? { id: access.record.id, name: access.record.name, state: access.record.state } : null
      });
    }
    if (pathname.indexOf("/api/") === 0 || pathname.indexOf("/plugins/") === 0) {
      return jsonResponse(res, 403, { ok: false, error: "device-not-approved" });
    }
    if (pathname === "/" || String(req.headers.accept || "").indexOf("text/html") >= 0) {
      return waitingPage(req, res, device, access);
    }
    // 其余静态资源放行：落地页与等待页自身要用
  }
  // 语言/外观/字号的写请求由桥就地处理、绝不上行——否则会改到电脑那份设置（见「按设备隔离的设置」）
  if (DEVICE_SETTINGS_ON && !presetBody && SETTINGS_WRITE_PATHS.has(pathname)) {
    return interceptSettingsWrite(req, res, device, authority, cookie);
  }
  const proxied = http.request({
    hostname: TARGET.hostname,
    port: TARGET.port || 80,
    method: req.method,
    path: targetPath,
    headers: forwardHeaders(req.headers, upstream, cookie)
  }, function (upstream) {
    const headers = {};
    let html = false;
    for (const key of Object.keys(upstream.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === "set-cookie") continue;   // 手机侧不需要登录
      if (lower === "content-type" && String(upstream.headers[key]).indexOf("text/html") >= 0) html = true;
      headers[key] = upstream.headers[key];
    }
    // 需要改写的两类响应：① HTML（注入移动端适配 + 按设备改写首帧配色/字号）② settings/describe
    // 改写只是锦上添花——这里任何异常都必须退化成「原样返回」：
    // 之前这里引用了已改名的旧常量，导致每次加载页面都抛未捕获异常、把整座桥带走。
    const wantTweaks = html && Boolean(tweakSnippet());
    const wantPanel = PANEL_ENABLED && html && Boolean(panelSource().text);
    const wantDescribe = DEVICE_SETTINGS_ON && pathname === SETTINGS_DESCRIBE_PATH;
    if (wantTweaks || wantPanel || wantDescribe) {
      const chunks = [];
      upstream.on("data", function (chunk) { chunks.push(chunk); });
      upstream.on("end", function () {
        const original = Buffer.concat(chunks);
        let body = original;
        // 上游会按 accept-encoding 压缩（首页 gzip 后只有 29KB），要注入就得先解压、注入完再压回去。
        // 旧逻辑「见到 content-encoding 就放弃注入」在透传压缩后会让移动端适配整体失效。
        const inEncoding = String(headers["content-encoding"] || headers["Content-Encoding"] || "").toLowerCase().trim();
        let outEncoding = inEncoding;
        try {
          let text = decodeBody(original, inEncoding);   // 不认识的编码返回 null → 原样放行
          let changed = false;
          if (text !== null) {
            let out = text;
            if (wantTweaks) {
              const localized = injectLocale(out, device.id);
              if (localized !== out) { out = localized; changed = true; }
              const injected = injectTweaks(out);
              if (injected !== out) { out = injected; changed = true; }
              const themed = rewriteBootTheme(out, device.id);
              if (themed !== out) { out = themed; changed = true; }
            }
            if (wantPanel) {
              const withPanel = injectPanelEntry(out);          // 让「设置」里出现「手机端」分区
              if (withPanel !== out) { out = withPanel; changed = true; }
            }
            if (wantDescribe) {
              const rewritten = rewriteDescribe(out, device.id);
              if (rewritten !== null) { out = rewritten; changed = true; }
            }
            if (changed) {
              const accepts = String(req.headers["accept-encoding"] || "");
              const wantsBr = /\bbr\b/i.test(accepts);
              const wantsGzip = /\bgzip\b/i.test(accepts);
              // HTML 这类二三十 KB 的正文 gzip 反而更小（实测 11212B vs 11408B），门槛抬高到 128KB。
              if (wantsBr && (out.length >= 131072 || !wantsGzip)) {
                body = zlib.brotliCompressSync(Buffer.from(out, "utf8"), BROTLI_OPTS);
                outEncoding = "br";
              } else if (wantsGzip) {
                body = zlib.gzipSync(Buffer.from(out, "utf8"), { level: 6 });
                outEncoding = "gzip";
              } else {
                body = Buffer.from(out, "utf8");
                outEncoding = "";
              }
            }
          }
        } catch (error) {
          logLine("改写响应失败，本响应原样返回：" + (error && error.stack ? error.stack : String(error)));
          body = original;
          outEncoding = inEncoding;
        }
        delete headers["content-length"];
        delete headers["Content-Length"];
        delete headers["content-encoding"];
        delete headers["Content-Encoding"];
        if (outEncoding) headers["content-encoding"] = outEncoding;
        headers["content-length"] = body.length;
        if (wantTweaks) headers["cache-control"] = "no-store";
        attachDeviceCookie(headers, device);
        res.writeHead(upstream.statusCode || 200, headers);
        res.end(body);
      });
      return;
    }
    // 慢速链路「少传字节」比什么都值钱：能整段拿到的文本响应在桥侧转成 brotli（带缓存）。
    const brWanted = brotliWanted(req, String(headers["content-type"] || "").toLowerCase(), String(headers["content-encoding"] || "").toLowerCase(), Number(headers["content-length"] || 0));
    if (process.env.DSH_BRIDGE_DEBUG_BROTLI && (pathname.indexOf("/plugins/") === 0 || String(headers["content-type"] || "").includes("javascript"))) {
      logLine("[brotli] " + targetPath.slice(0, 36) + "… enc=" + (headers["content-encoding"] || "-") + " ae=" + JSON.stringify(req.headers["accept-encoding"] || "") + " ua=" + String(req.headers["user-agent"] || "").slice(0, 24) + " → " + (brWanted ? "转 br" : "原样"));
    }
    if (brWanted) {
      const chunks = [];
      let size = 0;
      let overflow = false;
      const onData = function (chunk) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > BROTLI_LIMIT) {           // 超上限：改回边收边发，绝不把整段攒在内存里
          overflow = true;
          upstream.removeListener("data", onData);
          attachDeviceCookie(headers, device);
          res.writeHead(upstream.statusCode || 200, headers);
          for (const buffered of chunks) res.write(buffered);
          upstream.pipe(res);
        }
      };
      upstream.on("data", onData);
      upstream.on("end", function () {
        if (overflow) { res.end(); return; }
        const original = Buffer.concat(chunks);
        let body = null;
        // 小响应（首页等）实测 brotli 比 gzip 还大一点点，不值得折腾，原样放行。
        if (original.length >= BROTLI_MIN_BYTES) {
          try {
            const entry = brotliOf(targetPath, original, String(headers["content-encoding"] || "").toLowerCase());
            if (entry) body = entry.buf;
          } catch (error) {
            logLine("brotli 压缩失败，本响应原样返回：" + (error && error.message ? error.message : String(error)));
          }
        }
        if (!body) {
          attachDeviceCookie(headers, device);
          res.writeHead(upstream.statusCode || 200, headers);
          res.end(original);
          return;
        }
        delete headers["content-length"];
        delete headers["Content-Length"];
        delete headers["content-encoding"];
        delete headers["Content-Encoding"];
        headers["content-encoding"] = "br";
        headers["content-length"] = body.length;
        attachDeviceCookie(headers, device);
        res.writeHead(upstream.statusCode || 200, headers);
        res.end(body);
      });
      return;
    }
    attachDeviceCookie(headers, device);
    res.writeHead(upstream.statusCode || 502, headers);
    upstream.pipe(res);
  });
  proxied.on("error", function (error) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("bridge: 上游 " + TARGET.origin + " 不可达（" + error.message + "）");
  });
  if (presetBody) proxied.end(presetBody); else req.pipe(proxied);   // presetBody：写请求已缓冲（要么接管、要么原样转发）
  if (!QUIET) log(clientIp(req) + " " + req.method + " " + targetPath + " → " + authority);
}

/* --------------------------- 启动页（手机友好） --------------------------- */
function lanUrls() {
  const urls = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) urls.push("http://" + iface.address + ":" + LISTEN_PORT + "/");
    }
  }
  return urls;
}
/* ------------------------- 安卓 App 分发（/__apk） ------------------------- */
const APK_DIR = path.join(__dirname, "..", "..", "dsh-mobile-app", "dist");
let apkCache = { key: "", info: null };
function findLatestApk() {
  try {
    const names = fs.readdirSync(APK_DIR).filter(function (n) { return n.toLowerCase().endsWith(".apk"); });
    if (names.length === 0) return null;
    let best = null;
    for (const name of names) {
      const full = path.join(APK_DIR, name);
      const stat = fs.statSync(full);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { name: name, path: full, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    if (apkCache.key !== best.path + ":" + best.mtimeMs) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(best.path)).digest("hex");
      apkCache = { key: best.path + ":" + best.mtimeMs, info: { name: best.name, path: best.path, size: best.size, sha256: hash } };
    }
    return apkCache.info;
  } catch (error) { return null; }
}
function serveApk(req, res) {
  const apk = findLatestApk();
  if (!apk) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("没有可下载的 APK：先在电脑上运行 dsh-mobile-app\\build.ps1 构建。");
    return;
  }
  res.writeHead(200, {
    "content-type": "application/vnd.android.package-archive",
    "content-length": apk.size,
    "content-disposition": "attachment; filename=\"" + apk.name + "\"",
    "x-apk-sha256": apk.sha256,
    "cache-control": "no-store"
  });
  fs.createReadStream(apk.path).pipe(res);
  if (!QUIET) log(clientIp(req) + " GET /__apk -> " + apk.name + " (" + apk.size + " bytes)");
}

function splash(req, res) {
  const authority = req.headers.host || "";
  const urls = lanUrls();
  const items = urls.map(function (u) { return "<li><code>" + u + "</code></li>"; }).join("");
  const apk = findLatestApk();
  const apkBlock = apk
    ? "<a class=\"big\" style=\"margin-top:12px;background:#1f9d63\" href=\"/__apk\">下载安卓 App：DSH 手机端</a>"
      + "<div style=\"margin-top:8px;font-size:12px;opacity:.6\">" + apk.name + " · "
      + Math.round(apk.size / 1024) + " KB · sha256 " + apk.sha256.slice(0, 16) + "…</div>"
    : "<div style=\"margin-top:12px;font-size:13px;opacity:.6\">（还没构建安卓 App：先在电脑上运行 dsh-mobile-app\\build.ps1）</div>";
  const html = [
    "<!doctype html><html lang=\"zh-CN\"><head>",
    "<meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>DSH 手机接入</title>",
    "<style>body{font:16px/1.6 system-ui,-apple-system,\"Segoe UI\",sans-serif;margin:0;padding:28px 18px;max-width:620px}",
    "h1{font-size:21px;margin:0 0 4px}.sub{opacity:.65;font-size:13px;margin-bottom:22px}",
    "a.big{display:block;text-align:center;padding:16px;border-radius:14px;background:#2b6cff;color:#fff;text-decoration:none;font-weight:600;font-size:17px}",
    "code{background:rgba(127,127,127,.18);padding:1px 6px;border-radius:6px;font-size:13px}",
    ".warn{margin-top:22px;padding:12px 14px;border-radius:10px;background:rgba(255,170,0,.14);font-size:13px}</style></head><body>",
    "<h1>DeepSeek Harness · 手机接入</h1>",
    "<div class=\"sub\">局域网桥已就位（来源 <code>" + authority + "</code>）</div>",
    "<a class=\"big\" href=\"/\">打开 WebUI →</a>",
    apkBlock,
    "<div style=\"margin-top:22px;font-size:13px;opacity:.7\">本机可用地址</div><ul>" + items + "</ul>",
    "<div class=\"warn\">⚠️ 此桥不做登录：能打开它的人即可完全控制这台电脑上的 Harness（读写文件、执行命令）。仅在可信局域网内开启，不要做公网端口映射。</div>",
    "</body></html>"
  ].join("");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/* ------------------------------- 启动 ------------------------------- */
const server = http.createServer(function (req, res) {
  const requestUrl = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  const query = requestUrl.searchParams;
  const pathname = requestUrl.pathname;
  if (!passAccessToken(req, res, query)) return;   // 隧道入口要口令（本机/局域网访问不受影响）
  if (req.method === "OPTIONS") {   // 手机端设置面板可能从别的来源读，统一放行预检
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" });
    res.end();
    return;
  }
  if (pathname === "/__selftest") return bridgeSelftest(function (report) { jsonResponse(res, 200, report); });
  if (pathname === "/__ping") {   // 手机端悬浮球用它量「本机桥」这一跳的往返延迟
    res.writeHead(204, { "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end();
    return;
  }
  if (pathname === "/__bridge" || pathname === "/__bridge/") return splash(req, res);
  if (pathname === "/__apk") return serveApk(req, res);
  if (pathname === "/__device") return serveDeviceInfo(req, res);
  if (pathname.indexOf("/.well-known/acme-challenge/") === 0) return serveAcmeChallenge(req, res, pathname);
  if (pathname === "/__qr.png") return serveQr(req, res, query);
  // 管理类接口按面板权限分级：口令/外网地址只归本机；审批与踢出本机或「完全信任」设备也能做；
  // 「完全信任」的授予/撤销只归本机（否则被信任的设备能自己给自己扩权）。
  if (pathname === "/__wan") {
    if (!panelGuard(req, res, ["local"], "修改外网地址与接入口令")) return;
    return serveWan(req, res, query);
  }
  if (pathname === "/__display") return serveDisplay(req, res, deviceContext(req), query);
  if (pathname === "/__devices") return serveDevices(req, res, deviceContext(req), query);
  if (pathname === "/__hello") return serveHello(req, res, deviceContext(req));
  if (pathname === "/__approve") {
    if (!panelGuard(req, res, ["local", "trusted"], "允许设备接入")) return;
    return serveApprove(req, res, query);
  }
  if (pathname === "/__deny") {
    if (!panelGuard(req, res, ["local", "trusted"], "拒绝设备接入")) return;
    return serveDeny(req, res, query);
  }
  if (pathname === "/__trust") {
    if (!panelGuard(req, res, ["local"], "授予或撤销「完全信任」")) return;
    return serveTrust(req, res, query);
  }
  if (pathname === "/__kick") {
    if (!panelGuard(req, res, ["local", "trusted"], "踢出设备")) return;
    return serveKick(req, res, query);
  }
  if (pathname === "/__unblock") {
    if (!panelGuard(req, res, ["local", "trusted"], "恢复设备")) return;
    return serveUnblock(req, res, query);
  }
  if (pathname.split("&")[0] === "/__plugin/client.js") return servePlugin(req, res);   // 批处理 URL 带 &rev=…（没有 ?）
  return proxy(req, res);
});
// 上游若使用 upgrade 通道，这里原样隧道转发（cookie 同样注入）。
server.on("upgrade", function (req, socket, head) {
  // 关键：cookie 的**名字和签名**都由 authority 推导（mintCookie），必须跟转发时用的 Host
  // 一致 —— 否则隧道下会签出一个 dsh-auth-<hash(域名)>，而上游看到的是局域网 authority，
  // 于是握手被当成未认证请求丢掉：客户端表现就是永远「自动重连中…」。
  const authority = upstreamAuthority(req);
  const upgradeDevice = deviceContext(req);
  if (upgradeDevice.blocked) { socket.destroy(); return; }
  if (!deviceAccess(req, upgradeDevice).approved) { socket.destroy(); return; }   // 未认证设备不给 WebSocket
  if (!upgradeAllowed(req, socket)) return;                                       // 口令闸门同样管 WebSocket
  const deviceRecord = touchDevice(upgradeDevice, req);
  if (deviceRecord) {
    deviceRecord.sockets++;
    deviceRecord.openSockets.add(socket);
    socket.on("close", function () { deviceRecord.sockets = Math.max(0, deviceRecord.sockets - 1); deviceRecord.openSockets.delete(socket); });
  }
  let cookie;
  try { cookie = mintCookie(authority); } catch (error) { socket.destroy(); return; }
  const upstream = net.connect(Number(TARGET.port || 80), TARGET.hostname, function () {
    const lines = [req.method + " " + req.url + " HTTP/1.1"];
    const headers = forwardUpgradeHeaders(req.headers, upstreamAuthority(req), cookie);
    for (const key of Object.keys(headers)) lines.push(key + ": " + headers[key]);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", function () { socket.destroy(); });
  socket.on("error", function () { upstream.destroy(); });
});
// 口令轮换：懒检查已经覆盖了「有流量」的情况，这里保证长期没人访问时也会按期换。
setInterval(function () { try { maybeRotateToken(); } catch (error) { /* 轮换失败不该影响服务 */ } }, 3600000).unref();

server.on("error", function (error) {
  logLine("server error: " + (error && error.stack ? error.stack : String(error)));
  if (error.code === "EADDRINUSE") {
    console.error("[bridge] 端口 " + LISTEN_PORT + " 已被占用：换端口（--port 8099）或先停掉旧实例。");
    process.exit(2);
  }
  throw error;
});
server.listen(LISTEN_PORT, LISTEN_HOST, function () {
  logLine("listening on " + LISTEN_HOST + ":" + LISTEN_PORT + " (" + lanUrls().join(", ") + ")");
  process.stdout.write("[bridge] 监听 http://" + LISTEN_HOST + ":" + LISTEN_PORT + "  →  " + TARGET.origin + "\n");
  process.stdout.write("[bridge] 手机打开（同一 Wi-Fi）：\n");
  for (const url of lanUrls()) process.stdout.write("         " + url + "\n");
  process.stdout.write("[bridge] 安全提示：该端口等价于本机 shell 权限，勿暴露到公网。\n");
});
