// mobile-panel.js —— 由 dsh-mobile-bridge 注入的客户端插件：设置里的「手机端」分区
//
// 为什么由桥发而不是装成真插件：真插件要写进 ~/.dsh/profiles/web/package.json 的
// dsh.profile.bundles，patchReload=startup —— 得重启 harness（会掐断正在进行的会话）。
// 桥反正会改写发出去的 HTML，就顺手把 __DSH_BOOT__ 里追加一条自己的插件条目
// （注意：条目必须同时登记进 batches，否则客户端启动直接失败、整页白屏）。
//
// 面板内容：
//   ① 二维码（扫码打开网页版 / 下载 App；App 内扫码可直接连上这台电脑）
//   ② 设备管理：按「机型级特征码」聚合的设备列表（界面只显示随机 ID + 名称），
//      待认证的可以 ✓ 允许 / ✗ 拒绝，已认证的可以踢出，被拒绝的可以恢复
//   ③ 任何页面里都会跑一个「待认证」观察器：有新设备请求接入时弹一张卡片（不用打开设置）
window.__ModuleLoader__.load({
  id: 'dsh-mobile-panel',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');

    const inject = ['slots'];
    const API = '/__devices';
    const STYLE_ID = 'dsh-mobile-panel/styles';
    const TOAST_ID = 'dshm-approval-toast';
    const POLL_MS = 5000;

    /* ------------------------------- 样式 ------------------------------- */
    function installStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.dshmp-info{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.dshmp-info-btn{width:16px;height:16px;padding:0;border-radius:50%;border:1px solid currentColor;background:transparent;color:inherit;opacity:.5;font:600 11px/14px ui-sans-serif,system-ui;cursor:pointer;flex:none}',
        '.dshmp-info-btn:hover,.dshmp-info-on{opacity:.95}',
        '.dshmp-info-body{flex:1 1 100%;font-size:12.5px;line-height:1.7;opacity:.75;padding:9px 11px;border-radius:9px;background:rgba(127,127,127,.12)}',
        '.dshmp-wrap{display:flex;flex-direction:column;gap:18px;padding:4px 2px 8px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
        '.dshmp-title{font-weight:600;font-size:15px}',
        '.dshmp-card{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2,#00000014);border-radius:14px;padding:16px 18px}',
        '.dshmp-qr{width:180px;height:180px;border-radius:10px;background:#fff;padding:7px;box-sizing:border-box;flex:none}',
        '.dshmp-col{flex:1 1 240px;min-width:240px;display:flex;flex-direction:column;gap:10px}',
        '.dshmp-muted{color:var(--dsw-alias-label-secondary,#666)}',
        '.dshmp-url{flex:1 1 100%;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:13px;background:var(--dsw-alias-bg-layer-1,#00000008);border-radius:8px;padding:6px 9px;word-break:break-all}',
        '.dshmp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.dshmp-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:9px;padding:5px 11px;font-family:inherit;font-size:13px;line-height:20px}',
        '.dshmp-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}',
        '.dshmp-btn[disabled]{opacity:.5;cursor:default}',
        '.dshmp-btn-ok{border-color:#22c55e;color:#16a34a}',
        '.dshmp-btn-no{border-color:#f87171;color:#dc2626}',
        '.dshmp-select{font-family:inherit;font-size:13px;padding:4px 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;max-width:100%}',
        '.dshmp-devices{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2,#00000014)}',
        '.dshmp-dev{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--dsw-alias-border-l2,#0000000f)}',
        '.dshmp-dev-name{font-weight:500}',
        '.dshmp-dev-pending{background:#f59e0b18;border-radius:10px;padding-left:8px;padding-right:8px}',
        '.dshmp-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}',
        '.dshmp-on{background:#22c55e}.dshmp-off{background:#9ca3af}.dshmp-wait{background:#f59e0b}',
        '.dshmp-tag{font-size:12px;border-radius:6px;padding:1px 6px;background:var(--dsw-alias-bg-layer-1,#0000000d);white-space:nowrap}',
        '.dshmp-grow{flex:1;min-width:0}',
        '.dshmp-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshmp-err{color:#dc2626}',
        '.dshmp-blocked{opacity:.6}',
        '.dshmp-sec{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px}',
        '.dshmp-sec-line{flex:1;height:1px;background:var(--dsw-alias-border-l2,#00000014)}',
        '#dshm-approval-toast{position:fixed;top:14px;right:14px;z-index:2147483000;width:300px;box-sizing:border-box;',
        'background:var(--dsw-alias-bg-layer-2,#1b1d22);color:var(--dsw-alias-label-primary,#eee);border:1px solid #f59e0b;',
        'border-radius:14px;padding:14px 16px;box-shadow:0 12px 32px #00000055;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
        '#dshm-approval-toast .t{font-weight:600;margin-bottom:6px}',
        '#dshm-approval-toast .id{font-family:ui-monospace,Consolas,monospace;color:#fbbf24;letter-spacing:.05em}',
        '#dshm-approval-toast .meta{color:#9ca3af;font-size:12.5px;margin-bottom:10px;white-space:pre-line}',
        '#dshm-approval-toast .btns{display:flex;gap:8px}',
        '#dshm-approval-toast button{flex:1;cursor:pointer;border-radius:9px;padding:6px 0;font:inherit;font-size:13px;',
        'background:transparent;color:inherit;border:1px solid #ffffff33}',
        '#dshm-approval-toast button.ok{border-color:#22c55e;color:#4ade80}',
        '#dshm-approval-toast button.no{border-color:#f87171;color:#fca5a5}',
      ].join('');
      document.head.appendChild(style);
    }

    /* ------------------------------ 小工具 ------------------------------ */
    function relativeTime(ts) {
      if (!ts) return '';
      const seconds = Math.round((Date.now() - ts) / 1000);
      if (seconds < 10) return '刚刚';
      if (seconds < 60) return seconds + ' 秒前';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + ' 分钟前';
      const hours = Math.round(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.round(hours / 24) + ' 天前';
    }
    function humanSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }
    function loadDevices(host) {
      return fetch(API + (host ? '?host=' + encodeURIComponent(host) : ''), { cache: 'no-store' })
        .then(function (res) { return res.json(); });
    }
    function act(path, id, extra) {
      return fetch(path + '?id=' + encodeURIComponent(id) + (extra || ''), { method: 'POST' }).then(function (r) { return r.json(); });
    }

    /* --------------------- 待认证弹窗（不需要打开设置） --------------------- */
    function startApprovalWatcher() {
      let current = null;
      function close() { if (current) { current.remove(); current = null; } }
      function render(device, pendingCount) {
        if (current && current.dataset.deviceId === device.id) return;
        close();
        const box = document.createElement('div');
        box.id = TOAST_ID;
        box.dataset.deviceId = device.id;
        const title = document.createElement('div');
        title.className = 't';
        title.textContent = pendingCount > 1 ? ('有 ' + pendingCount + ' 台设备请求接入') : '有新设备请求接入';
        const idLine = document.createElement('div');
        idLine.className = 'id';
        idLine.textContent = device.id;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = device.name + ' · ' + (device.platform || '') + '\n' + ((device.ips && device.ips[0]) || '') + ' · ' + relativeTime(device.lastSeen);
        const btns = document.createElement('div');
        btns.className = 'btns';
        const ok = document.createElement('button');
        ok.className = 'ok';
        ok.textContent = '允许';
        const no = document.createElement('button');
        no.className = 'no';
        no.textContent = '拒绝';
        const later = document.createElement('button');
        later.textContent = '稍后';
        ok.onclick = function () { ok.disabled = true; no.disabled = true; act('/__approve', device.id).then(close, close); };
        no.onclick = function () { ok.disabled = true; no.disabled = true; act('/__deny', device.id).then(close, close); };
        later.onclick = close;
        btns.appendChild(ok); btns.appendChild(no); btns.appendChild(later);
        box.appendChild(title); box.appendChild(idLine); box.appendChild(meta); box.appendChild(btns);
        document.body.appendChild(box);
        current = box;
      }
      function poll() {
        loadDevices().then(function (data) {
          const pending = (data.devices || []).filter(function (d) { return d.state === 'pending'; });
          if (!pending.length) { close(); return; }
          if (window.location.pathname !== '/') { close(); return; }   // 等待页/落地页不弹
          render(pending[0], pending.length);
        }).catch(function () { /* 未认证或网络抖动：静默 */ });
      }
      poll();
      setInterval(poll, POLL_MS);
    }

    /* ------------------------------- 面板 ------------------------------- */
    function DeviceRow(props) {
      const device = props.device;
      const busy = props.busy === device.id;
      const dotClass = device.state === 'pending' ? 'dshmp-wait' : (device.online ? 'dshmp-on' : 'dshmp-off');
      const buttons = [];
      const canAdmin = props.canAdmin !== false;      // 普通已认证设备只读：按钮交给后端闸门管，但界面也别给
      if (canAdmin && device.state === 'pending') {
        buttons.push(react.createElement('button', { key: 'ok', type: 'button', className: 'dshmp-btn dshmp-btn-ok', disabled: busy, onClick: function () { props.onAct('/__approve', device); } }, '✓ 允许'));
        buttons.push(react.createElement('button', { key: 'no', type: 'button', className: 'dshmp-btn dshmp-btn-no', disabled: busy, onClick: function () { props.onAct('/__deny', device); } }, '✗ 拒绝'));
      } else if (canAdmin && device.state === 'approved') {
        buttons.push(react.createElement('button', {
          key: 'trust', type: 'button',
          className: 'dshmp-btn' + (device.trusted ? ' dshmp-btn-ok' : ''),
          disabled: busy,
          title: device.trusted
            ? '取消后，这台设备从外网进来会重新要求接入口令'
            : '完全信任：这台设备从外网进来不再要求接入口令',
          onClick: function () { props.onAct(device.trusted ? '/__trust' : '/__trust', device, device.trusted ? '&on=0' : '&on=1'); }
        }, device.trusted ? '✓ 完全信任' : '完全信任'));
        buttons.push(react.createElement('button', {
          key: 'kick', type: 'button', className: 'dshmp-btn', disabled: busy,
          title: '断开并拒绝这台设备', onClick: function () { props.onAct('/__kick', device); }
        }, '踢出'));
      } else if (canAdmin) {
        buttons.push(react.createElement('button', { key: 'back', type: 'button', className: 'dshmp-btn', disabled: busy, onClick: function () { props.onAct('/__unblock', device); } }, '恢复'));
      }
      const badges = [];
      if (device.state === 'pending') badges.push(react.createElement('span', { key: 'p', className: 'dshmp-tag' }, '待认证'));
      if (device.state === 'denied') badges.push(react.createElement('span', { key: 'd', className: 'dshmp-tag' }, '已拒绝'));
      if (device.local) badges.push(react.createElement('span', { key: 'l', className: 'dshmp-tag' }, '本机'));
      if (device.self) badges.push(react.createElement('span', { key: 's', className: 'dshmp-tag' }, '当前页面'));
      if (device.trusted) badges.push(react.createElement('span', { key: 't', className: 'dshmp-tag' }, '外网免口令'));
      if (device.browsers > 1) badges.push(react.createElement('span', { key: 'b', className: 'dshmp-tag' }, device.browsers + ' 个浏览器'));
      return react.createElement('div', { className: 'dshmp-dev' + (device.state === 'pending' ? ' dshmp-dev-pending' : '') },
        react.createElement('span', { className: 'dshmp-dot ' + dotClass }),
        react.createElement('div', { className: 'dshmp-grow' },
          react.createElement('div', { className: 'dshmp-dev-name' + (device.state === 'denied' ? ' dshmp-blocked' : '') },
            device.name,
            react.createElement('span', { className: 'dshmp-muted', style: { marginLeft: 8, fontFamily: 'ui-monospace,Consolas,monospace' } }, device.id),
            badges
          ),
          react.createElement('div', { className: 'dshmp-muted dshmp-ellipsis' },
            (device.ips && device.ips.length ? device.ips.join(' / ') + ' · ' : '') +
            (device.state === 'approved' ? (device.online ? '在线' : '最后活跃 ' + relativeTime(device.lastSeen)) : (device.platform || '')) +
            (device.hasOverrides ? ' · 有本机专属设置' : '')
          )
        ),
        buttons
      );
    }

    function MobileSection() {
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState('');
      const [host, setHost] = react.useState('');
      const [busy, setBusy] = react.useState('');
      const [tick, setTick] = react.useState(0);
      /** 接入口令的轮换说明：多久换一次、还剩多久。 */
function tokenNote(wan) {
  const days = Number(wan.tokenDays || 0);
  if (!days) return '口令不自动更换（可手动「换一个」）。';
  const at = Number(wan.tokenRotatesAt || 0);
  const base = '口令每 ' + days + ' 天自动更换';
  if (!at) return base + '。';
  const left = Math.max(0, at - Date.now());
  const d = Math.floor(left / 86400000);
  const h = Math.floor((left % 86400000) / 3600000);
  return base + '，' + (d > 0 ? '还剩 ' + d + ' 天' + (h ? ' ' + h + ' 小时' : '') : '还剩 ' + h + ' 小时')
    + '。已「完全信任」的设备不受影响。';
}
/** 「i」折叠说明：长解释默认收起，需要时再点开。 */
function Info(props) {
  const [open, setOpen] = react.useState(false);
  return react.createElement('span', { className: 'dshmp-info' },
    react.createElement('button', {
      type: 'button',
      className: 'dshmp-info-btn' + (open ? ' dshmp-info-on' : ''),
      title: props.title || '说明',
      'aria-label': props.title || '说明',
      onClick: function (event) { event.preventDefault(); event.stopPropagation(); setOpen(!open); }
    }, 'i'),
    open ? react.createElement('div', { className: 'dshmp-info-body' }, props.children) : null
  );
}
/** 复制到剪贴板：WebView 里 navigator.clipboard 需要安全上下文，这里带一个 textarea 兜底。 */
function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
  } catch (error) { /* 落到兜底 */ }
  try {
    const area = document.createElement('textarea');
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select(); document.execCommand('copy'); document.body.removeChild(area);
  } catch (error) { /* 复制失败就算了，用户可长按选中 */ }
}
const [qrMode, setQrMode] = react.useState('lan');     // lan=局域网二维码，wan=外网二维码
      const [display, setDisplay] = react.useState(undefined);
      const [wanInput, setWanInput] = react.useState('');
      const [wanBusy, setWanBusy] = react.useState(false);

      const load = react.useCallback(function () {
        loadDevices(host).then(function (json) { setData(json); setError(''); })
          .catch(function (err) { setError(String((err && err.message) || err)); });
      }, [host]);

      react.useEffect(function () { installStyles(); }, []);
      react.useEffect(function () {
        load();
        const timer = setInterval(function () { load(); setTick(function (n) { return n + 1; }); }, POLL_MS);
        return function () { clearInterval(timer); };
      }, [load]);

      function saveWan(url) {
        setWanBusy(true);
        fetch('/__wan?url=' + encodeURIComponent(url || ''), { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function () { setQrMode(url ? 'wan' : 'lan'); load(); })
          .catch(function () { /* 下一次轮询会纠正 */ })
          .then(function () { setWanBusy(false); });
      }
      function rotateToken() {
        if (!window.confirm('换一个接入口令？已经用旧口令连上的设备需要重新扫码。')) return;
        setWanBusy(true);
        fetch('/__wan?rotate=1', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function () { load(); })
          .catch(function () { })
          .then(function () { setWanBusy(false); });
      }

      function onAct(path, device, extra) {
        let question = null;
        if (path === '/__approve') question = '允许「' + device.name + '」接入？';
        else if (path === '/__deny') question = '拒绝「' + device.name + '」接入？它会被立刻断开。';
        else if (path === '/__kick') question = '把「' + device.name + '」踢下线？它会立刻断开，并需要重新认证。';
        else if (path === '/__trust') {
          question = device.trusted
            ? '取消「' + device.name + '」的完全信任？取消后它从外网进来会重新要求接入口令。'
            : '把「' + device.name + '」设为完全信任？之后它从外网进来不再需要接入口令。';
        }
        if (question && !window.confirm(question)) return;
        setBusy(device.id);
        act(path, device.id, extra).then(load).catch(function () { /* 下一次轮询会纠正 */ }).then(function () { setBusy(''); });
      }

      if (error) {
        return react.createElement('div', { className: 'dshmp-wrap' },
          react.createElement('div', { className: 'dshmp-title' }, '手机端'),
          react.createElement('div', { className: 'dshmp-err' }, '读不到桥的信息：' + error),
          react.createElement('div', { className: 'dshmp-muted' }, '这个面板需要页面由 dsh-mobile-bridge 提供（桌面窗口请用启动器打开，它会自动走桥）。'));
      }
      if (!data) return react.createElement('div', { className: 'dshmp-wrap' }, react.createElement('div', { className: 'dshmp-muted' }, '加载中…'));

      const devices = data.devices || [];
      const pending = devices.filter(function (d) { return d.state === 'pending'; });
      const approved = devices.filter(function (d) { return d.state === 'approved'; });
      const denied = devices.filter(function (d) { return d.state === 'denied'; });
      const onlineCount = approved.filter(function (d) { return d.online; }).length;
      const wan = data.wan || { url: '', token: '', qrText: '' };
      const scope = data.scope || 'local';        // local=电脑窗口  trusted=完全信任设备  device=普通已认证设备
      const canAdmin = scope === 'local' || scope === 'trusted';
      // 本设备的显示设置：undefined=还没动过（用服务端那份），null=跟随电脑，对象=已覆盖
      const effDisplay = display === undefined ? ((data.display && data.display.value) || null) : display;
      const fontRange = (data.display && data.display.range) || [12, 17];
      const effLocale = (data.display && data.display.locale) || null;
      function saveLocale(lang) {
        fetch('/__display?locale=' + encodeURIComponent(lang), { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function () { try { location.reload(); } catch (error) { /* 忽略 */ } })
          .catch(function () { /* 失败维持原样 */ });
      }
      const currentFont = (effDisplay && effDisplay.fontSize) || 14;
      function saveDisplay(clear, preference, fontSize) {
        const q = [];
        if (clear) q.push('clear=1');
        if (preference) q.push('preference=' + encodeURIComponent(preference));
        if (fontSize) q.push('fontSize=' + fontSize);
        fetch('/__display?' + q.join('&'), { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (info) {
            const next = info && info.value ? info.value : null;
            setDisplay(next);
            try { window.dispatchEvent(new CustomEvent('dshm-display-changed', { detail: next })); } catch (error) { /* 忽略 */ }
          })
          .catch(function () { /* 失败就维持原样 */ });
      }
      const wanReady = Boolean(wan.url);
      const useWanQr = qrMode === 'wan' && wanReady;
      const qrSrc = useWanQr
        ? '/__qr.png?scale=8&wan=1&t=' + tick
        : '/__qr.png?scale=8' + (host ? '&host=' + encodeURIComponent(host) : '') + '&t=' + tick;
      const rowProps = { busy: busy, onAct: onAct, canAdmin: canAdmin };

      function section(title, list) {
        if (!list.length) return null;
        return react.createElement('div', { key: title },
          react.createElement('div', { className: 'dshmp-sec' },
            react.createElement('span', { className: 'dshmp-title' }, title),
            react.createElement('span', { className: 'dshmp-muted' }, list.length + ' 台'),
            react.createElement('span', { className: 'dshmp-sec-line' })
          ),
          react.createElement('div', { className: 'dshmp-devices' }, list.map(function (device) {
            return react.createElement(DeviceRow, Object.assign({ key: device.id, device: device }, rowProps));
          }))
        );
      }

      return react.createElement('div', { className: 'dshmp-wrap' },
        react.createElement('div', { className: 'dshmp-title' }, '手机端'),
        react.createElement('div', { className: 'dshmp-card' },
          react.createElement('img', { className: 'dshmp-qr', src: qrSrc, alt: '扫码连接本机' }),
          react.createElement('div', { className: 'dshmp-col' },
            react.createElement('div', { className: 'dshmp-row' },
              react.createElement('span', null, '同一 Wi-Fi 下扫码接入'),
              react.createElement(Info, { title: '接入说明' },
                '浏览器扫码可打开网页版，页面内亦可下载 App；App 内「扫一扫」直接填入本机地址。新设备需在本机批准，已认证设备无需重复批准。')
            ),
            react.createElement('div', { className: 'dshmp-row' },
              (data.hosts && data.hosts.length > 1)
                ? react.createElement('select', {
                    className: 'dshmp-select',
                    value: host || data.qrHost,
                    onChange: function (event) { setHost(event.target.value); }
                  }, data.hosts.map(function (item) {
                    return react.createElement('option', { key: item.address, value: item.address }, item.address + '（' + item.name + '）');
                  }))
                : null,
              react.createElement('div', { className: 'dshmp-url' }, data.qrText)
            ),
            react.createElement('div', { className: 'dshmp-row' },
              react.createElement('a', { className: 'dshmp-btn', href: '/__apk', style: { textDecoration: 'none' } },
                data.apk ? '下载最新 App（' + data.apk.name.replace(/^dsh-mobile-/, '') + ' · ' + humanSize(data.apk.size) + '）' : '下载 App')
            )
          )
        ),
        react.createElement('div', null,
          react.createElement('div', { className: 'dshmp-sec' },
            react.createElement('span', { className: 'dshmp-title' }, '仅本设备的显示'),
            react.createElement('span', { className: 'dshmp-muted' }, effDisplay ? '已单独设置' : '跟随电脑'),
            react.createElement('span', { className: 'dshmp-sec-line' })
          ),
          react.createElement('div', { className: 'dshmp-row', style: { marginBottom: 8 } },
            react.createElement('span', { className: 'dshmp-muted' }, '只作用于这台设备（电脑不受影响）'),
            react.createElement(Info, { title: '显示设置说明' },
              '上面的「通用设置」里也有外观 / 字号 / 语言，但那三项是全局的，在手机上改会同时改到电脑；'
              + '这里的设置按设备保存，只作用于当前设备，切换浏览器或重装后仍沿用。'
              + '语言在页面加载时解析，改完需刷新一次。')),
          react.createElement('div', { className: 'dshmp-row' },
            react.createElement('span', { className: 'dshmp-muted' }, '外观'),
            [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(function (pair) {
              const active = Boolean(effDisplay && effDisplay.preference === pair[0]);
              return react.createElement('button', {
                key: pair[0], type: 'button',
                className: 'dshmp-btn' + (active ? ' dshmp-btn-ok' : ''),
                onClick: function () { saveDisplay(false, pair[0]); }
              }, pair[1]);
            }),
            react.createElement('button', {
              type: 'button', className: 'dshmp-btn',
              onClick: function () { saveDisplay(true); }
            }, '跟随电脑')
          ),
          react.createElement('div', { className: 'dshmp-row', style: { marginTop: 6 } },
            react.createElement('span', { className: 'dshmp-muted' }, '正文字号'),
            react.createElement('button', {
              type: 'button', className: 'dshmp-btn', disabled: currentFont <= fontRange[0],
              onClick: function () { saveDisplay(false, null, currentFont - 1); }
            }, '−'),
            react.createElement('code', { className: 'dshmp-url' }, currentFont + 'px'),
            react.createElement('button', {
              type: 'button', className: 'dshmp-btn', disabled: currentFont >= fontRange[1],
              onClick: function () { saveDisplay(false, null, currentFont + 1); }
            }, '+')
          ),
          react.createElement('div', { className: 'dshmp-row', style: { marginTop: 6 } },
            react.createElement('span', { className: 'dshmp-muted' }, '语言'),
            [['zh', '中文'], ['en', 'English']].map(function (pair) {
              const active = effLocale === pair[0];
              return react.createElement('button', {
                key: pair[0], type: 'button',
                className: 'dshmp-btn' + (active ? ' dshmp-btn-ok' : ''),
                onClick: function () { saveLocale(pair[0]); }
              }, pair[1]);
            }),
            react.createElement('button', {
              type: 'button', className: 'dshmp-btn' + (effLocale ? '' : ' dshmp-btn-ok'),
              onClick: function () { saveLocale('clear'); }
            }, '跟随浏览器'),
            react.createElement('span', { className: 'dshmp-muted', style: { fontSize: 12 } }, '改语言需刷新页面')
          )
        ),
        react.createElement('div', null,
          react.createElement('div', { className: 'dshmp-sec' },
            react.createElement('span', { className: 'dshmp-title' }, '外网访问'),
            react.createElement('span', { className: 'dshmp-muted' }, scope === 'local' ? (wanReady ? '已配置' : '未配置') : '由电脑管理'),
            react.createElement('span', { className: 'dshmp-sec-line' })
          ),
          react.createElement('div', { className: 'dshmp-row', style: { marginBottom: 8 } },
            react.createElement('span', { className: 'dshmp-muted' }, '外网接入地址'),
            react.createElement(Info, { title: '外网访问说明' },
              '用任意内网穿透 / 反向代理服务，把隧道指向本机 127.0.0.1:8099，并将其对外地址填在此处。'
              + '外网访问需携带接入口令；本机认证过的新设备仍需批准。'
              + '如需某台设备免口令，在设备管理中将其设为「完全信任」（可随时撤销）。')
          ),
          scope === 'local' ? react.createElement('div', { className: 'dshmp-row' },
            react.createElement('input', {
              className: 'dshmp-select dshmp-grow',
              style: { flex: '1 1 220px', fontFamily: 'ui-monospace,Consolas,monospace' },
              placeholder: 'https://your-domain.example 或 http://host:port',
              value: wanInput || wan.url,
              onChange: function (event) { setWanInput(event.target.value); }
            }),
            react.createElement('button', {
              type: 'button', className: 'dshmp-btn', disabled: wanBusy,
              onClick: function () { saveWan(wanInput || wan.url); }
            }, '保存'),
            wanReady ? react.createElement('button', {
              type: 'button', className: 'dshmp-btn', disabled: wanBusy,
              onClick: function () { setWanInput(''); saveWan(''); }
            }, '清除') : null
          ) : null,
          scope !== 'local' ? react.createElement('div', { className: 'dshmp-muted', style: { fontSize: 12.5 } },
            scope === 'trusted'
              ? '接入口令与外网二维码仅在本机面板显示。'
              : '口令、外网二维码与设备管理仅在本机面板显示。') :
          wanReady ? react.createElement('div', null,
            react.createElement('div', { className: 'dshmp-row', style: { marginTop: 8 } },
              react.createElement('span', { className: 'dshmp-muted' }, '接入口令'),
              react.createElement('code', { className: 'dshmp-url', style: { flex: '1 1 200px' } }, wan.token),
              react.createElement('button', { type: 'button', className: 'dshmp-btn', onClick: function () { copyText(wan.token); } }, '复制'),
              react.createElement('button', { type: 'button', className: 'dshmp-btn', disabled: wanBusy, onClick: rotateToken }, '换一个')
            ),
            react.createElement('div', { className: 'dshmp-muted', style: { marginTop: 6, fontSize: 12 } }, tokenNote(wan)),
            react.createElement('div', { className: 'dshmp-url', style: { marginTop: 8 } }, wan.qrText),
            react.createElement('div', { className: 'dshmp-row', style: { marginTop: 8 } },
              react.createElement('span', { className: 'dshmp-muted' }, '上面二维码显示'),
              react.createElement('button', {
                type: 'button', className: 'dshmp-btn' + (useWanQr ? '' : ' dshmp-btn-ok'),
                onClick: function () { setQrMode('lan'); }
              }, '局域网'),
              react.createElement('button', {
                type: 'button', className: 'dshmp-btn' + (useWanQr ? ' dshmp-btn-ok' : ''),
                onClick: function () { setQrMode('wan'); }
              }, '外网')
            )
          ) : null
        ),
        react.createElement('div', null,
          react.createElement('div', { className: 'dshmp-row' },
            react.createElement('div', { className: 'dshmp-title dshmp-grow' }, '设备管理',
              react.createElement('span', { className: 'dshmp-muted', style: { fontWeight: 400 } },
                '（' + approved.length + ' 台已认证，' + onlineCount + ' 台在线' + (pending.length ? '，' + pending.length + ' 台待认证' : '') + '）')),
            react.createElement('button', { type: 'button', className: 'dshmp-btn', onClick: load }, '刷新')
          ),
          devices.length === 0
            ? react.createElement('div', { className: 'dshmp-muted', style: { padding: '10px 2px' } }, '还没有设备接入。')
            : react.createElement('div', null,
                section('待认证', pending),
                section('已认证', approved),
                section('已拒绝', denied)
              ),
          react.createElement('div', { style: { marginTop: 10 } },
            react.createElement(Info, { title: '设备识别方式' },
              '按机型级公共特征识别：系统、屏幕分辨率、像素比、CPU 核数、内存档位、触摸点数、时区、主语言。'
              + '不含账号、IMEI、MAC，不做指纹追踪；特征码仅以加盐哈希留存，界面只显示随机 ID。'))
        )
      );
    }

    /* ------------------------------ 注册 ------------------------------ */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;
      installStyles();
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'mobile', order: 40, label: function () { return '手机端'; } },
          MobileSection
        );
      });
      startApprovalWatcher();   // 不打开设置也能收到「新设备请求接入」弹窗
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
