package com.cuteg41cute.dshmobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;

/**
 * DeepSeek Harness（dsh-mobile-app）—— 把本机 DeepSeek Harness WebUI（经 dsh-mobile-bridge）包成一个安卓应用。
 *
 * v1.1.0 起：右上角常驻的两个半透明按钮去掉了，改成**可拖动、会自动变淡的悬浮球**：
 *   - 点一下 → 打开原生设置页（服务器地址、屏幕常亮、快捷操作、关于）
 *   - 长按   → 刷新页面
 *   - 拖动   → 吸附到左右边缘，位置记住
 */
public class MainActivity extends Activity {

    private static final String TAG = "DSHMobile";
    static final String PREFS = "dsh_mobile";
    static final String KEY_URL = "server_url";
    static final String KEY_URL_ALT = "server_url_alt";
    /* TOFU：自签证书的指纹，按 "ssl_pin_<host:port>" 存；只认记住的那一张 */
    static final String KEY_PIN_PREFIX = "ssl_pin_";
    static final String KEY_KEEP_ON = "keep_screen_on";
    static final String KEY_PENDING = "pending_action";
    static final String KEY_BALL_X = "ball_x";
    static final String KEY_BALL_Y = "ball_y";
    static final String KEY_HINT_SHOWN = "ball_hint_shown";
    static final String ACTION_RELOAD = "reload";
    static final String ACTION_SIDEBAR = "sidebar";
    /** 没有内置默认地址：首次启动会直接进设置页扫码/填写，避免把某台机器的内网地址硬编码进 App。 */
    static final String DEFAULT_URL = "";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final long BACK_EXIT_INTERVAL_MS = 2000L;
    private static final long LONG_PRESS_MS = 600L;
    private static final float BALL_IDLE_ALPHA = 0.45f;

    private WebView webView;
    private ProgressBar progressBar;
    private View errorPanel;
    private TextView errorText;
    private BallView ball;
    private long activeDownloadId = -1L;
    private final Handler ballHandler = new Handler(Looper.getMainLooper());
    private boolean ballPolling = false;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> pendingFileCallback;
    private long lastBackPressedAt = 0L;
    private String serverUrl = DEFAULT_URL;
    /* 备用地址：只在「主用地址预检不通」时启用，平时完全不参与，主路径行为不变 */
    private String serverAlt = "";
    /* 上一次生效的备用地址，用来判断设置里改过没有 */
    private String lastAlt = "";
    /* 上一次「配置里的主地址」。注意不能用 serverUrl 比：回退到备用后 serverUrl 会变，
       拿它比会导致每次回到前台都重载页面。 */
    private String lastPrimary = "";

    private float ballDownRawX, ballDownRawY;
    private float ballStartX, ballStartY;
    private long ballDownAt;
    private boolean ballMoved;

    /**
     * 窄屏（<1024px）时产品把侧栏折叠成 56px 轨道，项目/会话列表要点轨道顶部按钮才滑出。
     * 这里用一小段注入脚本帮用户点一次；菜单里也能手动切换。
     */
    private static final String JS_FIND_TOGGLE =
            "var b=null;"
            + "var bs=[].slice.call(document.querySelectorAll('button[aria-label]'));"
            + "for(var i=0;i<bs.length;i++){var l=bs[i].getAttribute('aria-label')||'';"
            + "if(/sidebar/i.test(l)||l.indexOf('\u4fa7\u8fb9\u680f')>=0||l.indexOf('\u5bfc\u822a')>=0){b=bs[i];break;}}"
            + "if(!b){var c=[].slice.call(document.querySelectorAll('button')).filter(function(x){"
            + "var r=x.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<64&&r.top<200&&r.width<=64;});"
            + "c.sort(function(x,y){return x.getBoundingClientRect().top-y.getBoundingClientRect().top;});"
            + "if(c.length){b=c[0];}}"
            + "if(!b)return 'none';"
            + "var n=b.parentElement,w=0;"
            + "while(n&&n!==document.body){w=n.getBoundingClientRect().width;if(w>40)break;n=n.parentElement;}";

    private static final String JS_TOGGLE_SIDEBAR =
            "(function(){try{" + JS_FIND_TOGGLE + "b.click();var l=b.getAttribute('aria-label')||'';return 'clicked:'+l;}catch(e){return 'err:'+e.message;}})()";

    private static final String JS_EXPAND_IF_NARROW =
            "(function(){try{if(window.innerWidth>=1024)return 'wide';" + JS_FIND_TOGGLE
            + "if(w>100)return 'already-expanded';b.click();return 'expanded:'+(b.getAttribute('aria-label')||'');"
            + "}catch(e){return 'err:'+e.message;}})()";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        errorPanel = findViewById(R.id.error_panel);
        errorText = findViewById(R.id.error_text);
        ball = findViewById(R.id.ball);

        findViewById(R.id.btn_retry).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { loadServer(); }
        });

        configureWebView();
        setupBall();

        serverUrl = normalizeUrl(prefs.getString(KEY_URL, DEFAULT_URL));
        serverAlt = normalizeUrl(prefs.getString(KEY_URL_ALT, ""));
        applyKeepScreenOn(prefs.getBoolean(KEY_KEEP_ON, false));

        if (!prefs.contains(KEY_URL)) {
            // 首次启动：直接进设置页填服务器地址
            startActivity(new Intent(this, SettingsActivity.class));
        } else if (!prefs.getBoolean(KEY_HINT_SHOWN, false)) {
            prefs.edit().putBoolean(KEY_HINT_SHOWN, true).apply();
            Toast.makeText(this, R.string.toast_ball_hint, Toast.LENGTH_LONG).show();
        }
        loadServer();
    }

    /**
     * 计算本机设备标识：ANDROID_ID 加固定前缀后做 SHA-256。
     * 加前缀是让它与别的应用算出的哈希不可互认（同一台设备、不同应用得到不同值）。
     */
    private String deviceIdentityHash() {
        try {
            String androidId = android.provider.Settings.Secure.getString(
                    getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(("dsh-mobile:" + (androidId == null ? "" : androidId)).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : bytes) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception error) {
            Log.w(TAG, "deviceIdentityHash 失败: " + error.getMessage());
            return "";
        }
    }

    /** 暴露给页面的只读设备标识：只有一个返回字符串的方法，没有别的能力。 */
    public static class DeviceIdentity {
        private final String hash;
        DeviceIdentity(String hash) { this.hash = hash; }
        @android.webkit.JavascriptInterface
        public String deviceId() { return hash; }
    }

    /* ------------------------------- WebView 配置 ------------------------------- */

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " DSHMobile/1.3");

        // 设备级身份：把 ANDROID_ID 的 SHA-256 交给页面（页面再拿它参与设备特征码）。
        // 为什么用 ANDROID_ID：无需任何权限、不弹任何窗，Android 8+ 按「应用签名+用户+设备」作用域，
        // 重装应用不变、恢复出厂才变；而 IMEI/MAC 从 Android 10/6 起普通应用就拿不到了。
        // 只暴露哈希：原始值不离开 App，页面与桥都看不到它。
        webView.addJavascriptInterface(new DeviceIdentity(deviceIdentityHash()), "__dshAppDevice");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setBackgroundColor(getResources().getColor(R.color.bg));
        webView.setWebContentsDebuggingEnabled(true);
        webView.setWebViewClient(new DshWebViewClient());
        webView.setWebChromeClient(new DshChromeClient());
        webView.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                                  String mimeType, long contentLength) {
                startDownload(url, contentDisposition, mimeType);
            }
        });
    }

    private void loadServer() {
        if (serverUrl == null || serverUrl.isEmpty()) {
            // 还没填地址：直接显示错误引导页（首次启动会同时打开设置页）
            progressBar.setVisibility(View.GONE);
            errorPanel.setVisibility(View.VISIBLE);
            return;
        }
        errorPanel.setVisibility(View.GONE);
        progressBar.setVisibility(View.VISIBLE);
        lastPrimary = serverUrl;
        lastAlt = serverAlt;
        /* 没有备用地址：完全按老路径走，零风险（不预检、不等待、不改变任何时序）。
           有备用地址：后台预检主用地址，不通就直接切备用，省掉用户手动改地址。 */
        if (serverAlt.isEmpty() || serverAlt.equals(serverUrl)) {
            webView.loadUrl(serverUrl);
            return;
        }
        final String primary = serverUrl;
        final String fallback = serverAlt;
        new Thread(new Runnable() {
            @Override public void run() {
                final boolean primaryOk = preflight(primary);
                final String picked = primaryOk ? primary : fallback;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (!primaryOk) {
                            Toast.makeText(MainActivity.this,
                                    "主用地址连不上，已切到备用地址", Toast.LENGTH_LONG).show();
                        }
                        serverUrl = picked;
                        webView.loadUrl(picked);
                    }
                });
            }
        }).start();
    }

    /* --------------------------- ① 自签证书信任 ---------------------------
     * 铁律：不做「信任所有证书」。首次连上把指纹摊给用户看（TOFU），确认后只认这一张；
     * 之后只有指纹对得上的证书才放行，中间人换一张立刻被拒。
     * -------------------------------------------------------------------- */

    /** 该主机已记住的证书指纹（0 或 1 个）。 */
    private String[] trustedPins(String host) {
        if (host == null || host.isEmpty()) return new String[0];
        String pin = prefs.getString(KEY_PIN_PREFIX + host.toLowerCase(), "");
        if (pin == null || pin.isEmpty()) return new String[0];
        return new String[]{ pin };
    }

    private boolean isTrusted(String host, X509Certificate cert) {
        return NetTools.trusted(NetTools.fingerprint(cert), trustedPins(host));
    }

    /** 让用户在「指纹」面前做决定。同意 → 记住 + 重新加载。 */
    private void askTrustCert(final String url, final String host, final String fingerprint) {
        String shown = fingerprint.isEmpty() ? "（取不到指纹）" : fingerprint.replaceAll("(.{4})(?=.)", "$1 ");
        new AlertDialog.Builder(this)
                .setTitle("这是自签证书")
                .setMessage("服务器：" + host + "\n\n"
                        + "证书指纹（SHA-256）：\n" + shown + "\n\n"
                        + "自签证书 = 这台服务器自己给自己签发的，系统证书链认不出它。如果这台服务器"
                        + "是你自己的（比如家里的电脑 + 隧道），指纹对得上就可以信任。\n\n"
                        + "只有确认过这个指纹的人才能继续——所以请对着服务器上同样显示的一串核对一下。")
                .setPositiveButton("信任并记住", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) {
                        prefs.edit().putString(KEY_PIN_PREFIX + (host == null ? "" : host.toLowerCase()),
                                fingerprint).apply();
                        Toast.makeText(MainActivity.this, "已记住，下次不再询问", Toast.LENGTH_SHORT).show();
                        webView.loadUrl(url);
                    }
                })
                .setNegativeButton("先不连", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) {
                        progressBar.setVisibility(View.GONE);
                        errorText.setText("已拒绝自签证书\n\n服务器：" + host
                                + "\n\n如果这是你自己的服务器，请重新加载页面，在弹窗里核对指纹后点「信任并记住」。\n\n"
                                + getString(R.string.error_hint));
                        errorPanel.setVisibility(View.VISIBLE);
                    }
                })
                .show();
    }

    /** 预检：4.5 秒内能不能拿到响应（任何状态码都算通）。有 pin 的自签站也算通。 */
    private boolean preflight(String url) {
        try {
            return NetTools.reachable(url, trustedPins(Uri.parse(url).getHost()), 4500);
        } catch (Exception e) {
            Log.w(TAG, "preflight failed: " + e);
            return false;
        }
    }

    /* ------------------------------- 悬浮球 ------------------------------- */

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void setupBall() {
        ball.post(new Runnable() {
            @Override public void run() {
                float x = prefs.getFloat(KEY_BALL_X, Float.NaN);
                float y = prefs.getFloat(KEY_BALL_Y, Float.NaN);
                if (Float.isNaN(x) || Float.isNaN(y)) {
                    moveBall(ball.getX(), ball.getY());
                } else {
                    moveBall(x, y);
                }
                scheduleBallFade();
            }
        });

        ball.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        ballDownRawX = event.getRawX();
                        ballDownRawY = event.getRawY();
                        ballStartX = ball.getX();
                        ballStartY = ball.getY();
                        ballDownAt = System.currentTimeMillis();
                        ballMoved = false;
                        ball.animate().cancel();
                        ball.setAlpha(1f);
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = event.getRawX() - ballDownRawX;
                        float dy = event.getRawY() - ballDownRawY;
                        if (!ballMoved && (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6))) ballMoved = true;
                        if (ballMoved) moveBall(ballStartX + dx, ballStartY + dy);
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL: {
                        long held = System.currentTimeMillis() - ballDownAt;
                        if (ballMoved) {
                            snapBallToEdge();
                            prefs.edit().putFloat(KEY_BALL_X, ball.getX()).putFloat(KEY_BALL_Y, ball.getY()).apply();
                            scheduleBallFade();
                        } else if (held >= LONG_PRESS_MS) {
                            Toast.makeText(MainActivity.this, R.string.settings_reload, Toast.LENGTH_SHORT).show();
                            loadServer();
                            scheduleBallFade();
                        } else {
                            scheduleBallFade();
                            startActivity(new Intent(MainActivity.this, SettingsActivity.class));
                        }
                        return true;
                    }
                    default:
                        return false;
                }
            }
        });
    }

    /* ---------------------- 悬浮球：实时往返延迟 ----------------------
     * 量的是「手机 → 本机服务」的往返时间，弱网 / 隧道抖动一眼可见。
     * 任何 HTTP 响应（200 / 403 / 404）都算有效往返，只有连不上才算失败。
     * ---------------------------------------------------------------- */
    private String pingUrl() {
        try {
            Uri base = Uri.parse(serverUrl);
            return new Uri.Builder().scheme(base.getScheme()).authority(base.getAuthority())
                    .path("/__ping").build().toString();
        } catch (Exception e) {
            return serverUrl;
        }
    }

    private int measureRtt(String target) {
        HttpURLConnection conn = null;
        try {
            long t0 = System.currentTimeMillis();
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setRequestMethod("GET");
            conn.setUseCaches(false);
            /* 自签证书的站：原生请求默认走系统信任链，会直接被拒 → 球一直显示 --。
               这里用已记住的指纹建一个只认它的 SSLContext，跟 WebView 侧的信任保持一致。 */
            if (conn instanceof HttpsURLConnection) {
                NetTools.applyPin(conn, trustedPins(Uri.parse(target).getHost()));
            }
            /* 这是原生请求，不共享 WebView 的 cookie jar：不带上就会在走隧道时
               过不了桥的接入口令闸门（每 5 秒被拦一次、日志刷屏），带上就跟页面同等待遇。
               与下载（startDownload）用的是同一招，那条路已在真机上验证过。 */
            String cookie = CookieManager.getInstance().getCookie(target);
            if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
            conn.getResponseCode();
            return (int) Math.max(1L, System.currentTimeMillis() - t0);
        } catch (Exception e) {
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void paintLatency(int ms) {
        if (ball == null) return;
        if (ms < 0) {
            ball.setLatency("--", Color.parseColor("#9CA3AF"));
            ball.setContentDescription(getString(R.string.ball_desc) + "：暂时测不到延迟");
            return;
        }
        ball.setLatency(ms >= 1000 ? String.format(java.util.Locale.US, "%.1fs", ms / 1000f) : String.valueOf(ms),
                Color.parseColor(ms < 150 ? "#34D399" : (ms < 400 ? "#FBBF24" : "#F87171")));
        ball.setContentDescription(getString(R.string.ball_desc) + "：往返延迟 " + ms + " 毫秒");
    }

    private final Runnable ballPoll = new Runnable() {
        @Override public void run() {
            if (!ballPolling) return;
            final String target = pingUrl();
            new Thread(new Runnable() {
                @Override public void run() {
                    final int ms = measureRtt(target);
                    ballHandler.post(new Runnable() { @Override public void run() { paintLatency(ms); } });
                }
            }).start();
            ballHandler.postDelayed(this, 5000L);
        }
    };

    private void moveBall(float x, float y) {
        View parent = (View) ball.getParent();
        if (parent == null) return;
        float maxX = Math.max(0, parent.getWidth() - ball.getWidth());
        float maxY = Math.max(0, parent.getHeight() - ball.getHeight());
        ball.setX(Math.max(0f, Math.min(maxX, x)));
        ball.setY(Math.max(0f, Math.min(maxY, y)));
    }

    private void snapBallToEdge() {
        View parent = (View) ball.getParent();
        if (parent == null) return;
        float center = ball.getX() + ball.getWidth() / 2f;
        float target = center < parent.getWidth() / 2f ? dp(8) : parent.getWidth() - ball.getWidth() - dp(8);
        moveBall(target, ball.getY());
    }

    private void scheduleBallFade() {
        ball.animate().cancel();
        ball.animate().alpha(BALL_IDLE_ALPHA).setStartDelay(2200).setDuration(700).start();
    }

    /* ------------------------------- 生命周期 ------------------------------- */

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        ballPolling = true;
        ballHandler.removeCallbacks(ballPoll);
        ballHandler.post(ballPoll);
        if (prefs == null) return;

        applyKeepScreenOn(prefs.getBoolean(KEY_KEEP_ON, false));

        String pending = prefs.getString(KEY_PENDING, "");
        if (pending != null && !pending.isEmpty()) {
            prefs.edit().putString(KEY_PENDING, "").apply();
            if (ACTION_RELOAD.equals(pending)) {
                loadServer();
            } else if (ACTION_SIDEBAR.equals(pending)) {
                toggleSidebar();
            }
        }
        String saved = normalizeUrl(prefs.getString(KEY_URL, DEFAULT_URL));
        String savedAlt = normalizeUrl(prefs.getString(KEY_URL_ALT, ""));
        serverAlt = savedAlt;
        if (!saved.equals(lastPrimary) || !savedAlt.equals(lastAlt)) {
            serverUrl = saved;
            loadServer();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
        ballPolling = false;
        ballHandler.removeCallbacks(ballPoll);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }

    private void applyKeepScreenOn(boolean on) {
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    /** 展开/收起项目与会话列表（窄屏下产品默认折叠成 56px 轨道）。 */
    private void toggleSidebar() {
        webView.evaluateJavascript(JS_TOGGLE_SIDEBAR, new ValueCallback<String>() {
            @Override public void onReceiveValue(String value) { Log.i(TAG, "toggleSidebar -> " + value); }
        });
    }

    static String normalizeUrl(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) return DEFAULT_URL;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    /* ------------------------------- 下载 ------------------------------- */

    private void startDownload(String url, String contentDisposition, String mimeType) {
        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            /* 自签证书的站：系统下载器不认我们的 pin，会直接失败 → 换成应用自己下（只认记住的指纹）。
               普通站点（含公网证书的隧道）依旧走系统下载器，这条分支根本不进。 */
            String[] pins = trustedPins(Uri.parse(url).getHost());
            if (url.startsWith("https://") && pins.length > 0) {
                downloadWithPin(url, fileName, mimeType, pins);
                return;
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.setMimeType(mimeType);
            request.setTitle(fileName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm != null) {
                long id = dm.enqueue(request);
                watchDownload(id);          /* 浮球边缘的细环显示这个下载的进度 */
                Toast.makeText(this, "开始下载：" + fileName, Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** 自签证书下的下载：走应用自己的线程 + pin，进度直接画到浮球外圈。 */
    private void downloadWithPin(String url, String fileName, String mimeType, String[] pins) {
        activeDownloadId = -1L;      /* 停掉系统下载器那套轮询，环交给这条下载 */
        Toast.makeText(this, "开始下载：" + fileName, Toast.LENGTH_SHORT).show();
        PinnedDownload.start(url, CookieManager.getInstance().getCookie(url), fileName, mimeType,
                pins, this, new PinnedDownload.Progress() {
            @Override public void onProgress(final int percent) {
                ballHandler.post(new Runnable() { @Override public void run() {
                    if (ball != null) ball.setRing(percent / 100f);
                } });
            }
            @Override public void onDone(final String where) {
                ballHandler.post(new Runnable() { @Override public void run() {
                    if (ball != null) ball.setRing(-1f);
                    Toast.makeText(MainActivity.this, "已下载：" + where, Toast.LENGTH_LONG).show();
                } });
            }
            @Override public void onError(final String message) {
                ballHandler.post(new Runnable() { @Override public void run() {
                    if (ball != null) ball.setRing(-1f);
                    Toast.makeText(MainActivity.this, "下载失败：" + message, Toast.LENGTH_LONG).show();
                } });
            }
        });
    }

    /* ---------------------- 浮球上的下载进度环 ----------------------
     * DownloadManager 没有回调，只能按 id 轮询；下载中每 400ms 刷新一次环，
     * 结束（成功/失败）就把环收掉，并把球的透明度拉回 1（免得淡到看不见进度）。
     * -------------------------------------------------------------- */
    private void watchDownload(final long id) {
        activeDownloadId = id;
        final DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        if (dm == null || ball == null) return;
        ball.setRing(0f);
        ballHandler.postDelayed(new Runnable() {
            @Override public void run() {
                if (activeDownloadId != id) return;      /* 已被新的下载接管 */
                long done = -1L, total = -1L;
                int status = DownloadManager.STATUS_FAILED;
                Cursor cursor = null;
                try {
                    cursor = dm.query(new DownloadManager.Query().setFilterById(id));
                    if (cursor != null && cursor.moveToFirst()) {
                        done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    }
                } catch (Exception ignored) {
                    /* 查询失败就当这次进度看不见，别影响球本身 */
                } finally {
                    if (cursor != null) cursor.close();
                }
                boolean running = status == DownloadManager.STATUS_RUNNING || status == DownloadManager.STATUS_PENDING || status == DownloadManager.STATUS_PAUSED;
                if (running) {
                    float progress = (total > 0 && done >= 0) ? Math.min(1f, (float) done / (float) total) : 0.02f;
                    ball.setRing(progress);
                    ball.setAlpha(1f);
                    ballHandler.postDelayed(this, 400L);
                    return;
                }
                if (status == DownloadManager.STATUS_SUCCESSFUL) ball.setRing(1f);
                ballHandler.postDelayed(new Runnable() {
                    @Override public void run() { ball.setRing(-1f); scheduleBallFade(); }
                }, 900L);
                activeDownloadId = -1L;
            }
        }, 400L);
    }

    /* ------------------------------- 附件上传 ------------------------------- */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        pendingFileCallback.onReceiveValue(result);
        pendingFileCallback = null;
    }

    /* ------------------------------- 返回键 ------------------------------- */

    @Override
    public void onBackPressed() {
        /* 先问页面：浮层（长按菜单 / 插件面板 / 左抽屉 / 右栏预览）开着就让页面自己收掉。
           这一步是同步之前先返回的——不能在没问清楚前就 goBack()，否则页面会被后退重载，
           用户正在看的位置就丢了（这正是之前的体验问题）。 */
        if (webView != null) {
            webView.evaluateJavascript("(window.__dshmBack && window.__dshmBack()) === true", new ValueCallback<String>() {
                @Override public void onReceiveValue(String value) {
                    if ("true".equals(value)) return;      /* 页面已消费掉这次返回 */
                    fallbackBack();
                }
            });
            return;
        }
        fallbackBack();
    }

    /** 页面不接管时：优先历史后退；否则按「再按一次退出」的老规矩。绝不 reload。 */
    private void fallbackBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressedAt < BACK_EXIT_INTERVAL_MS) {
            moveTaskToBack(true);          /* 退到后台，保留 WebView 状态（不重载） */
        } else {
            lastBackPressedAt = now;
            Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
        }
    }

    /* ------------------------------- 内部类 ------------------------------- */

    private class DshWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String host = uri.getHost();
            String serverHost = Uri.parse(serverUrl).getHost();
            if (host != null && serverHost != null && host.equalsIgnoreCase(serverHost)) {
                return false;   // 同一个服务器：应用内打开
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception e) {
                Log.w(TAG, "cannot open external url: " + uri);
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            progressBar.setVisibility(View.VISIBLE);
            errorPanel.setVisibility(View.GONE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
            if (url != null && url.startsWith(serverUrl)) {
                view.postDelayed(new Runnable() {
                    @Override public void run() {
                        webView.evaluateJavascript(JS_EXPAND_IF_NARROW, new ValueCallback<String>() {
                            @Override public void onReceiveValue(String value) {
                                Log.i(TAG, "autoExpandSidebar -> " + value);
                            }
                        });
                    }
                }, 700);
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            /* 默认行为 = 一律拒绝（最安全）。只在「指纹正好等于用户记住的那张」时放行；
               否则弹窗让用户核对指纹 —— 既不静默拒绝到用户一头雾水，也不静默信任。 */
            X509Certificate cert = null;
            try {
                if (error.getCertificate() != null) cert = error.getCertificate().getX509Certificate();
            } catch (Exception e) {
                Log.w(TAG, "cannot read cert: " + e);
            }
            String host = null;
            String url = error.getUrl() == null ? serverUrl : error.getUrl();
            try {
                host = Uri.parse(url).getHost();
            } catch (Exception e) {
                Log.w(TAG, "cannot parse url: " + url);
            }
            if (cert != null && isTrusted(host, cert)) {
                Log.i(TAG, "ssl: fingerprint matches the remembered one, proceed");
                handler.proceed();
                return;
            }
            handler.cancel();
            progressBar.setVisibility(View.GONE);
            String primary = error.getPrimaryError() == SslError.SSL_EXPIRED ? "证书已过期"
                    : (error.getPrimaryError() == SslError.SSL_IDMISMATCH ? "证书与域名不匹配" : "证书不被信任");
            askTrustCert(url, host, NetTools.fingerprint(cert));
            Log.w(TAG, "ssl error (" + primary + ") host=" + host);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                progressBar.setVisibility(View.GONE);
                CharSequence desc = error.getDescription();
                errorText.setText("连接不上服务器\n\n" + (desc == null ? "" : desc) + "\n\n"
                        + getString(R.string.error_hint) + "\n\n地址：" + serverUrl);
                errorPanel.setVisibility(View.VISIBLE);
            }
        }
    }

    private class DshChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = null;
            }
            pendingFileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            try {
                String[] accept = params.getAcceptTypes();
                if (accept != null && accept.length > 0 && accept[0] != null) {
                    String first = accept[0].split(",")[0].trim();
                    if (first.contains("/")) intent.setType(first);
                }
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
                return true;
            } catch (Exception e) {
                pendingFileCallback = null;
                Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                return false;
            }
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            request.grant(request.getResources());
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage msg) {
            Log.d(TAG, "console: " + msg.message() + " @" + msg.sourceId() + ":" + msg.lineNumber());
            return true;
        }
    }
}
