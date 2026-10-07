package com.cuteg41cute.dshmobile;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 网络小工具：证书指纹、按指纹放行的 SSLContext、逐层连接诊断。
 *
 * 设计原则：**不做"信任所有证书"**。要么用系统信任链，要么只放行用户明确记住的那一个
 * 证书指纹（TOFU：第一次连上时把指纹显示给用户确认，之后只认它）。
 */
public final class NetTools {

    private NetTools() { }

    /** 证书的 SHA-256 指纹（大写十六进制，无分隔）。 */
    public static String fingerprint(X509Certificate cert) {
        if (cert == null) return "";
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(cert.getEncoded());
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) sb.append(String.format("%02X", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 指纹是否在信任列表里。 */
    public static boolean trusted(String fingerprint, String[] pins) {
        if (fingerprint == null || fingerprint.isEmpty() || pins == null) return false;
        for (String pin : pins) {
            if (pin != null && pin.equalsIgnoreCase(fingerprint)) return true;
        }
        return false;
    }

    /** 只信任白名单指纹的 SSLContext（其余一律拒绝）。 */
    public static SSLContext pinnedContext(final String[] pins) throws Exception {
        TrustManager tm = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                verify(chain);
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                verify(chain);
            }
            private void verify(X509Certificate[] chain) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("empty chain");
                String fp = fingerprint(chain[0]);
                if (!trusted(fp, pins)) throw new CertificateException("untrusted fingerprint " + fp);
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{ tm }, new SecureRandom());
        return ctx;
    }

    /** 捕获链上第一张证书、但不做校验——**仅用于诊断**（不发送任何私密数据）。 */
    private static SSLContext captureContext() throws Exception {
        TrustManager tm = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{ tm }, new SecureRandom());
        return ctx;
    }

    /**
     * 预检：timeoutMs 内能不能拿到 HTTP 响应（任何状态码都算通，403 也算——正好用来判断
     * "路通不通"）。有 pin 时用 pinnedContext，自签证书也能过。
     */
    public static boolean reachable(String url, String[] pins, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(false);
            if (conn instanceof HttpsURLConnection && pins != null && pins.length > 0) {
                ((HttpsURLConnection) conn).setSSLSocketFactory(pinnedContext(pins).getSocketFactory());
            }
            return conn.getResponseCode() > 0;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String ms(long from) {
        return (System.currentTimeMillis() - from) + " ms";
    }

    /** 逐层诊断：DNS → TCP → TLS（含证书信息）→ HTTP(/__ping)。返回可直接显示的多行文本。 */
    public static String diagnose(String rawUrl, String[] pins) {
        StringBuilder out = new StringBuilder();
        String url = rawUrl == null ? "" : rawUrl.trim();
        out.append("地址: ").append(url).append("\n");
        if (url.isEmpty()) return out.append("（空地址）").toString();

        String host = null;
        int port = -1;
        boolean https = false;
        String base = "";
        try {
            URL u = new URL(url);
            host = u.getHost();
            https = "https".equalsIgnoreCase(u.getProtocol());
            port = u.getPort() > 0 ? u.getPort() : (https ? 443 : 80);
            base = u.getProtocol() + "://" + u.getAuthority();
        } catch (Exception e) {
            return out.append("地址解析失败: ").append(e.getMessage()).toString();
        }

        // ① DNS
        long t0 = System.currentTimeMillis();
        try {
            InetAddress[] addrs = InetAddress.getAllByName(host);
            StringBuilder ips = new StringBuilder();
            for (int i = 0; i < addrs.length && i < 4; i++) {
                if (i > 0) ips.append(", ");
                ips.append(addrs[i].getHostAddress());
            }
            out.append("① DNS      ✓ ").append(ms(t0)).append("  → ").append(ips).append("\n");
        } catch (Exception e) {
            return out.append("① DNS      ✗ ").append(ms(t0)).append("  ").append(e.getMessage())
                    .append("\n（解析都失败，先查 DNS / 私人 DNS 设置）").toString();
        }

        // ② TCP
        t0 = System.currentTimeMillis();
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), 5000);
            socket.close();
            out.append("② TCP      ✓ ").append(ms(t0)).append("  ").append(host).append(":").append(port).append("\n");
        } catch (Exception e) {
            return out.append("② TCP      ✗ ").append(ms(t0)).append("  ").append(e.getMessage())
                    .append("\n（端口连不上：可能被封 IP/端口，或地址写错）").toString();
        }

        // ③ TLS
        if (https) {
            t0 = System.currentTimeMillis();
            try {
                SSLSocketFactory factory = captureContext().getSocketFactory();
                SSLSocket tls = (SSLSocket) factory.createSocket();
                tls.connect(new InetSocketAddress(host, port), 5000);
                tls.startHandshake();
                java.security.cert.Certificate[] chain = tls.getSession().getPeerCertificates();
                X509Certificate cert = (X509Certificate) chain[0];
                String fp = fingerprint(cert);
                tls.close();
                out.append("③ TLS      ✓ ").append(ms(t0)).append("\n");
                out.append("   主体    ").append(cert.getSubjectDN()).append("\n");
                out.append("   签发者  ").append(cert.getIssuerDN()).append("\n");
                out.append("   有效期  至 ").append(cert.getNotAfter()).append("\n");
                out.append("   指纹    ").append(fp).append("\n");
                out.append("   本机信任: ").append(trusted(fp, pins) ? "已记住（TOFU）" : "未记住（首次连接会弹确认）").append("\n");
            } catch (Exception e) {
                out.append("③ TLS      ✗ ").append(ms(t0)).append("  ").append(e.getMessage()).append("\n");
            }
        }

        // ④ HTTP：拿一个 /__ping，任何状态码都算"路通"
        t0 = System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + "/__ping").openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setUseCaches(false);
            if (conn instanceof HttpsURLConnection) {
                SSLContext ctx = (pins != null && pins.length > 0) ? pinnedContext(pins) : captureContext();
                ((HttpsURLConnection) conn).setSSLSocketFactory(ctx.getSocketFactory());
            }
            int code = conn.getResponseCode();
            out.append("④ HTTP     ✓ ").append(ms(t0)).append("  /__ping → ").append(code);
            out.append(code == 403 ? "（403 = 路通了，只是没带接入口令，正常）" : "").append("\n");
        } catch (Exception e) {
            out.append("④ HTTP     ✗ ").append(ms(t0)).append("  ").append(e.getMessage()).append("\n");
        } finally {
            if (conn != null) conn.disconnect();
        }
        return out.toString();
    }
}
