#!/usr/bin/env node
/**
 * acme-renew.cjs —— 给自定义域名申请 / 续期 Let's Encrypt 证书，并自动装进frp 服务商 frpc 工作目录
 *
 * 为什么用 HTTP-01 而不是 DNS-01：
 *   DNS-01 需要把域名服务商的 API 密钥交给脚本；HTTP-01 只需要 80 端口能访问到本桥
 *   （frp 服务商隧道的「创建 HTTP 重定向」开关会把 http:// 转到 https://，LE 会跟随这个跳转），
 *   于是**不需要任何密钥**就能全自动续期。
 *
 * 流程：ACME v2（newAccount → newOrder → http-01 → finalize → 下载证书链）
 *       → 写入 frpc 工作目录 <域名>.crt/.key（旧文件先备份）→ 重启 frp 服务商 服务。
 *
 * 用法：
 *   node acme-renew.cjs             # 剩余有效期 <30 天才续（计划任务用这个）
 *   node acme-renew.cjs --force     # 强制重新签发
 *   ACME_STAGING=1 node acme-renew.cjs   # 用 LE 测试环境（不占用正式配额）
 *
 * 环境变量：ACME_DOMAIN / ACME_STATE / ACME_WEBROOT / FRPC_DIR / FRPC_SERVICE /
 *           ACME_RENEW_DAYS / OPENSSL_BIN / ACME_STAGING
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const DOMAIN = process.env.ACME_DOMAIN || "";
if (!DOMAIN) {
  console.error("[acme] 需要设置 ACME_DOMAIN（你的隧道绑定域名），例如：ACME_DOMAIN=dsh.example.com node tools/acme-renew.cjs");
  process.exit(2);
}
const STAGING = process.env.ACME_STAGING === "1";
const DIRECTORY_URL = STAGING
  ? "https://acme-staging-v02.api.letsencrypt.org/directory"
  : "https://acme-v02.api.letsencrypt.org/directory";
const BASE = path.join(__dirname, "..");
const STATE = process.env.ACME_STATE || path.join(BASE, "acme-state");
const WEBROOT = process.env.ACME_WEBROOT || path.join(BASE, "acme");
const FRPC_DIR = process.env.FRPC_DIR || "C:\\ProgramData\\FrpcService\\FrpcWorkingDirectory";
const SERVICE = process.env.FRPC_SERVICE || "FrpcService";
const RENEW_DAYS = Number(process.env.ACME_RENEW_DAYS || 30);
const FORCE = process.argv.includes("--force");
const OPENSSL = process.env.OPENSSL_BIN || "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
const LOG_FILE = path.join(BASE, "acme-renew.log");

function log(message) {
  const line = "[" + new Date().toISOString() + "] " + message;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (error) { /* 日志写不了不影响 */ }
}
function b64u(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

/* ------------------------------- 账号密钥 ------------------------------- */
function loadOrCreateAccount() {
  ensureDir(STATE);
  const file = path.join(STATE, "account.json");
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return { key: crypto.createPrivateKey(saved.privateKeyPem), jwk: saved.jwk, kid: saved.kid || "" };
  }
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const saved = {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y },
    kid: ""
  };
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  log("已生成 ACME 账号密钥（" + file + "）");
  return { key: pair.privateKey, jwk: saved.jwk, kid: "" };
}
const ACCOUNT = loadOrCreateAccount();
const THUMBPRINT = b64u(crypto.createHash("sha256").update(JSON.stringify(ACCOUNT.jwk)).digest());

/* ------------------------------- HTTP/JWS ------------------------------- */
let nonceCache = "";
async function httpGet(url, asJson) {
  const res = await fetch(url, { headers: { "user-agent": "dsh-acme-renew" } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text: text, json: asJson ? JSON.parse(text) : null };
}
function takeNonce(headers) {
  const value = headers.get("replay-nonce");
  if (value) nonceCache = value;
  return value;
}
async function newNonce() {
  if (nonceCache) { const cached = nonceCache; nonceCache = ""; return cached; }
  const res = await fetch(DIRECTORY.newNonce, { method: "HEAD" });
  return res.headers.get("replay-nonce") || "";
}
function signJws(payload, url, nonce, useJwk) {
  const header = { alg: "ES256", nonce: nonce, url: url };
  if (useJwk) header.jwk = ACCOUNT.jwk; else header.kid = ACCOUNT.kid;
  const protectedB64 = b64u(JSON.stringify(header));
  const payloadB64 = payload === "" ? "" : b64u(JSON.stringify(payload));
  const signature = crypto.sign("sha256", Buffer.from(protectedB64 + "." + payloadB64), { key: ACCOUNT.key, dsaEncoding: "ieee-p1363" });
  return JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64u(signature) });
}
async function acmePost(url, payload, useJwk) {
  const nonce = await newNonce();
  const body = signJws(payload, url, nonce, useJwk);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/jose+json", "user-agent": "dsh-acme-renew" },
    body: body
  });
  takeNonce(res.headers);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  return { status: res.status, headers: res.headers, json: json, text: text };
}
let DIRECTORY = null;

/* -------------------------------- 证书检查 ------------------------------- */
function installedCertDaysLeft() {
  const file = path.join(FRPC_DIR, DOMAIN + ".crt");
  if (!fs.existsSync(file) || !fs.existsSync(OPENSSL)) return -1;
  try {
    const enddate = execFileSync(OPENSSL, ["x509", "-in", file, "-noout", "-enddate"], { encoding: "utf8" }).trim();
    const iso = enddate.replace("notAfter=", "");
    const left = (new Date(iso).getTime() - Date.now()) / 86400000;
    return Math.round(left);
  } catch (error) { return -1; }
}

/* --------------------------------- 主流程 -------------------------------- */
(async () => {
  const left = installedCertDaysLeft();
  log("当前已安装证书剩余 " + left + " 天（阈值 " + RENEW_DAYS + " 天）");
  if (!FORCE && left >= RENEW_DAYS) { log("还早，跳过。"); return; }

  DIRECTORY = (await httpGet(DIRECTORY_URL, true)).json;
  log("ACME 目录就绪：" + (STAGING ? "测试环境" : "正式环境"));

  if (!ACCOUNT.kid) {
    const created = await acmePost(DIRECTORY.newAccount, { termsOfServiceAgreed: true }, true);
    if (!created.headers.get("location")) throw new Error("注册账号失败：" + created.status + " " + created.text.slice(0, 200));
    ACCOUNT.kid = created.headers.get("location");
    const file = path.join(STATE, "account.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.kid = ACCOUNT.kid;
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    log("账号已注册：" + ACCOUNT.kid);
  }

  const order = await acmePost(DIRECTORY.newOrder, { identifiers: [{ type: "dns", value: DOMAIN }] });
  if (order.status !== 201) throw new Error("下单失败：" + order.status + " " + order.text.slice(0, 300));
  const authzUrl = order.json.authorizations[0];
  const authz = await acmePost(authzUrl, "");
  const challenge = (authz.json.challenges || []).filter(function (c) { return c.type === "http-01"; })[0];
  if (!challenge) { log("这个域名只能做别的验证方式：" + JSON.stringify(authz.json.challenges)); throw new Error("没有 http-01 验证方式"); }

  // 把验证文件交给桥对外提供：http://<域名>/.well-known/acme-challenge/<token>
  ensureDir(WEBROOT);
  const tokenFile = path.join(WEBROOT, challenge.token);
  fs.writeFileSync(tokenFile, challenge.token + "." + THUMBPRINT + "\n");
  log("已写入验证文件 " + tokenFile + "，等待 LE 来取 …");
  try {
    const probe = await httpGet("http://" + DOMAIN + "/.well-known/acme-challenge/" + challenge.token, false);
    log("自测（公网 80 → 隧道）：HTTP " + probe.status + " 内容=" + JSON.stringify(probe.text.trim().slice(0, 60)));
    if (probe.status !== 200) log("⚠️ 自测没通过，LE 大概率也会失败——请确认隧道开了「创建 HTTP 重定向」并已重启");
  } catch (error) {
    log("⚠️ 自测请求出错：" + error.message);
  }

  const triggered = await acmePost(challenge.url, {});
  log("已通知 LE 开始验证：" + triggered.status);

  let state = authz.json.status;
  for (let i = 0; i < 30 && state === "pending"; i++) {
    await new Promise(function (r) { setTimeout(r, 3000); });
    const again = await acmePost(authzUrl, "");
    state = again.json.status;
    log("验证状态：" + state);
    if (state === "invalid") {
      const problem = (again.json.challenges || []).map(function (c) { return c.error ? c.error.detail : ""; }).join(" / ");
      throw new Error("验证失败：" + problem);
    }
  }
  if (state !== "valid") throw new Error("验证超时（最后状态 " + state + "）");

  // 生成证书私钥 + CSR
  const keyFile = path.join(STATE, DOMAIN + ".key");
  const csrFile = path.join(STATE, DOMAIN + ".csr.der");
  if (!fs.existsSync(keyFile)) {
    execFileSync(OPENSSL, ["ecparam", "-genkey", "-name", "prime256v1", "-out", keyFile], { stdio: "ignore" });
    log("已生成证书私钥 " + keyFile);
  }
  execFileSync(OPENSSL, [
    "req", "-new", "-key", keyFile, "-out", csrFile, "-outform", "DER",
    "-subj", "/CN=" + DOMAIN, "-addext", "subjectAltName=DNS:" + DOMAIN
  ], { stdio: "ignore" });
  const csrDer = fs.readFileSync(csrFile);

  const finalized = await acmePost(order.json.finalize, { csr: b64u(csrDer) });
  if (finalized.status >= 400) throw new Error("提交 CSR 失败：" + finalized.status + " " + finalized.text.slice(0, 300));
  let orderState = finalized.json.status;
  let certUrl = finalized.json.certificate;
  for (let i = 0; i < 20 && !certUrl; i++) {
    await new Promise(function (r) { setTimeout(r, 2000); });
    const check = await acmePost(order.json.finalize.replace("/finalize", ""), "");
    orderState = check.json.status;
    certUrl = check.json.certificate;
    log("签发状态：" + orderState);
  }
  if (!certUrl) throw new Error("没有拿到证书地址（状态 " + orderState + "）");
  const cert = await acmePost(certUrl, "");
  const chain = cert.text.trim();
  if (chain.indexOf("BEGIN CERTIFICATE") < 0) throw new Error("证书内容异常：" + cert.text.slice(0, 200));

  // 装进 frpc 工作目录（旧文件先备份）
  ensureDir(FRPC_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetCrt = path.join(FRPC_DIR, DOMAIN + ".crt");
  const targetKey = path.join(FRPC_DIR, DOMAIN + ".key");
  if (fs.existsSync(targetCrt)) fs.copyFileSync(targetCrt, targetCrt + ".bak-" + stamp);
  if (fs.existsSync(targetKey)) fs.copyFileSync(targetKey, targetKey + ".bak-" + stamp);
  fs.writeFileSync(targetCrt, chain + "\n");
  fs.writeFileSync(targetKey, fs.readFileSync(keyFile));
  log("已写入 " + targetCrt + " / " + targetKey + "（旧的备份为 .bak-" + stamp + "）");
  try { fs.unlinkSync(tokenFile); } catch (error) { /* 清理验证文件 */ }

  // 重启frp 服务商服务让 frpc 载入新证书
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", "Restart-Service -Name '" + SERVICE + "' -Force"], { stdio: "ignore" });
    log("已重启服务 " + SERVICE);
  } catch (error) {
    log("⚠️ 自动重启服务失败（可能需要管理员权限）：" + error.message);
    log("   请手动在frp 服务商启动器里把隧道停止再启动一次，或重启 frp 服务商 服务。");
  }
  log("完成。新证书剩余 " + installedCertDaysLeft() + " 天。");
})().catch(function (error) {
  log("失败：" + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
