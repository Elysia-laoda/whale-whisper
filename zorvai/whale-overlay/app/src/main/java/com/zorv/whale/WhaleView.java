package com.zorv.whale;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.view.View;

/** 自绘小鲸鱼：径向渐变圆 + 鲸鱼 emoji + 点击脉冲 */
public class WhaleView extends View {

    private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glyph = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private float pulse = 0f;

    public WhaleView(Context c) {
        super(c);
        glyph.setColor(Color.WHITE);
        glyph.setTextAlign(Paint.Align.CENTER);
        glyph.setTextSize(38f);
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(2f);
        ring.setColor(0x59FFFFFF);
    }

    @Override protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float r = Math.min(w, h) / 2f - 4f;
        bg.setShader(new RadialGradient(w / 2f, h / 2f, r,
                new int[]{0xFF3E8BFF, 0xFF1B6DF0, 0xFF0E4BB8},
                new float[]{0f, 0.6f, 1f}, Shader.TileMode.CLAMP));
        cv.drawCircle(w / 2f, h / 2f, r + pulse, bg);
        cv.drawCircle(w / 2f, h / 2f, r, ring);

        Paint.FontMetrics fm = glyph.getFontMetrics();
        float y = h / 2f - (fm.ascent + fm.descent) / 2f;
        cv.drawText("\uD83D\uDC0B", w / 2f, y, glyph);
    }

    public void ping() {
        pulse = 6f;
        invalidate();
        postDelayed(new Runnable() {
            @Override public void run() {
                pulse = 0f;
                invalidate();
            }
        }, 180);
    }
}
