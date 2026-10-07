package com.cuteg41cute.dshmobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

/**
 * 悬浮球：球体 + 延迟读数 + 边缘细环进度。
 *
 * 球原本是个 TextView（背景用 shape），加上「下载进度」就只能自绘了：
 * 环画在球的边缘，progress 为负表示不画（平时只显示延迟）。
 * 触摸（点击进设置、长按刷新、拖动吸附）仍然由 MainActivity 用
 * setOnTouchListener 管，这里只负责画。
 */
public class BallView extends View {
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint edgePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ringPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF ringRect = new RectF();

    private String label = "--";
    private float ringProgress = -1f;
    private float density = 1f;

    public BallView(Context context) { super(context); init(); }
    public BallView(Context context, AttributeSet attrs) { super(context, attrs); init(); }
    public BallView(Context context, AttributeSet attrs, int defStyle) { super(context, attrs, defStyle); init(); }

    private void init() {
        density = getResources().getDisplayMetrics().density;
        float scaled = getResources().getDisplayMetrics().scaledDensity;

        fillPaint.setStyle(Paint.Style.FILL);
        fillPaint.setColor(0xCC101418);

        edgePaint.setStyle(Paint.Style.STROKE);
        edgePaint.setStrokeWidth(1f * density);
        edgePaint.setColor(0x55FFFFFF);

        ringPaint.setStyle(Paint.Style.STROKE);
        ringPaint.setStrokeWidth(2.5f * density);
        ringPaint.setStrokeCap(Paint.Cap.ROUND);
        ringPaint.setColor(0xFF14B8A6);

        textPaint.setTextAlign(Paint.Align.CENTER);
        textPaint.setColor(0xFFE5E7EB);
        textPaint.setTextSize(11f * scaled);
        textPaint.setFakeBoldText(true);
    }

    /** 延迟读数（"--" 表示测不到）。 */
    public void setLatency(String text, int color) {
        label = text == null ? "--" : text;
        textPaint.setColor(color);
        invalidate();
    }

    /** 进度 0..1；传负数表示不显示进度环。 */
    public void setRing(float progress) {
        ringProgress = progress;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        int w = getWidth();
        int h = getHeight();
        float radius = Math.min(w, h) / 2f - 0.5f * density;
        if (radius <= 0f) return;
        float cx = w / 2f;
        float cy = h / 2f;

        canvas.drawCircle(cx, cy, radius, fillPaint);
        canvas.drawCircle(cx, cy, radius, edgePaint);

        if (ringProgress >= 0f) {
            float inset = 2f * density;
            float arcWidth = Math.max(8f, 360f * Math.min(1f, ringProgress));
            ringRect.set(inset, inset, w - inset, h - inset);
            canvas.drawArc(ringRect, -90f, arcWidth, false, ringPaint);
        }

        float baseline = cy - (textPaint.descent() + textPaint.ascent()) / 2f;
        canvas.drawText(label, cx, baseline, textPaint);
    }
}
