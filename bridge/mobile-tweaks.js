/* mobile-tweaks.js —— 由 dsh-mobile-bridge 注入。移动端交互补丁（不碰产品状态）：
 *  1) ☰ 汉堡：常驻左轨隐藏后，用它打开抽屉式侧栏；
 *  2) 遮罩：点遮罩收回侧栏；
 *  3) 点会话：自动收回侧栏 + 抑制输入法自动聚焦；
 *  4) 「插件」药丸：三个插件 chip 竖排悬浮，不影响顶栏布局。
 * 注入的按钮/遮罩都挂在 document.body 上，不插进 React 管理的 DOM。
 */
(function () {
  /* 0) 最关键的一条：告诉客户端「这一页由本机 host 托管」。
   *    产品在 dsh-client-connection 里这样算是否本机：
   *      isLoopback = globalThis.__DSH_TRANSPORT__?.ownsHost === true || isLoopbackHostname(location.hostname)
   *    手机走的是局域网地址（192.168.x.x），于是 isLoopback=false →
   *    设置只存内存、不建「设置文档」通道 → 设置→模型 报 “settings are unavailable in this browser”。
   *    桥的请求本来就是从 127.0.0.1 转发出去的，所以补上 ownsHost 与实际一致；
   *    只补这一个字段，不动 fetch/openStream（保持走页面自带的 fetch）。 */
  if (!window.__DSH_TRANSPORT__) window.__DSH_TRANSPORT__ = { ownsHost: true };
  else if (window.__DSH_TRANSPORT__.ownsHost !== true) window.__DSH_TRANSPORT__.ownsHost = true;

  if (window.__dshMobileTweaks) return;
  window.__dshMobileTweaks = true;

  var CHIP_RE = /^(时间戳|记忆库|备份)/;
  var userTouchedEditor = false;

  /* ---------- 侧栏（抽屉） ---------- */
  function sidebarCol() { return document.querySelector('div[class*="_sidebarCol"]'); }
  function isDrawerOpen() { return document.body.classList.contains("dshm-sidebar-open"); }
  function sidebarToggleButton() {
    var col = sidebarCol();
    if (col) {
      var byClass = col.querySelector('button[class*="_toggle"]');
      if (byClass) return byClass;
    }
    var all = [].slice.call(document.querySelectorAll("button"));
    for (var i = 0; i < all.length; i++) {
      var label = all[i].getAttribute("aria-label") || "";
      if (/打开侧边栏|收起侧边栏|打开导航|open sidebar|collapse sidebar/i.test(label)) return all[i];
    }
    return null;
  }
  function openDrawer() {
    var btn = sidebarToggleButton();
    if (btn) btn.click();
  }
  function closeDrawer() {
    if (!drawerExpanded()) return;
    var btn = sidebarToggleButton();
    if (btn) btn.click();
  }
  /** 抽屉是否处于展开态：靠产品自己的折叠按钮标签判断（收起时它的 aria-label 是「收起侧边栏」）。
   *  不能用侧栏实测宽度——收起态我们会把它 display:none，宽度恒为 0，会形成死锁。 */
  function drawerExpanded() {
    var all = document.querySelectorAll("button[aria-label]");
    for (var i = 0; i < all.length; i++) {
      var label = all[i].getAttribute("aria-label") || "";
      if (/收起侧边栏|收起导航|Collapse sidebar/i.test(label)) return true;
    }
    return false;
  }
  /** 右侧面板（文件/预览）是否展开：直接看它那一列的宽度（关闭时产品把轨道设为 0）。
   *  注意不能用按钮 aria-label 判断——「打开/收起右侧边栏」两个按钮在 DOM 里始终并存。 */
  function rightbarExpanded() {
    var col = document.querySelector('div[class*="_rightbarCol"]');
    if (col && col.getBoundingClientRect().width > 40) return true;      // 宽屏：列宽有值
    var btns = document.querySelectorAll("button[aria-label]");
    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].getAttribute("aria-label") || "";
      if (/收起右侧边栏|收起右侧|Collapse right/i.test(label)) {
        // 关闭态这个按钮是 visibility:hidden 的（实测），可见即展开
        var cs = getComputedStyle(btns[i]);
        if (cs.visibility !== "hidden" && btns[i].getBoundingClientRect().width > 0) return true;
      }
    }
    return false;
  }
  function markRightbar() {
    var open = rightbarExpanded();
    if (open === document.body.classList.contains("dshm-rightbar-open")) return;
    document.body.classList.toggle("dshm-rightbar-open", open);
    if (open && document.body.classList.contains("dshm-plugins-open")) {
      document.body.classList.remove("dshm-plugins-open");
      var pill0 = document.getElementById("dshm-plugin-toggle");
      if (pill0) pill0.classList.remove("dshm-open");
    }
  }

  function markSidebar() {
    var col = sidebarCol();
    var open = drawerExpanded();
    if (open !== isDrawerOpen()) document.body.classList.toggle("dshm-sidebar-open", open);
    var scrim = document.getElementById("dshm-scrim");
    if (open && !scrim) {
      scrim = document.createElement("div");
      scrim.id = "dshm-scrim";
      scrim.addEventListener("click", function (event) { event.stopPropagation(); closeDrawer(); });
      document.body.appendChild(scrim);
    } else if (!open && scrim) {
      scrim.remove();
    }
  }
  function ensureMenu() {
    var menu = document.getElementById("dshm-menu");
    if (!menu) {
      menu = document.createElement("button");
      menu.id = "dshm-menu";
      menu.type = "button";
      menu.setAttribute("aria-label", "打开侧边栏");
      menu.textContent = "\u2630";   /* ☰ */
      menu.addEventListener("click", function (event) {
        event.stopPropagation();
        if (isDrawerOpen()) closeDrawer(); else openDrawer();
      });
      document.body.appendChild(menu);
    }
    var row = document.querySelector('div[class*="_titleRow"]');
    var top = row ? row.getBoundingClientRect().top : 10;
    menu.style.display = drawerExpanded() ? "none" : "block";
    menu.style.top = Math.max(2, Math.round(top)) + "px";
    menu.style.left = "4px";
  }

  /* ---------- 插件面板 ---------- */
  function tagChips() {
    var bs = document.querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) {
      if (CHIP_RE.test((bs[i].innerText || "").trim())) bs[i].setAttribute("data-dshm-chip", "1");
    }
  }
  function utilities() { return document.querySelector('div[class*="_headerUtilities"]'); }
  function isPanelOpen() { return document.body.classList.contains("dshm-plugins-open"); }
  function layoutPanel() {
    var pill = document.getElementById("dshm-plugin-toggle");
    if (!pill) return;
    var chips = [].slice.call(document.querySelectorAll("[data-dshm-chip]"));
    var top = pill.getBoundingClientRect().bottom + 8;
    for (var i = 0; i < chips.length; i++) chips[i].style.setProperty("top", Math.round(top + i * 36) + "px", "important");
  }
  function setPanel(open) {
    if (!document.body) return;   /* 本脚本在 </head> 前执行，此时 body 还不存在 */
    document.body.classList.toggle("dshm-plugins-open", open);
    var pill = document.getElementById("dshm-plugin-toggle");
    if (pill) pill.classList.toggle("dshm-open", open);
    layoutPanel();
  }
  function ensurePill() {
    var util = utilities();
    var pill = document.getElementById("dshm-plugin-toggle");
    if (!util) { if (pill) pill.style.display = "none"; return; }
    if (!pill) {
      pill = document.createElement("button");
      pill.id = "dshm-plugin-toggle";
      pill.type = "button";
      pill.textContent = "插件";
      pill.addEventListener("click", function (event) { event.stopPropagation(); setPanel(!isPanelOpen()); });
      document.body.appendChild(pill);
    }
    // 药丸夹在「⋯」和「打开右侧边栏」之间（同一行，不换行）：
    // 定位到右侧边栏按钮左边；⋯ 由 CSS 的 margin-right 往左让出 56px。
    var corner = document.querySelector('div[class*="_headerCorner"]');
    var cornerRect = corner ? corner.getBoundingClientRect() : null;
    pill.style.display = "block";
    if (cornerRect) {
      pill.style.top = Math.max(2, Math.round(cornerRect.top + 1)) + "px";
      pill.style.right = Math.max(4, Math.round(window.innerWidth - cornerRect.left + 6)) + "px";
    } else {
      var anchor = util.getBoundingClientRect();
      pill.style.top = Math.max(2, Math.round(anchor.top)) + "px";
      pill.style.right = "8px";
    }
    if (isPanelOpen()) layoutPanel();
  }

  /* ---------- 点会话 / 点别处 ---------- */
  function suppressComposerFocus(ms) {
    var until = Date.now() + ms;
    var timer = window.setInterval(function () {
      if (Date.now() > until || userTouchedEditor) { window.clearInterval(timer); return; }
      var el = document.activeElement;
      if (!el) return;
      var tag = (el.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input" || el.isContentEditable === true) el.blur();
    }, 100);
  }
  document.addEventListener("pointerdown", function (event) {
    var t = event.target;
    if (t && t.closest && t.closest("textarea, input, [contenteditable=true]")) userTouchedEditor = true;
  }, true);
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    /* 打开会话（会话行 / 搜索结果行）才收起抽屉；
       项目、分组这类「展开/收起」行带 aria-expanded，点它们只切换展开状态，抽屉保持打开 */
    var hit = t.closest('[class*="_sessionRow"], [class*="_searchResultRow"], [data-session-id], [role="treeitem"]');
    if (hit && !hit.hasAttribute("aria-expanded")) {
      window.setTimeout(closeDrawer, 220);
      suppressComposerFocus(1200);
      return;
    }
    if (isPanelOpen() && !t.closest("#dshm-plugin-toggle") && !t.closest("[data-dshm-chip]")) setPanel(false);
  }, true);

  /* ---------- 被压缩项的悬浮信息面板 ---------- */
  function hideInfo() {
    var el = document.getElementById("dshm-info");
    if (el) el.remove();
  }
  function showInfo(text, anchorEl) {
    if (!text) return;
    hideInfo();
    var box = document.createElement("div");
    box.id = "dshm-info";
    box.textContent = text;
    document.body.appendChild(box);
    var top = 10;
    if (anchorEl) top = Math.round(anchorEl.getBoundingClientRect().bottom + 8);
    box.style.top = Math.max(2, top) + "px";
  }
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var crumb = t.closest('nav[class*="_crumbs"] button, nav[class*="_crumbs"] span[class*="crumb"], div[class*="_headerActions"] span[class*="_label"]');
    if (crumb) {
      // 预设 chip 的完整说明在 title 属性里（比可见文字更长）
      var full = (crumb.getAttribute && crumb.getAttribute("title")) || (crumb.innerText || crumb.textContent || "").trim();
      if (full) showInfo(full, crumb);
      return;
    }
    if (!t.closest("#dshm-info") && !t.closest("#dshm-plugin-toggle")) hideInfo();
  }, true);

  /** 当前会话的 crumb 是 disabled 的，收不到点击事件；去掉 disabled 才能点开完整标题。 */
  function enableCrumbs() {
    var list = document.querySelectorAll('nav[class*="_crumbs"] button[disabled]');
    for (var i = 0; i < list.length; i++) {
      list[i].disabled = false;
      list[i].setAttribute("data-dshm-crumb", "1");
    }
  }

  /* 这一层是「手机端适配」：同一份注入也会发到桌面窗口（桌面窗口经由桥打开），
   * 桌面宽度 >720px 时绝不能在它的顶栏加 ☰/插件药丸——所以宽屏直接拆掉我们加的东西。
   * 阈值与 mobile-tweaks.css 的 @media (max-width:720px) 对齐。 */
  var MOBILE_MAX_WIDTH = 720;
  function teardownMobileChrome() {
    var ids = ["dshm-menu", "dshm-plugin-toggle", "dshm-scrim", "dshm-info"];
    var removed = false;
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) { el.remove(); removed = true; }
    }
    var classes = ["dshm-sidebar-open", "dshm-rightbar-open", "dshm-plugins-open"];
    for (var j = 0; j < classes.length; j++) {
      if (document.body.classList.contains(classes[j])) { document.body.classList.remove(classes[j]); removed = true; }
    }
    return removed;
  }
  function tick() {
    if (!document.body) return;   /* 同上：body 未就绪时什么都不做（DOMContentLoaded 后会立刻补一次） */
    if (window.innerWidth > MOBILE_MAX_WIDTH) { teardownMobileChrome(); return; }
    markRightbar();
    markSidebar();
    ensureMenu();
    enableCrumbs();
    tagChips();
    ensurePill();
  }
  try {
    new MutationObserver(tick).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"]
    });
  } catch (error) { /* 观察器不可用就靠定时器 */ }
  window.addEventListener("resize", tick);
  window.addEventListener("scroll", tick, true);
  setInterval(tick, 1000);

  /* 本脚本注入在 </head> 之前（__DSH_TRANSPORT__ 必须先于产品脚本生效），
   * 所以初始化要等 body 就绪：否则 setPanel/tick 里的 document.body 是 null。
   * 之前的写法在这里抛 TypeError，连带把紧随其后的首次 tick() 也跳过了——
   * 表现是顶栏要等 1 秒后的定时器才被整理。 */
  function boot() { setPanel(false); tick(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();

/* ---------------------- 本设备的显示（外观 / 字号） ----------------------
 * 客户端方案：值存在桥上（/__display），这里只负责应用。用的是 DSH 自己那三行写法
 * （color-scheme、body[data-ds-dark-theme]、--dsh-content-font-size），所以观感与原生一致，
 * 也不依赖 DSH 的任何内部接口 —— 它换成 remote/mux 之后，挂接口的旧做法就碎过一次。
 * 「跟随系统」会监听系统配色变化：系统切深浅，不刷新也立刻生效。 */
(function () {
  var override = null;
  function systemDark() { try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (error) { return false; } }
  function apply() {
    if (!override || !document.body) return;
    var pref = String(override.preference || "");
    var size = Number(override.fontSize);
    if (pref === "light" || pref === "dark" || pref === "system") {
      var dark = pref === "dark" || (pref === "system" && systemDark());
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      if (dark) document.body.setAttribute("data-ds-dark-theme", ""); else document.body.removeAttribute("data-ds-dark-theme");
    }
    if (size >= 12 && size <= 17) document.body.style.setProperty("--dsh-content-font-size", size + "px");
  }
  function load() {
    fetch("/__display", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (info) {
      override = info && info.value ? info.value : null;
      if (!override) return;
      apply();
      try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply); } catch (error) { /* 老内核没有 addEventListener */ }
    }).catch(function () { /* 桥不在（直连 3080）时静默跳过 */ });
  }
  // 面板改完立刻生效：面板和这段脚本同页，直接派事件即可
  window.addEventListener("dshm-display-changed", function (event) {
    override = event && event.detail ? event.detail : null;
    apply();
  });
  window.addEventListener("focus", apply);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) apply(); });
  // 页面已经渲染出来之后，DSH 的主题运行时可能再写一次属性 —— 这里隔一小会儿补一次
  window.addEventListener("load", function () { setTimeout(apply, 800); setTimeout(apply, 2500); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();
/* -------------------- 「手机端」分区的导航图标 --------------------
 * DSH 的 navIcon() 按分区 id 硬编码（models / agent-presets / plugins，其余一律齿轮），
 * 插槽只接受 id/order/label，给不了自定义图标 —— 所以在页面里把这一行换掉：
 * 用 mask 把原图形替换成手机轮廓，颜色走 currentColor，深浅色主题都正常。 */
(function () {
  var PHONE = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>"
    + "<rect x='4.3' y='1.6' width='7.4' height='12.8' rx='2.1' fill='none' stroke='%23000' stroke-width='1.4'/>"
    + "<path d='M7 12.5h2' stroke='%23000' stroke-width='1.4' stroke-linecap='round'/></svg>\")";
  function mark() {
    var icons = document.querySelectorAll('svg[class*="navIcon"]');
    for (var i = 0; i < icons.length; i++) {
      var svg = icons[i];
      if (svg.getAttribute('data-dshm-phone') === '1') continue;
      var row = svg.parentElement;
      if (!row || (row.textContent || '').indexOf('手机端') < 0) continue;
      svg.setAttribute('data-dshm-phone', '1');
      svg.style.maskImage = PHONE; svg.style.webkitMaskImage = PHONE;
      svg.style.maskSize = 'contain'; svg.style.webkitMaskSize = 'contain';
      svg.style.maskRepeat = 'no-repeat'; svg.style.maskPosition = 'center';
      svg.style.backgroundColor = 'currentColor';
    }
  }
  function boot() { mark(); setInterval(mark, 1500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
/* -------------------- 文件下载 + 预览手势缩放 --------------------
 * 1) 文件行的 ⤓：交给桥的 /__file（Android 的 DownloadListener 转交系统下载器）。
 * 2) 预览：产品按**原始尺寸**渲染、且没有缩放入口。这里不加任何常驻控件
 *    （常驻控件会挡住输入框）——改成**双指捏合缩放**（10%–2000%）+ **长按菜单**
 *    （下载到手机 / 适应宽度 / 1:1）。下载目标路径直接从
 *    [data-document-preview] 上的 dsh-resource://file/session/<sid>/<path> 解析，
 *    所以从会话里点开的预览也能下载，不依赖文件树。
 * ---------------------------------------------------------------- */
(function () {
  var MIN = 0.1, MAX = 20;
  var scale = null;              /* null = 适宽；否则为倍数 */
  var lastFile = { path: "", name: "" };
  var menuEl = null, pressTimer = 0, pinch = null, pressStart = null;

  function list(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
  function previewRoot() { return document.querySelector("[data-document-preview]"); }
  function media() {
    var root = previewRoot();
    if (!root) return [];
    return list("[data-image-preview] img", root).concat(list("[data-pdf-page] canvas", root));
  }
  function mediaVisible() {
    var nodes = media();
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 40 && nodes[i].offsetParent !== null) return true;
    }
    return false;
  }
  function naturalWidth(el) {
    if (el.tagName === "IMG") return el.naturalWidth || el.width || 0;
    return el.width || 0;
  }
  function currentScale() {
    if (scale !== null) return scale;
    var nodes = media();
    if (!nodes.length) return 1;
    var nw = naturalWidth(nodes[0]);
    var shown = nodes[0].getBoundingClientRect().width;
    return nw > 0 && shown > 0 ? shown / nw : 1;
  }
  function setFit() {
    scale = null;
    var nodes = media();
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].style.width = "";
      nodes[i].style.height = "";
      nodes[i].style.maxWidth = "";
    }
    if (document.body.className.indexOf("dshm-pv-fit") < 0) document.body.classList.add("dshm-pv-fit");
  }
  function setScale(next) {
    scale = Math.min(MAX, Math.max(MIN, next));
    document.body.classList.remove("dshm-pv-fit");
    var nodes = media();
    for (var i = 0; i < nodes.length; i++) {
      var nw = naturalWidth(nodes[i]);
      if (!nw) continue;
      nodes[i].style.maxWidth = "none";
      nodes[i].style.height = "auto";
      nodes[i].style.width = Math.round(nw * scale) + "px";
    }
  }
  function inPreview(target) { return !!(target && target.closest && target.closest("[data-document-preview]")); }

  /* ---------- 下载 ---------- */
  /** 只认「看起来真的是绝对路径」的结果：当前版本的 data-document-preview 是合成 tab id
   *  （形如 @deepseek-ai/.../image），早期版本直接拿去下载会 404 —— 所以必须校验。 */
  function looksLikePath(value) {
    if (!value || typeof value !== "string") return false;
    if (value.indexOf("@") >= 0 || value.indexOf("dsh-resource") >= 0) return false;
    return /^[A-Za-z]:[\\/]/.test(value) || value.charAt(0) === "/" || /^\\\\/.test(value);
  }
  function decodeAddress(address) {
    if (!address) return "";
    var rest = String(address).replace(/^dsh-resource:\/\/file\//, "");
    var parts = rest.split("/");
    if (parts[0] === "session") parts.splice(0, 2);       /* 去掉 session/<sid> */
    var decoded = [];
    for (var i = 0; i < parts.length; i++) {
      try { decoded.push(decodeURIComponent(parts[i])); } catch (error) { decoded.push(parts[i]); }
    }
    var joined = decoded.join("/");
    return looksLikePath(joined) ? joined : "";
  }
  /* 路径来源（按可靠性排序）：
     ① 产品把展示路径挂在 title 上（预览头部/标签），形如 C:\... 或 /home/...；
     ② 文件树里最近点开的那个文件；
     ③ data-document-preview 上万一给的是真实资源地址，也能解。（实测当前版本是合成 tab id，解不出来。） */
  function pathFromTitle() {
    var nodes = document.querySelectorAll("#dshm-pv-menu, [title]");
    var best = "";
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].getAttribute("title") || "";
      if (t.length < 4 || t.length > 400) continue;
      if (!/[\\/]/.test(t)) continue;
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }
  function currentPath() {
    var fromTitle = pathFromTitle();                 /* ① 预览头部 title 上的展示路径（最可靠） */
    if (fromTitle) return fromTitle;
    if (lastFile.path) return lastFile.path;         /* ② 文件树里最近点开的文件 */
    var root = previewRoot();                        /* ③ 兜底：真实资源地址（当前版本解不出来） */
    var fromAddress = root ? decodeAddress(root.getAttribute("data-document-preview")) : "";
    return fromAddress || "";
  }
  function baseName(p) { var at = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return at < 0 ? p : p.slice(at + 1); }
  function download(path, name) {
    if (!path) return false;
    var a = document.createElement("a");
    a.href = "/__file?path=" + encodeURIComponent(path);
    a.rel = "noopener";
    if (name) a.setAttribute("download", name);
    document.body.appendChild(a);
    a.click();
    window.setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
    return true;
  }

  /* ---------- 文件行的 ⤓ ---------- */
  function nameOf(li) { var n = li.querySelector('[class*="_name"]'); return n ? String(n.textContent || "").trim() : ""; }
  function addRowButton(li) {
    if (li.getAttribute("data-dshm-dl") === "1") return;
    li.setAttribute("data-dshm-dl", "1");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dshm-dl";
    btn.setAttribute("aria-label", "下载到手机");
    btn.textContent = "\u2913";
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      download(li.getAttribute("data-files-path"), nameOf(li));
    });
    li.appendChild(btn);
  }
  function markRows() {
    var rows = list('li[data-files-entry="file"][data-files-path]');
    for (var i = 0; i < rows.length; i++) addRowButton(rows[i]);
  }
  var menuOpenedAt = 0;
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    /* 长按抬手会补一次 click：别拿它把刚弹出的菜单关掉 */
    if (Date.now() - menuOpenedAt < 600) return;
    if (t.closest("#dshm-pv-menu")) return;      /* 点在菜单内部更不该关 */
    var li = t.closest('li[data-files-entry="file"][data-files-path]');
    if (li) { lastFile = { path: li.getAttribute("data-files-path") || "", name: nameOf(li) }; return; }
    hideMenu();
  }, true);

  /* ---------- 长按菜单 ---------- */
  function hideMenu() { if (menuEl && menuEl.parentNode) { menuEl.parentNode.removeChild(menuEl); } menuEl = null; }
  function showMenu(x, y) {
    hideMenu();
    var path = currentPath();
    var box = document.createElement("div");
    box.id = "dshm-pv-menu";
    var mk = function (text, handler, disabled) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      if (disabled) b.disabled = true;
      b.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); hideMenu(); if (!disabled) handler(); });
      box.appendChild(b);
      return b;
    };
    mk("\u2913  下载到手机", function () { download(path, baseName(path)); }, !path);
    mk("适应宽度", function () { setFit(); });
    mk("1:1 原始大小", function () { setScale(1); });
    document.body.appendChild(box);
    var rect = box.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(x - 20, window.innerWidth - rect.width - 6)) + "px";
    box.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)) + "px";
    menuEl = box;
    menuOpenedAt = Date.now();
  }

  /* ---------- 双指捏合 ---------- */
  function distance(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  }
  document.addEventListener("touchstart", function (event) {
    if (!inPreview(event.target)) return;
    if (event.touches.length === 2) {
      window.clearTimeout(pressTimer);
      pinch = { start: distance(event.touches), scale: currentScale() };
      event.preventDefault();
      return;
    }
    if (event.touches.length === 1) {
      var t = event.touches[0];
      pressStart = { x: t.clientX, y: t.clientY };
      window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(function () { showMenu(t.clientX, t.clientY); }, 520);
    }
  }, { passive: false });
  document.addEventListener("touchmove", function (event) {
    if (pinch && event.touches.length === 2) {
      setScale(pinch.scale * (distance(event.touches) / pinch.start));
      event.preventDefault();
      return;
    }
    if (pressStart && event.touches.length === 1) {
      var t = event.touches[0];
      if (Math.abs(t.clientX - pressStart.x) + Math.abs(t.clientY - pressStart.y) > 12) window.clearTimeout(pressTimer);
    }
  }, { passive: false });
  document.addEventListener("touchend", function (event) {
    if (event.touches.length < 2) pinch = null;
    if (event.touches.length === 0) window.clearTimeout(pressTimer);
  }, { passive: true });
  document.addEventListener("contextmenu", function (event) { if (inPreview(event.target)) event.preventDefault(); }, true);

  /* ---------- 循环：只做幂等写入，绝不用 MutationObserver 驱动（会自激死循环） ---------- */
  function tick() {
    markRows();
    var has = !!previewRoot() && mediaVisible();
    if (has && scale === null && document.body.className.indexOf("dshm-pv-fit") < 0) setFit();
    if (!has && menuEl) hideMenu();
  }
  function boot() { tick(); window.setInterval(tick, 700); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
