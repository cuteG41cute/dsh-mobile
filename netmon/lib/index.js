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
//   * GET  https://<tunnel-host>/__ping      — real end-to-end tunnel probe
//   * the tunnel certificate file, if present (days left)
//
// Every probe is individually timeout-guarded and never throws: the panel is a
// diagnostic, a dead bridge must render as "down", not break the page.
import { Service } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ROUTE_PATH = '/dsh-netmon/api'
const BRIDGE = 'http://127.0.0.1:8099'
const CERT_DIR = 'C:\\ProgramData\\SakuraFrpService\\FrpcWorkingDirectory'
const CACHE_MS = 8000

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

function certInfo(host) {
  if (!host) return { found: false }
  try {
    const file = path.join(CERT_DIR, host + '.crt')
    if (!fs.existsSync(file)) return { found: false }
    const cert = new crypto.X509Certificate(fs.readFileSync(file))
    const expires = new Date(cert.validTo)
    return {
      found: true,
      expiresAt: expires.toISOString(),
      daysLeft: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 86400000)),
      issuer: cert.issuer ? String(cert.issuer).slice(0, 120) : undefined,
    }
  } catch (error) {
    return { found: false, error: error && error.message ? error.message : String(error) }
  }
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
      send(200, { ok: false, reason: 'unknown-method: ' + method })
    } catch (error) {
      send(200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  async collect() {
    const now = Date.now()
    if (this.cache !== undefined && now - this.cache.at < CACHE_MS) return this.cache.value
    const value = await this.probe()
    this.cache = { at: now, value }
    return value
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
    let host = ''
    try { host = wanUrl === '' ? '' : new URL(wanUrl).hostname } catch { host = '' }

    // 4) real end-to-end tunnel probe (any HTTP response proves the path is up)
    let tunnel = { configured: host !== '', host, url: wanUrl, up: false, status: 0, ms: null }
    if (host !== '') {
      const t1 = Date.now()
      const ping = await getJson('https://' + host + '/__ping', 4000)
      tunnel = {
        configured: true, host, url: wanUrl,
        up: ping.status > 0, status: ping.status, ms: Date.now() - t1,
        error: ping.status > 0 ? undefined : (ping.error || 'unreachable'),
      }
    }

    // 5) certificate days left (frp writes the ACME cert here; absent = skipped)
    const cert = certInfo(host)

    return {
      ok: true,
      at: Date.now(),
      tookMs: Date.now() - started,
      bridge, lan, devices, tunnel, cert,
    }
  }
}

export default NetMonService
