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
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import os from 'node:os'

export const ROUTE_PATH = '/dsh-netmon/api'
const BRIDGE = 'http://127.0.0.1:8099'
// Certificate locations, both overridable by environment variable so nobody has to edit
// code: an frp client drops its ACME cert into CERT_DIR, while a TCP tunnel terminated by
// our own local HTTPS front keeps its self-signed pair next to the bridge.
const CERT_DIR = process.env.DSH_NETMON_CERT_DIR || 'C:\\ProgramData\\SakuraFrpService\\FrpcWorkingDirectory'
const CACHE_MS = 8000
// A TCP tunnel terminates TLS at our own local front (share/dsh-mobile-bridge/certs).
const SELF_CERT = process.env.DSH_NETMON_SELF_CERT
  || path.join(os.homedir(), 'Documents', 'deeepseek harness', 'share', 'dsh-mobile-bridge', 'certs', 'cert.pem')
// Fingerprint seen last time on a self-signed tunnel; a change is worth flagging.
let knownFingerprint = ''

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
    const frpFile = path.join(CERT_DIR, host + '.crt')
    const file = fs.existsSync(frpFile) ? frpFile : (fs.existsSync(SELF_CERT) ? SELF_CERT : '')
    if (file === '') return { found: false }
    const cert = new crypto.X509Certificate(fs.readFileSync(file))
    const expires = new Date(cert.validTo)
    return {
      found: true,
      selfSigned: file === SELF_CERT,
      expiresAt: expires.toISOString(),
      daysLeft: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 86400000)),
      issuer: cert.issuer ? String(cert.issuer).slice(0, 120) : undefined,
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
