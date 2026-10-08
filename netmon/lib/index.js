// dsh-netmon — Host half.
//
// Gathers everything the chip/panel shows and serves it on one exact
// webServer route (POST /dsh-netmon/api, { method, args }) that the client
// half calls with fetch. The page itself cannot reach the bridge (different
// origin / not routed), so all probing happens host-side.
//
// Sources:
//   * GET  http://127.0.0.1:8099/__selftest  — bridge alive + injection state + upstream
//   * GET  http://127.0.0.1:8099/__devices   — devices + LAN entry list
//   * POST http://127.0.0.1:8099/__wan       — tunnel URL (token/qr are NEVER returned)
//   * GET  https://<tunnel-host>[:port]/__ping — real end-to-end tunnel probe
//     (the port matters: a TCP tunnel lives on host:port. A self-signed tunnel
//      certificate is reported as "self-signed" + fingerprint, NOT as "down")
//   * the tunnel certificate file, if present (days left)
//
// Every probe is individually timeout-guarded and never throws: the panel is a
// diagnostic, a dead bridge must render as "down", not break the page.
import { Service } from '@deepseek-ai/cordis'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const ROUTE_PATH = '/dsh-netmon/api'
const BRIDGE = 'http://127.0.0.1:8099'
const CACHE_MS = 8000
// Everything below is learned from the live connection. Deliberately no local file paths and
// no assumption about which tunnel client is used or where it keeps its certificate -- how a
// deployment obtains and installs its certificate is its own business.
// Fingerprint seen last time on a self-signed tunnel; a change is worth flagging.
let knownFingerprint = ''
/* 「掉线自动拉起」的开关存这里（默认开）。一个小 JSON 文件，不引入新的框架 API。 */
const STATE_FILE = path.join(os.homedir(), '.dsh', 'netmon-state.json')
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {} } catch { return {} }
}
function autoStartEnabled() {
  return readState().autoStart !== false      /* 没写过 = 默认开 */
}
function writeState(next) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2))
    return true
  } catch { return false }
}

async function getJson(url, ms, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal }, init || {}))
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { reachable: true, status: res.status, json }
  } catch (error) {
    return { reachable: false, status: 0, error: error && error.message ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Certificate facts, derived only from what the handshake told us. */
function certFromHandshake(tunnel) {
  if (!tunnel || tunnel.selfSigned !== true || !tunnel.validTo) return { found: false }
  try {
    const expires = new Date(tunnel.validTo)
    if (isNaN(expires.getTime())) return { found: false }
    return {
      found: true,
      selfSigned: true,
      expiresAt: expires.toISOString(),
      daysLeft: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 86400000)),
    }
  } catch (error) {
    return { found: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * https GET that tolerates a self-signed certificate and reports what TLS saw.
 * Only the tunnel probe uses it and it sends no credentials. Rationale: a TCP tunnel is
 * terminated by our own local HTTPS front with a self-signed certificate, so a probe that
 * enforces the system trust store fails (DEPTH_ZERO_SELF_SIGNED_CERT) while the path is
 * perfectly alive. Anything answering HTTP proves the path is up.
 */
function probeInsecure(authority, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    const req = https.request({
      host: authority, port, path: '/__ping', method: 'GET', timeout: timeoutMs,
      rejectUnauthorized: false, headers: { host: authority + ':' + port },
    }, (res) => {
      let cert = null
      try { cert = res.socket.getPeerCertificate() } catch { }
      res.resume()
      res.on('end', () => finish({
        status: res.statusCode || 0,
        fingerprint: cert && cert.fingerprint256 ? cert.fingerprint256 : '',
        validTo: cert && cert.valid_to ? cert.valid_to : '',
        selfSigned: !!(cert && cert.issuer === cert.subject),
      }))
    })
    req.on('timeout', () => { req.destroy(); finish({ status: 0, error: 'timeout' }) })
    req.on('error', (error) => finish({ status: 0, error: error.code || error.message }))
    req.end()
  })
}

export class NetMonService extends Service {
  static inject = ['webServer']

  constructor(ctx) {
    super(ctx, 'netmon')
  }

  async [Service.init]() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => this.handleApi(req, res),
    }))
  }

  async handleApi(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') { send(405, { ok: false, reason: 'method-not-allowed' }); return }
    let raw = ''
    try { for await (const chunk of req) raw += chunk } catch { send(400, { ok: false, reason: 'read-failed' }); return }
    let request = null
    try { request = JSON.parse(raw) } catch { send(400, { ok: false, reason: 'bad-json' }); return }
    const method = request && typeof request.method === 'string' ? request.method : ''
    try {
      if (method === 'status') { send(200, await this.collect()); return }
      /* 面板里的「启动桥 / 启动前置」：宿主跑在电脑上，直接 node 起 node —— 这台机器上最
         可靠的拉起路径（WSH 的 Run/WMI 都踩过坑，见 start-*-hidden.vbs 里的注释）。 */
      if (method === 'start-bridge' || method === 'start-front') {
        send(200, await this.startService(method === 'start-front' ? 'front' : 'bridge'))
        return
      }
      /* 面板里的「自动拉起」开关：关掉之后掉线只提示、不自动拉，手动按钮照旧可用。 */
      if (method === 'set-autostart') {
        const want = !!(request && request.args && request.args.value === true)
        const saved = writeState(Object.assign(readState(), { autoStart: want }))
        this.cache = undefined
        send(200, { ok: saved, autoStart: autoStartEnabled() })
        return
      }
      send(200, { ok: false, reason: 'unknown-method: ' + method })
    } catch (error) {
      send(200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 桥所在目录：可用 DSH_NETMON_BRIDGE_DIR 覆盖，否则按常见位置找。 */
  bridgeDir() {
    const candidates = [
      process.env.DSH_NETMON_BRIDGE_DIR,
      path.join(os.homedir(), 'Documents', 'deeepseek harness', 'share', 'dsh-mobile-bridge'),
      path.join(process.cwd(), 'share', 'dsh-mobile-bridge'),
      path.join(process.cwd(), 'dsh-mobile-bridge'),
    ].filter((x) => typeof x === 'string' && x !== '')
    for (const dir of candidates) {
      try { if (fs.existsSync(path.join(dir, 'bridge.cjs'))) return dir } catch { /* 换下一个 */ }
    }
    return ''
  }

  async bridgeAlive() {
    const r = await getJson(BRIDGE + '/__selftest', 2000)
    return r.status > 0
  }

  async frontAlive() {
    const r = await probeInsecure('127.0.0.1', 8443, 2000)
    return r.status > 0
  }

  /**
   * 手动拉起一个服务，并等它真的应答（最多 20 秒）——**不静默**：返回里一定带
   * ok / already / waitedMs / error，面板原样显示给用户。
   */
  async startService(which) {
    const dir = this.bridgeDir()
    if (dir === '') return { ok: false, error: '找不到桥目录（可用 DSH_NETMON_BRIDGE_DIR 指定）' }
    const isFront = which === 'front'
    const script = isFront ? 'tls-front.cjs' : 'bridge.cjs'
    const file = path.join(dir, script)
    if (!fs.existsSync(file)) return { ok: false, error: '缺少 ' + script }
    const args = isFront ? ['--port', '8443', '--to', '8099', '--log', 'tls-front.log'] : ['--quiet']
    if (await (isFront ? this.frontAlive() : this.bridgeAlive())) return { ok: true, already: true, script }
    let pid = null
    try {
      const child = spawn(process.execPath, [file].concat(args), {
        cwd: dir, detached: true, stdio: 'ignore', windowsHide: true,
      })
      pid = child.pid
      child.unref()
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
    const started = Date.now()
    while (Date.now() - started < 20000) {
      await new Promise((r) => setTimeout(r, 700))
      if (await (isFront ? this.frontAlive() : this.bridgeAlive())) {
        this.cache = undefined
        return { ok: true, pid, waitedMs: Date.now() - started, script }
      }
    }
    this.cache = undefined
    return { ok: false, pid, error: '已启动但 20 秒内没有应答（看 bridge.log / tls-front.log）' }
  }

  async collect() {
    const now = Date.now()
    if (this.cache !== undefined && now - this.cache.at < CACHE_MS) return this.cache.value
    let value = await this.probe()
    value = await this.selfHeal(value)
    this.cache = { at: now, value }
    return value
  }

  /**
   * 掉线就自动拉起（每项 60 秒最多试一次）。
   *
   * 为什么放在这里而不是只靠 WSH 看门狗：这台机器上 WScript.Shell.Run 会**静默失败**
   * （退出码 0、无异常、进程没起来、服务日志一行都没有），重启电脑那次就是这么躺平的。
   * 而宿主就在 harness 进程里，用 node 起 node —— 实测 854 ms 就能应答，是这里最可靠的路。
   * 拉起来之后重新探一次，并把"自动拉起过"写进返回值，面板照实显示，不静默。
   */
  async selfHeal(state) {
    if (!autoStartEnabled()) return state          /* 用户关了自动拉起：只报告，不动手 */
    const now = Date.now()
    this.healAt = this.healAt || {}
    const targets = [
      { key: 'bridge', label: '接入桥', down: !(state.bridge && state.bridge.up === true) },
      {
        key: 'front', label: '隧道前置',
        down: !!(state.tunnel && state.tunnel.configured === true && state.tunnel.up !== true),
      },
    ]
    const healed = []
    for (const t of targets) {
      if (!t.down) continue
      if (this.healAt[t.key] !== undefined && now - this.healAt[t.key] < 60000) continue
      this.healAt[t.key] = now
      const r = await this.startService(t.key).catch((error) => ({ ok: false, error: String(error) }))
      healed.push({ label: t.label, ok: r.ok === true, already: r.already === true, waitedMs: r.waitedMs || 0, error: r.error || '' })
      if (r.ok === true) state = await this.probe()
    }
    if (healed.length > 0) state.autoStart = healed
    return state
  }

  async probe() {
    const started = Date.now()
    // 1) bridge selftest
    const t0 = Date.now()
    const selftest = await getJson(BRIDGE + '/__selftest', 2500)
    const bridgeMs = Date.now() - t0
    const sj = selftest.json !== null && typeof selftest.json === 'object' ? selftest.json : {}
    const bridge = selftest.reachable
      ? {
        up: true, ms: bridgeMs,
        panel: sj.panel === true, tweaks: sj.tweaks === true, boot: sj.boot === true,
        upstream: typeof sj.upstream === 'number' ? sj.upstream : null,
        note: typeof sj.note === 'string' ? sj.note : '',
      }
      : { up: false, ms: bridgeMs, error: selftest.error || 'unreachable' }

    // 2) devices + LAN entries
    const dev = await getJson(BRIDGE + '/__devices', 2500)
    const dj = dev.json !== null && typeof dev.json === 'object' ? dev.json : {}
    const items = Array.isArray(dj.devices) ? dj.devices : []
    const devices = {
      total: items.length,
      approved: items.filter((d) => d && d.state === 'approved').length,
      trusted: items.filter((d) => d && d.trusted === true).length,
      pending: typeof dj.pending === 'number' ? dj.pending : 0,
      list: items.slice(0, 8).map((d) => ({
        name: d && typeof d.name === 'string' ? d.name : '(未命名)',
        state: d && typeof d.state === 'string' ? d.state : '?',
        online: d && d.online === true,
        trusted: d && d.trusted === true,
        platform: d && typeof d.platform === 'string' ? d.platform : '',
      })),
    }
    const lan = (Array.isArray(dj.hosts) ? dj.hosts : [])
      .filter((h) => h && typeof h.url === 'string')
      .map((h) => ({ name: String(h.name || ''), address: String(h.address || ''), url: String(h.url) }))

    // 3) tunnel URL (token and qr payload are deliberately dropped)
    const wan = await getJson(BRIDGE + '/__wan', 2500, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const wj = wan.json !== null && typeof wan.json === 'object' ? wan.json : {}
    const wanUrl = typeof wj.url === 'string' && wj.url !== '' ? wj.url : ''
    // 3b) the port matters: a TCP tunnel is reached as host:port, and dropping it would
    // probe :443 on the node instead -- a different service that answers 501.
    let host = ''
    let port = 443
    try {
      if (wanUrl !== '') {
        const parsed = new URL(wanUrl)
        host = parsed.hostname
        port = parsed.port === '' ? (parsed.protocol === 'http:' ? 80 : 443) : Number(parsed.port)
      }
    } catch { host = '' }

    // 4) real end-to-end tunnel probe (any HTTP response proves the path is up)
    let tunnel = { configured: host !== '', host, port, url: wanUrl, up: false, status: 0, ms: null }
    if (host !== '') {
      const t1 = Date.now()
      const ping = await getJson('https://' + host + ':' + port + '/__ping', 4000)
      if (ping.status > 0) {
        tunnel = {
          configured: true, host, port, url: wanUrl,
          up: true, status: ping.status, ms: Date.now() - t1,
        }
      } else {
        // The system trust store refused it. That is expected for a self-signed tunnel --
        // retry without verification so a live tunnel is not reported as down.
        const retry = await probeInsecure(host, port, 4000)
        if (retry.status > 0) {
          const changed = knownFingerprint !== '' && retry.fingerprint !== '' && retry.fingerprint !== knownFingerprint
          if (retry.fingerprint !== '') knownFingerprint = retry.fingerprint
          tunnel = {
            configured: true, host, port, url: wanUrl,
            up: true, status: retry.status, ms: Date.now() - t1,
            selfSigned: true, fingerprint: retry.fingerprint, validTo: retry.validTo,
            fingerprintChanged: changed, trustError: ping.error || '',
          }
        } else {
          tunnel = {
            configured: true, host, port, url: wanUrl,
            up: false, status: 0, ms: Date.now() - t1,
            error: ping.error || retry.error || 'unreachable',
          }
        }
      }
    }

    // 5) certificate facts -- straight from the handshake we just did
    const cert = certFromHandshake(tunnel)

    return {
      ok: true,
      at: Date.now(),
      tookMs: Date.now() - started,
      autoStart: autoStartEnabled(),
      bridge, lan, devices, tunnel, cert,
    }
  }
}

export default NetMonService
