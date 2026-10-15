package com.cuteg41cute.dshmobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 自动扫码：相机预览 + 连续解码，认出二维码立刻回填并返回（不用按快门）。
 *
 * 与旧流程（调系统相机 App 拍一张、回来再用 ZXing 解）相比，用户只需把镜头对准二维码。
 * 兜底保留了旧流程：没相机权限 / 相机打不开 / 光线太差解不出来时，底部按钮仍可「用系统相机拍一张」。
 *
 * 用的是 framework 的 android.hardware.Camera（已废弃但仍在）：本项目不依赖 AndroidX，
 * 走不了 CameraX；而它的预览回调直接给 NV21，Y 平面本身就是灰度图，喂给 ZXing 刚刚好。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    static final String EXTRA_RESULT = "qr_text";
    private static final String TAG = "DSHMobile";
    /** 解码节流：预览帧很密，每 150ms 抓一帧就够了，再密只是白烧电。 */
    private static final long DECODE_INTERVAL_MS = 150L;
    private static final int REQ_PERMISSION = 4401;
    private static final int REQ_SYSTEM_CAMERA = 4402;

    private SurfaceView surface;
    private SurfaceHolder holder;
    private TextView hint;
    private Camera camera;
    private Camera.Size frameSize;
    private MultiFormatReader reader;
    private ExecutorService decoder;
    private byte[] work;          /* 复用一块缓冲：预览缓冲会被相机重填，必须拷出来再异步解 */
    private volatile boolean busy;
    private long lastDecode;
    private boolean finished;
    private boolean wantPreview;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicBoolean pending = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_scan);
        surface = findViewById(R.id.scan_surface);
        hint = findViewById(R.id.scan_hint);
        holder = surface.getHolder();
        holder.addCallback(this);

        Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader = new MultiFormatReader();
        reader.setHints(hints);
        decoder = Executors.newSingleThreadExecutor();

        findViewById(R.id.scan_fallback).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openSystemCamera(); }
        });
        findViewById(R.id.scan_cancel).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ Manifest.permission.CAMERA }, REQ_PERMISSION);
        } else {
            wantPreview = true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_PERMISSION) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        wantPreview = granted;
        if (granted) {
            startPreview();
        } else {
            setHint("没有相机权限 —— 可以点下面的按钮用系统相机拍一张，或直接手输地址");
        }
    }

    /* ------------------------------ 相机 ------------------------------ */

    private void setHint(final String text) {
        ui.post(new Runnable() { @Override public void run() { if (hint != null) hint.setText(text); } });
    }

    private void startPreview() {
        if (!wantPreview || camera != null) return;
        if (holder == null || holder.getSurface() == null) return;
        try {
            camera = Camera.open();                       /* 后置；没有就抛，下面兜底 */
        } catch (Exception e) {
            Log.w(TAG, "camera open failed: " + e);
            camera = null;
            setHint("打不开相机（可能被别的应用占用）—— 可以点下面的按钮用系统相机拍一张");
            return;
        }
        try {
            Camera.Parameters p = camera.getParameters();
            frameSize = pickPreviewSize(p);
            p.setPreviewSize(frameSize.width, frameSize.height);
            if (p.getSupportedFocusModes() != null
                    && p.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);   /* 扫二维码最怕对不上焦 */
            }
            camera.setParameters(p);
            camera.setDisplayOrientation(displayRotation());
            camera.setPreviewDisplay(holder);
            int bytes = frameSize.width * frameSize.height * 3 / 2;               /* NV21 */
            work = new byte[frameSize.width * frameSize.height];
            for (int i = 0; i < 3; i++) camera.addCallbackBuffer(new byte[bytes]);
            camera.setPreviewCallbackWithBuffer(this);
            camera.startPreview();
            setHint("把二维码放进画面里，自动识别");
        } catch (Exception e) {
            Log.w(TAG, "preview failed: " + e);
            releaseCamera();
            setHint("相机启动失败 —— 可以点下面的按钮用系统相机拍一张");
        }
    }

    /** 选一个不太大也不太小的预览尺寸：太大解码慢，太小认不出。 */
    private Camera.Size pickPreviewSize(Camera.Parameters p) {
        Camera.Size best = p.getPreviewSize();
        long bestScore = Long.MAX_VALUE;
        for (Camera.Size s : p.getSupportedPreviewSizes()) {
            long pixels = (long) s.width * s.height;
            if (pixels < 640L * 480L || pixels > 1920L * 1080L) continue;
            long score = Math.abs(pixels - 1280L * 720L);       /* 以 720p 为目标 */
            if (score < bestScore) { bestScore = score; best = s; }
        }
        return best;
    }

    private int displayRotation() {
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        android.hardware.Camera.CameraInfo info = new android.hardware.Camera.CameraInfo();
        android.hardware.Camera.getCameraInfo(0, info);
        int degrees = rotation == Surface.ROTATION_90 ? 90 : (rotation == Surface.ROTATION_180 ? 180
                : (rotation == Surface.ROTATION_270 ? 270 : 0));
        return info.facing == android.hardware.Camera.CameraInfo.CAMERA_FACING_FRONT
                ? (360 - ((info.orientation + degrees) % 360)) % 360
                : (info.orientation - degrees + 360) % 360;
    }

    private void releaseCamera() {
        if (camera == null) return;
        try {
            camera.setPreviewCallbackWithBuffer(null);
            camera.stopPreview();
        } catch (Exception ignored) { }
        try { camera.release(); } catch (Exception ignored) { }
        camera = null;
    }

    /* ------------------------------ 逐帧解码 ------------------------------ */

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (finished) return;
        final long now = System.currentTimeMillis();
        boolean due = now - lastDecode >= DECODE_INTERVAL_MS;
        if (!due || busy || data == null || frameSize == null) {
            if (data != null) cam.addCallbackBuffer(data);       /* 不还回去，回调就停了 */
            return;
        }
        lastDecode = now;
        busy = true;
        /* 预览缓冲会被相机立刻重填：只拷 Y 平面（灰度）到自己的缓冲里，再交给解码线程 */
        final int w = frameSize.width, h = frameSize.height;
        final byte[] frame = work;
        try {
            System.arraycopy(data, 0, frame, 0, w * h);
        } catch (Exception e) {
            busy = false;
            cam.addCallbackBuffer(data);
            return;
        }
        cam.addCallbackBuffer(data);
        decoder.execute(new Runnable() {
            @Override public void run() {
                String text = null;
                try {
                    PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(frame, w, h, 0, 0, w, h, false);
                    BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
                    Result result = reader.decodeWithState(bitmap);
                    if (result != null && result.getText() != null && !result.getText().isEmpty()) text = result.getText();
                } catch (Exception e) {
                    /* NotFoundException 是常态（这一帧里没二维码），安静跳过 */
                } finally {
                    reader.reset();
                    busy = false;
                }
                if (text != null) succeed(text);
            }
        });
    }

    private void succeed(final String text) {
        if (finished || !pending.compareAndSet(false, true)) return;
        finished = true;
        Log.i(TAG, "qr decoded: " + text.length() + " chars");
        ui.post(new Runnable() {
            @Override public void run() {
                Toast.makeText(ScanActivity.this, "已识别，正在连接", Toast.LENGTH_SHORT).show();
                setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, text));
                finish();
            }
        });
    }

    /* --------------------------- 兜底：系统相机 --------------------------- */

    private void openSystemCamera() {
        try {
            startActivityForResult(QrScan.cameraIntent(this), REQ_SYSTEM_CAMERA);
        } catch (Exception e) {
            Toast.makeText(this, R.string.scan_no_camera, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SYSTEM_CAMERA || resultCode != RESULT_OK) return;
        android.net.Uri uri = QrScan.lastCaptureUri();
        if (uri == null && data != null) uri = data.getData();
        String text = QrScan.decode(getContentResolver(), uri);
        if (text == null) {
            Toast.makeText(this, R.string.scan_failed, Toast.LENGTH_LONG).show();
            return;
        }
        succeed(text);
    }

    /* ------------------------------ 生命周期 ------------------------------ */

    @Override protected void onResume() { super.onResume(); startPreview(); }

    @Override protected void onPause() {
        releaseCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        releaseCamera();
        decoder.shutdownNow();
        super.onDestroy();
    }

    @Override public void surfaceCreated(SurfaceHolder h) { startPreview(); }

    @Override public void surfaceChanged(SurfaceHolder h, int format, int width, int height) {
        if (camera != null) {
            try {
                camera.stopPreview();
                camera.setPreviewDisplay(h);
                camera.startPreview();
            } catch (Exception e) { Log.w(TAG, "surfaceChanged: " + e); }
        } else {
            startPreview();
        }
    }

    @Override public void surfaceDestroyed(SurfaceHolder h) { releaseCamera(); }
}
