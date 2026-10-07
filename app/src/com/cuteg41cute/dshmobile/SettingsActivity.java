package com.cuteg41cute.dshmobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.View;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/** 原生设置页：服务器地址（可扫码）、屏幕常亮、快捷操作、关于。 */
public class SettingsActivity extends Activity {

    private SharedPreferences prefs;
    private EditText editUrl;
    private EditText editAlt;
    private Switch switchKeepOn;
    private TextView textAbout;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        editUrl = findViewById(R.id.edit_url);
        editAlt = findViewById(R.id.edit_url_alt);
        switchKeepOn = findViewById(R.id.switch_keep_on);
        textAbout = findViewById(R.id.text_about);

        String url = prefs.getString(MainActivity.KEY_URL, MainActivity.DEFAULT_URL);
        editUrl.setText(url);
        editUrl.setSelection(editUrl.getText().length());
        String alt = prefs.getString(MainActivity.KEY_URL_ALT, "");
        if (alt == null) alt = "";
        editAlt.setText(alt);
        switchKeepOn.setChecked(prefs.getBoolean(MainActivity.KEY_KEEP_ON, false));
        refreshAbout();

        // 扫码连接：扫电脑上「设置 → 手机端」里的二维码，自动填地址并重连
        findViewById(R.id.btn_scan).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    startActivityForResult(QrScan.cameraIntent(SettingsActivity.this), QrScan.REQUEST_CAMERA);
                } catch (Exception error) {
                    Toast.makeText(SettingsActivity.this, R.string.scan_no_camera, Toast.LENGTH_SHORT).show();
                }
            }
        });
        findViewById(R.id.btn_gallery).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    startActivityForResult(QrScan.galleryIntent(), QrScan.REQUEST_GALLERY);
                } catch (Exception error) {
                    Toast.makeText(SettingsActivity.this, R.string.scan_no_gallery, Toast.LENGTH_SHORT).show();
                }
            }
        });
        findViewById(R.id.btn_diag).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { runDiagnostics(); }
        });
        findViewById(R.id.btn_save).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { save(); finish(); }
        });
        findViewById(R.id.btn_cancel).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        findViewById(R.id.btn_reload).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { saveQuietly(); pending(MainActivity.ACTION_RELOAD); }
        });
        findViewById(R.id.btn_sidebar).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { saveQuietly(); pending(MainActivity.ACTION_SIDEBAR); }
        });
        findViewById(R.id.btn_browser).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                            Uri.parse(MainActivity.normalizeUrl(editUrl.getText().toString()))));
                } catch (Exception e) {
                    Toast.makeText(SettingsActivity.this, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK) return;
        if (requestCode != QrScan.REQUEST_CAMERA && requestCode != QrScan.REQUEST_GALLERY) return;
        Uri uri = requestCode == QrScan.REQUEST_CAMERA ? QrScan.lastCaptureUri() : null;
        if (uri == null && data != null) uri = data.getData();
        String text = QrScan.decode(getContentResolver(), uri);
        if (text == null) {
            Toast.makeText(this, R.string.scan_failed, Toast.LENGTH_LONG).show();
            return;
        }
        String url = addressFrom(text);
        if (url == null) {
            Toast.makeText(this, getString(R.string.scan_not_address, text), Toast.LENGTH_LONG).show();
            return;
        }
        editUrl.setText(url);
        editUrl.setSelection(editUrl.getText().length());
        saveQuietly();
        Toast.makeText(this, getString(R.string.scan_ok, url), Toast.LENGTH_LONG).show();
        finish();   // 返回主界面时 MainActivity.onResume 发现地址变了会自动重连
    }

    /**
     * 把二维码内容折成本应用的服务器地址：
     * 二维码里是桥的落地页（http://host:8099/__bridge），本应用要的是它的来源部分。
     */
    private static String addressFrom(String text) {
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            if (value.indexOf("://") > 0) return null;      // 别的协议不认
            value = "http://" + value;
        }
        try {
            java.net.URI uri = new java.net.URI(value);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return null;
            int port = uri.getPort();
            String scheme = uri.getScheme() == null ? "http" : uri.getScheme();
            String base = scheme + "://" + host + (port > 0 ? ":" + port : "");
            // 外网入口（frp 隧道）的二维码带一个接入口令 ?k=…：必须原样保留，
            // 桥用它在页面里种下 cookie 再跳转到干净地址；丢掉它就只能看到「需要口令」页。
            String key = queryValue(uri.getRawQuery(), "k");
            if (key != null && !key.isEmpty()) base = base + "/?k=" + key;
            return base;
        } catch (Exception error) {
            return null;
        }
    }

    /** 从 raw query 里取一个参数值（口令是十六进制串，不需要额外解码处理）。 */
    private static String queryValue(String rawQuery, String name) {
        if (rawQuery == null || rawQuery.isEmpty()) return null;
        for (String pair : rawQuery.split("&")) {
            int index = pair.indexOf('=');
            if (index <= 0) continue;
            if (!name.equals(pair.substring(0, index))) continue;
            try {
                return java.net.URLDecoder.decode(pair.substring(index + 1), "UTF-8");
            } catch (Exception error) {
                return pair.substring(index + 1);
            }
        }
        return null;
    }

    private void save() {
        saveQuietly();
        Toast.makeText(this, R.string.toast_saved, Toast.LENGTH_SHORT).show();
    }

    private void saveQuietly() {
        String url = MainActivity.normalizeUrl(editUrl.getText().toString());
        String alt = MainActivity.normalizeUrl(editAlt.getText().toString());
        if (alt.equals(url)) alt = "";      // 跟主地址一样就等于没填
        prefs.edit()
                .putString(MainActivity.KEY_URL, url)
                .putString(MainActivity.KEY_URL_ALT, alt)
                .putBoolean(MainActivity.KEY_KEEP_ON, switchKeepOn.isChecked())
                .apply();
        editUrl.setText(url);
        editAlt.setText(alt);
    }

    /** 「关于」里的服务器信息：两个地址 + 已记住的证书指纹（TOFU 的结果要看得见）。 */
    private void refreshAbout() {
        String version = "";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        String url = MainActivity.normalizeUrl(editUrl.getText().toString());
        String alt = MainActivity.normalizeUrl(editAlt.getText().toString());
        StringBuilder sb = new StringBuilder();
        sb.append("DeepSeek Harness v").append(version).append("\n\n")
          .append("把本机 DeepSeek Harness 的 WebUI 包装成手机应用；认证由电脑侧的 ")
          .append("dsh-mobile-bridge 完成，本应用不保存任何密码或密钥。\n\n")
          .append("主用地址：\n").append(url.isEmpty() ? "（未设置）" : url).append("\n\n");
        if (!alt.isEmpty()) sb.append("备用地址（主用连不上时自动切换）：\n").append(alt).append("\n\n");
        String pin = "";
        try { pin = prefs.getString(MainActivity.KEY_PIN_PREFIX + Uri.parse(url).getHost().toLowerCase(), ""); }
        catch (Exception ignored) { }
        sb.append("已信任的自签证书：\n").append(pin == null || pin.isEmpty() ? "（无）" : shortFingerprint(pin)).append("\n\n")
          .append("悬浮球：点一下打开本页，长按刷新页面，可拖到任意位置并吸附左右边缘。");
        textAbout.setText(sb.toString());
    }

    private static String shortFingerprint(String fingerprint) {
        if (fingerprint == null || fingerprint.length() <= 16) return fingerprint;
        return fingerprint.substring(0, 16) + "…（SHA-256 前 16 位）";
    }

    /** ③ 连接诊断：在主线程外逐层跑，结果丢进可滚动的等宽 TextView。 */
    private void runDiagnostics() {
        final String url = MainActivity.normalizeUrl(editUrl.getText().toString());
        final String alt = MainActivity.normalizeUrl(editAlt.getText().toString());
        if (url.isEmpty()) {
            Toast.makeText(this, "先填一个服务器地址", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "正在诊断…", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override public void run() {
                StringBuilder sb = new StringBuilder();
                sb.append("主用地址\n").append(NetTools.diagnose(url, pinsFor(url)));
                if (!alt.isEmpty()) sb.append("\n备用地址\n").append(NetTools.diagnose(alt, pinsFor(alt)));
                sb.append("\n说明：①②③④ 全绿才算完全通。② 就红 = 地址/端口不通（或被封）；")
                  .append("③ 报证书错 = 自签证书还没信任；④ 403 = 路通了，只是没带接入口令，正常。");
                final String report = sb.toString();
                runOnUiThread(new Runnable() {
                    @Override public void run() { showReport(report); }
                });
            }
        }).start();
    }

    private String[] pinsFor(String url) {
        try {
            String pin = prefs.getString(MainActivity.KEY_PIN_PREFIX + Uri.parse(url).getHost().toLowerCase(), "");
            return (pin == null || pin.isEmpty()) ? new String[0] : new String[]{ pin };
        } catch (Exception e) {
            return new String[0];
        }
    }

    private void showReport(String report) {
        TextView view = new TextView(this);
        view.setText(report);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        view.setTypeface(Typeface.MONOSPACE);
        view.setTextIsSelectable(true);
        int pad = (int) (getResources().getDisplayMetrics().density * 18);
        view.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(view);
        new AlertDialog.Builder(this)
                .setTitle("连接诊断")
                .setView(scroll)
                .setPositiveButton("好", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) { }
                })
                .show();
    }

    private void pending(String action) {
        prefs.edit().putString(MainActivity.KEY_PENDING, action).apply();
        finish();
    }
}
