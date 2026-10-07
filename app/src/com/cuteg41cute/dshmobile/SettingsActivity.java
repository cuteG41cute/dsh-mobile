package com.cuteg41cute.dshmobile;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/** 原生设置页：服务器地址（可扫码）、屏幕常亮、快捷操作、关于。 */
public class SettingsActivity extends Activity {

    private SharedPreferences prefs;
    private EditText editUrl;
    private Switch switchKeepOn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        editUrl = findViewById(R.id.edit_url);
        switchKeepOn = findViewById(R.id.switch_keep_on);
        TextView about = findViewById(R.id.text_about);

        String url = prefs.getString(MainActivity.KEY_URL, MainActivity.DEFAULT_URL);
        editUrl.setText(url);
        editUrl.setSelection(editUrl.getText().length());
        switchKeepOn.setChecked(prefs.getBoolean(MainActivity.KEY_KEEP_ON, false));

        String version = "";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        about.setText("DeepSeek Harness v" + version + "\n\n"
                + "把本机 DeepSeek Harness 的 WebUI 包装成手机应用；认证由电脑侧的 "
                + "dsh-mobile-bridge 完成，本应用不保存任何密码或密钥。\n\n"
                + "当前服务器：\n" + MainActivity.normalizeUrl(url) + "\n\n"
                + "悬浮球：点一下打开本页，长按刷新页面，可拖到任意位置并吸附左右边缘。");

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
        prefs.edit()
                .putString(MainActivity.KEY_URL, url)
                .putBoolean(MainActivity.KEY_KEEP_ON, switchKeepOn.isChecked())
                .apply();
        editUrl.setText(url);
    }

    private void pending(String action) {
        prefs.edit().putString(MainActivity.KEY_PENDING, action).apply();
        finish();
    }
}
