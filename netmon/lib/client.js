// dsh-netmon — Client half.
//
// A chip in the session header (same row as the other plugin chips) that opens
// a small panel: bridge health, LAN entry, tunnel reachability, devices.
// All data comes from the host route POST /dsh-netmon/api via fetch.
window.__ModuleLoader__.load({
  id: 'dsh-netmon',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');

    function rpc(method, args) {
      return fetch('/dsh-netmon/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: method, args: args || {} }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, reason: String(e && e.message !== undefined ? e.message : e) }));
    }

    const chipStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
      borderRadius: 999, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'transparent', color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      fontSize: 12, lineHeight: '18px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    };
    const cardStyle = {
      position: 'fixed', top: 54, right: 14, zIndex: 60, width: 340, maxWidth: 'calc(100vw - 28px)',
      maxHeight: 'calc(100vh - 90px)', overflow: 'auto', padding: '12px 14px',
      borderRadius: 12, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-raised, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #222)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.22)', fontSize: 12, lineHeight: '18px',
      fontFamily: 'inherit',
    };
    const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 };
    const labelStyle = { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', minWidth: 54 };
    const sectionStyle = { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.25))' };
    const monoStyle = { fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' };

    function dot(color, title) {
      return react.createElement('span', {
        key: 'dot', title: title,
        style: { display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: color, flex: '0 0 auto' },
      });
    }
    function line(key, label, children) {
      return react.createElement('div', { key: key, style: rowStyle }, [
        react.createElement('span', { key: 'l', style: labelStyle }, label),
        react.createElement('span', { key: 'v', style: { flex: 1, minWidth: 0 } }, children),
      ]);
    }

    function statusOf(state) {
      if (state === null) return { text: '检测中', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' };
      if (state.ok !== true) return { text: '失败', color: 'var(--dsw-alias-state-error-primary, #d92d20)' };
      if (!state.bridge || state.bridge.up !== true) return { text: '桥掉线', color: 'var(--dsw-alias-state-error-primary, #d92d20)' };
      if (state.tunnel && state.tunnel.configured === true && state.tunnel.up !== true) return { text: '隧道断', color: '#f59e0b' };
      if (state.tunnel && state.tunnel.selfSigned === true) return { text: '正常·自签', color: 'var(--dsw-static-deepseek-500, #4d6bfe)' };
      return { text: '正常', color: 'var(--dsw-static-deepseek-500, #4d6bfe)' };
    }

    function copy(text) {
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text); } catch (e) { /* 无剪贴板权限就算了 */ }
    }

    function Panel(props) {
      const s = props.state;
      const blocks = [];
      if (s === null) {
        blocks.push(react.createElement('div', { key: 'wait' }, '正在检测…'));
        return react.createElement('div', { style: cardStyle }, blocks);
      }
      if (s.ok !== true) {
        blocks.push(react.createElement('div', { key: 'err', style: { color: 'var(--dsw-alias-state-error-primary, #d92d20)' } }, '插件宿主不可用：' + (s.reason || 'unknown')));
        return react.createElement('div', { style: cardStyle }, blocks);
      }
      const b = s.bridge || {};
      blocks.push(react.createElement('div', { key: 'h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } }, [
        react.createElement('strong', { key: 't', style: { fontSize: 13 } }, '网络与隧道'),
        react.createElement('span', { key: 'a' }, [
          /* 掉线自动拉起：默认开。关掉之后掉线只提示，靠「启动桥 / 启动前置」手动拉。 */
          react.createElement('button', {
            key: 's',
            onClick: () => props.setAutoStart(!(s.autoStart !== false)),
            title: s.autoStart !== false
              ? '开着：桥或隧道前置掉线时宿主会自动把它们拉起来（每项 60 秒最多一次）。点一下关掉。'
              : '关着：掉线只报告、不自动拉起；需要时点「启动桥 / 启动前置」。点一下打开。',
            style: Object.assign({}, chipStyle, { padding: '2px 8px', color: s.autoStart !== false ? '#34d399' : '#9ca3af' }),
          }, '自动拉起 ' + (s.autoStart !== false ? '开' : '关')),
          react.createElement('button', { key: 'r', onClick: props.reload, style: Object.assign({}, chipStyle, { padding: '2px 8px', marginLeft: 6 }) }, '重新检测'),
          react.createElement('button', { key: 'c', onClick: props.close, style: Object.assign({}, chipStyle, { padding: '2px 8px', marginLeft: 6 }) }, '关闭'),
        ]),
      ]));

      // bridge
      blocks.push(react.createElement('div', { key: 'b', style: sectionStyle }, [
        react.createElement('div', { key: 't', style: { fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          dot(b.up === true ? '#22c55e' : 'var(--dsw-alias-state-error-primary, #d92d20)', b.error || ''),
          react.createElement('span', { key: 'x', style: { marginLeft: 6 } }, '接入桥 127.0.0.1:8099'),
          /* 桥掉线时（比如刚重启完电脑）在这里一键把它拉起来。
             桥活着就不显示——这个动作只能"启动"，不能"重启"（再起一个只会撞端口）。 */
          b.up === true ? null : react.createElement('button', {
            key: 'start',
            disabled: props.busy === 'bridge',
            onClick: () => props.startService('bridge'),
            title: '在这台电脑上把桥跑起来（node bridge.cjs）',
            style: Object.assign({}, chipStyle, { padding: '2px 8px', marginLeft: 'auto' }),
          }, props.busy === 'bridge' ? '启动中…' : '启动桥'),
        ]),
        b.up === true
          ? line('l1', '响应', b.ms + ' ms · 上游 ' + (b.upstream === null ? '—' : b.upstream) + (b.note ? ' · ' + b.note : ''))
          : line('l2', '错误', b.error || 'unreachable'),
        b.up === true
          ? line('l3', '注入', '面板 ' + (b.panel ? '✓' : '✗') + ' · 适配 ' + (b.tweaks ? '✓' : '✗') + ' · 启动清单 ' + (b.boot ? '✓' : '✗'))
          : null,
      ]));

      // lan
      const lan = Array.isArray(s.lan) ? s.lan : [];
      blocks.push(react.createElement('div', { key: 'n', style: sectionStyle }, [
        react.createElement('div', { key: 't', style: { fontWeight: 600 } }, '内网入口（手机同一 Wi-Fi）'),
        lan.length === 0
          ? line('e', '—', '桥未运行或没有可用网卡')
          : lan.map((h, i) => line('h' + i, h.name || ('网卡' + (i + 1)), react.createElement('span', {
            style: Object.assign({}, monoStyle, { cursor: 'pointer' }),
            title: '点击复制',
            onClick: () => copy(h.url),
          }, h.url))),
      ]));

      // tunnel
      const t = s.tunnel || {};
      const cert = s.cert || {};
      blocks.push(react.createElement('div', { key: 't2', style: sectionStyle }, [
        react.createElement('div', { key: 't', style: { fontWeight: 600 } }, [
          dot(t.configured === true ? (t.up === true ? '#22c55e' : '#f59e0b') : 'var(--dsw-alias-label-tertiary, #8a8a8a)', t.error || ''),
          react.createElement('span', { key: 'x', style: { marginLeft: 6 } }, '外网隧道'),
          t.configured === true && t.up !== true ? react.createElement('button', {
            key: 'start',
            disabled: props.busy === 'front',
            onClick: () => props.startService('front'),
            title: '在这台电脑上把 HTTPS 前置跑起来（隧道指向的 127.0.0.1:8443）',
            style: Object.assign({}, chipStyle, { padding: '2px 8px', marginLeft: 'auto' }),
          }, props.busy === 'front' ? '启动中…' : '启动前置') : null,
        ]),
        t.configured !== true
          ? line('e', '—', '未配置外网地址（设置 → 手机端 → 外网访问）')
          : react.createElement('div', { key: 'c' }, [
            line('u', '地址', react.createElement('span', { style: monoStyle }, t.host + (t.port && t.port !== 443 ? ':' + t.port : ''))),
            line('r', '可达', t.up === true
              ? ('是 · ' + t.ms + ' ms（HTTP ' + t.status + '）' + (t.selfSigned === true ? ' · 自签证书' : ''))
              : ('否 · ' + (t.error || 'unreachable'))),
            t.selfSigned === true
              ? line('f', '指纹', react.createElement('span', { style: monoStyle }, t.fingerprint || '（未取到）'))
              : null,
            t.fingerprintChanged === true
              ? line('w', '⚠ 变更', '指纹和上次不同 —— 换过证书？如果不是你换的就要警惕')
              : null,
            cert.found === true
              ? line('k', '证书', '自签 · 剩余 ' + cert.daysLeft + ' 天（' + String(cert.expiresAt).slice(0, 10) + ' 到期）')
              : line('k2', '证书', t.up === true ? '受信任（系统证书链）' : '—'),
          ]),
      ]));

      // devices
      const d = s.devices || {};
      blocks.push(react.createElement('div', { key: 'd', style: sectionStyle }, [
        react.createElement('div', { key: 't', style: { fontWeight: 600 } }, '设备'),
        line('s', '统计', '已认证 ' + (d.approved || 0) + '（完全信任 ' + (d.trusted || 0) + '）· 待审批 ' + (d.pending || 0)),
        (Array.isArray(d.list) ? d.list : []).map((x, i) => line('d' + i, x.online ? '在线' : '离线',
          (x.name || '') + (x.trusted ? '（完全信任）' : '') + (x.platform ? ' · ' + x.platform : ''))),
      ]));

      if (props.note) {
        blocks.push(react.createElement('div', { key: 'note', style: { marginTop: 8, color: 'var(--dsw-static-deepseek-500, #4d6bfe)' } }, props.note));
      }
      /* 宿主自己动手拉起过的，照实说出来 */
      const healed = Array.isArray(s.autoStart) ? s.autoStart : [];
      for (let i = 0; i < healed.length; i++) {
        const h = healed[i];
        blocks.push(react.createElement('div', {
          key: 'heal' + i,
          style: { marginTop: 6, color: h.ok ? '#22c55e' : 'var(--dsw-alias-state-error-primary, #d92d20)' },
        }, h.ok
          ? ('已自动拉起 ' + h.label + (h.waitedMs ? '（' + h.waitedMs + ' ms）' : ''))
          : ('自动拉起 ' + h.label + ' 失败：' + (h.error || 'unknown'))));
      }
      blocks.push(react.createElement('div', { key: 'f', style: { marginTop: 10, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' } },
        '检测于 ' + new Date(s.at).toLocaleTimeString() + ' · 用时 ' + s.tookMs + ' ms'));
      return react.createElement('div', { style: cardStyle }, blocks);
    }

    function NetMonChip(props) {
      const [state, setState] = react.useState(null);
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState('');
      const [note, setNote] = react.useState('');
      const reload = react.useCallback(() => {
        rpc('status', {}).then((r) => setState(r && typeof r === 'object' ? r : { ok: false, reason: 'bad response' }));
      }, []);
      const setAutoStart = react.useCallback((value) => {
        rpc('set-autostart', { value: value }).then((r) => {
          setNote('自动拉起已' + ((r && r.autoStart === true) ? '打开' : '关闭'));
          reload();
        }).catch((error) => setNote('开关写入失败：' + (error && error.message ? error.message : String(error))));
      }, [reload]);
      /* 拉起服务：宿主会等它真的应答再回话，这里把结果原样显示出来（成功/已运行/失败原因） */
      const startService = react.useCallback((which) => {
        const label = which === 'front' ? '隧道前置' : '接入桥';
        setBusy(which);
        setNote(label + ' 启动中…');
        rpc(which === 'front' ? 'start-front' : 'start-bridge', {}).then((r) => {
          setBusy('');
          if (r && r.ok === true) {
            setNote(label + (r.already === true ? ' 本来就在运行' : ' 已启动') + (r.waitedMs ? '（' + r.waitedMs + ' ms）' : ''));
          } else {
            setNote(label + ' 启动失败：' + ((r && (r.error || r.reason)) || 'unknown'));
          }
          reload();
        }).catch((error) => {
          setBusy('');
          setNote(label + ' 启动失败：' + (error && error.message ? error.message : String(error)));
        });
      }, [reload]);
      react.useEffect(() => {
        reload();
        const timer = setInterval(reload, 60000);
        return () => clearInterval(timer);
      }, [reload]);
      react.useEffect(() => {
        if (!open) return undefined;
        const timer = setInterval(reload, 15000);
        return () => clearInterval(timer);
      }, [open, reload]);
      const status = statusOf(state);
      const detail = state && state.ok === true && state.bridge
        ? ('桥 ' + (state.bridge.up ? state.bridge.ms + 'ms' : '掉线')
          + (state.tunnel && state.tunnel.configured ? (' · 隧道 ' + (state.tunnel.up ? state.tunnel.ms + 'ms' + (state.tunnel.selfSigned ? '（自签）' : '') : '断')) : ''))
        : '点击查看网络与隧道状态';
      return react.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' } }, [
        react.createElement('button', {
          key: 'chip',
          onClick: () => setOpen(!open),
          title: '网络 / 隧道监视器：' + detail,
          style: chipStyle,
        }, [dot(status.color, detail), react.createElement('span', { key: 't' }, '网络 ' + status.text)]),
        open ? react.createElement(Panel, {
          key: 'panel', state: state, reload: reload, close: () => setOpen(false),
          startService: startService, setAutoStart: setAutoStart, busy: busy, note: note,
        }) : null,
      ]);
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'netmon-chip', order: 12 },
        (props) => NetMonChip(props),
      ));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
