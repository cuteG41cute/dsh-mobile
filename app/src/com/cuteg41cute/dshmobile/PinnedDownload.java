package com.cuteg41cute.dshmobile;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 自签证书服务器的下载（系统 DownloadManager 用不了我们的 pin，只能自己下）。
 *
 * 只在「https + 该主机已经记住指纹」时才走这条路；其余情况一律还是系统下载器。
 * 存放位置：Android 10+ → 系统「下载」目录下的 DeepSeek Harness 文件夹（MediaStore，
 * 不需要任何存储权限）；Android 8/9 → 应用自己的外部下载目录（同样不需要权限）。
 */
public final class PinnedDownload {

    /** 回调都在后台线程，调用方自己 post 回主线程。 */
    public interface Progress {
        void onProgress(int percent);
        void onDone(String where);
        void onError(String message);
    }

    private PinnedDownload() { }

    public static void start(final String url, final String cookie, final String fileName,
                             final String mimeType, final String[] pins,
                             final Context ctx, final Progress cb) {
        new Thread(new Runnable() {
            @Override public void run() {
                HttpURLConnection conn = null;
                OutputStream out = null;
                Uri mediaUri = null;
                File file = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    NetTools.applyPin(conn, pins);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setUseCaches(false);
                    conn.setRequestMethod("GET");
                    if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) {
                        cb.onError("HTTP " + code);
                        return;
                    }
                    long total = conn.getContentLength();

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                        values.put(MediaStore.Downloads.MIME_TYPE,
                                mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
                        values.put(MediaStore.Downloads.RELATIVE_PATH,
                                Environment.DIRECTORY_DOWNLOADS + "/DeepSeek Harness");
                        ContentResolver resolver = ctx.getContentResolver();
                        mediaUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (mediaUri == null) { cb.onError("无法在下载目录里创建文件"); return; }
                        out = resolver.openOutputStream(mediaUri);
                    } else {
                        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                        if (dir == null) { cb.onError("取不到下载目录"); return; }
                        if (!dir.exists() && !dir.mkdirs()) { cb.onError("下载目录建不出来"); return; }
                        file = new File(dir, fileName);
                        out = new FileOutputStream(file);
                    }
                    if (out == null) { cb.onError("写不了文件"); return; }

                    InputStream in = conn.getInputStream();
                    byte[] buf = new byte[32768];
                    long done = 0L;
                    int lastPercent = -1;
                    int read;
                    while ((read = in.read(buf)) > 0) {
                        out.write(buf, 0, read);
                        done += read;
                        if (total > 0) {
                            int percent = (int) Math.min(100L, done * 100L / total);
                            if (percent != lastPercent) { lastPercent = percent; cb.onProgress(percent); }
                        }
                    }
                    in.close();
                    out.flush();
                    out.close();
                    out = null;
                    if (total > 0 && done < total) { throw new Exception("下载不完整（" + done + "/" + total + " 字节）"); }
                    if (done == 0L) { throw new Exception("收到 0 字节"); }
                    cb.onDone("下载/DeepSeek Harness/" + fileName);
                } catch (Exception e) {
                    try { if (out != null) out.close(); } catch (Exception ignored) { }
                    if (mediaUri != null) {
                        try { ctx.getContentResolver().delete(mediaUri, null, null); } catch (Exception ignored) { }
                    }
                    if (file != null) { try { file.delete(); } catch (Exception ignored) { } }
                    cb.onError(e.getMessage() == null ? e.toString() : e.getMessage());
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }
}
