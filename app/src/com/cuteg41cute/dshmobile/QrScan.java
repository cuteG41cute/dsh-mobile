package com.cuteg41cute.dshmobile;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.net.Uri;
import android.provider.MediaStore;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * 扫码连接：调系统相机拍一张（或从相册选一张）→ 用 ZXing 解出二维码内容。
 *
 * 为什么是「拍照 + 解码」而不是自己做相机预览：本应用刻意零 AndroidX、纯 SDK 手写构建，
 * 内置预览要写 Camera2 + 帧回调 + 连续解码，代码量和出错面都大得多，而且我没法在真机上试；
 * 交给系统相机 App 拍原图再解，可对焦可补光，成功率反而更高，代码只有一个解码函数。
 * 拍照走 MediaStore 输出（不需要 FileProvider，API 29+ 也不需要存储权限）。
 */
final class QrScan {

    static final int REQUEST_CAMERA = 4301;
    static final int REQUEST_GALLERY = 4302;
    /** 解码前把长边缩到这个像素数以内：够 ZXing 认，又不会因为 1200 万像素而卡住主线程。 */
    private static final int MAX_DECODE_EDGE = 2000;

    private static Uri lastCaptureUri;

    private QrScan() { }

    /** 相机 Intent；原图写到 MediaStore（拿不到输出 Uri 时退回系统返回的缩略图）。 */
    static Intent cameraIntent(Activity activity) {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        lastCaptureUri = null;
        Uri output = createOutput(activity);
        if (output != null) {
            lastCaptureUri = output;
            intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
        }
        return intent;
    }

    static Uri lastCaptureUri() { return lastCaptureUri; }

    /** 相册选图（相机不可用、或二维码已经是张截图时的退路）。 */
    static Intent galleryIntent() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        return intent;
    }

    private static Uri createOutput(Activity activity) {
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, "dsh-scan-" + System.currentTimeMillis() + ".jpg");
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            return activity.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        } catch (Exception error) {
            return null;   // 老系统没有存储权限时走到这里 → 退回缩略图/相册
        }
    }

    /** 解出二维码文本；解不到返回 null（不抛异常，调用方给提示）。 */
    static String decode(ContentResolver resolver, Uri uri) {
        if (resolver == null || uri == null) return null;
        Bitmap bitmap = load(resolver, uri);
        if (bitmap == null) return null;
        String text = tryDecode(bitmap);
        // 手持拍照常常是横着拍的，四个方向都试一遍
        int[] angles = { 90, 180, 270 };
        for (int i = 0; text == null && i < angles.length; i++) {
            Bitmap rotated = rotate(bitmap, angles[i]);
            if (rotated == null) continue;
            text = tryDecode(rotated);
            if (rotated != bitmap) rotated.recycle();
        }
        bitmap.recycle();
        return text;
    }

    private static Bitmap load(ContentResolver resolver, Uri uri) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            InputStream probe = resolver.openInputStream(uri);
            if (probe == null) return null;
            BitmapFactory.decodeStream(probe, null, bounds);
            probe.close();
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sample > MAX_DECODE_EDGE) sample *= 2;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            InputStream stream = resolver.openInputStream(uri);
            if (stream == null) return null;
            Bitmap bitmap = BitmapFactory.decodeStream(stream, null, options);
            stream.close();
            return bitmap;
        } catch (Exception error) {
            return null;
        }
    }

    private static Bitmap rotate(Bitmap source, int degrees) {
        try {
            Matrix matrix = new Matrix();
            matrix.postRotate(degrees);
            return Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(), matrix, true);
        } catch (Exception error) {
            return null;
        }
    }

    private static String tryDecode(Bitmap bitmap) {
        if (bitmap == null) return null;
        try {
            int width = bitmap.getWidth();
            int height = bitmap.getHeight();
            int[] pixels = new int[width * height];
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
            BinaryBitmap binary = new BinaryBitmap(
                    new HybridBinarizer(new RGBLuminanceSource(width, height, pixels)));
            Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
            List<BarcodeFormat> formats = new ArrayList<BarcodeFormat>();
            formats.add(BarcodeFormat.QR_CODE);
            hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
            Result result = new MultiFormatReader().decode(binary, hints);
            return result == null ? null : result.getText();
        } catch (Throwable error) {
            return null;   // NotFoundException 等：没认出来而已
        }
    }
}
