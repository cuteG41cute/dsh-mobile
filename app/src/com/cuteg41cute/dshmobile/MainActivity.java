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

/**
 * DSH 手机端 —— 把本机 DeepSeek Harness WebUI（经 dsh-mobile-bridge）包成一个安卓应用。
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
        webView.loadUrl(serverUrl);
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
        if (!saved.equals(serverUrl)) {
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
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressedAt < BACK_EXIT_INTERVAL_MS) {
            super.onBackPressed();
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
