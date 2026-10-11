package com.zorv.whale;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

public class OverlayService extends Service {

    /** 常驻前台服务的静默渠道 */
    private static final String CHANNEL = "whale";
    /** 点击挂件后的唤醒提醒渠道（B 方案）：有声音/振动，点通知拉起 ZorvAI */
    private static final String CH_ALERT = "whale_alert";

    private static final int NOTI_ID = 0x5A1;
    private static final int NOTI_ALERT_ID = 0x5A2;
    private static final String ZORV_PKG = "com.ai.assistance.quro";

    private static final int SIZE_DP = 64;
    private static final int EDGE_DP = 8;
    private static final int DRAG_SLOP_DP = 8;

    private WindowManager wm;
    private WhaleView whale;
    private WindowManager.LayoutParams lp;

    @Override public void onCreate() {
        super.onCreate();
        ensureChannels();
        startAsForeground();
        showWhale();
    }

    /** 两条渠道分开：常驻那条静默，提醒那条响 —— 否则点了没感觉 */
    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        NotificationChannel silent = new NotificationChannel(
                CHANNEL, "小鲸鱼挂件", NotificationManager.IMPORTANCE_MIN);
        silent.setShowBadge(false);
        nm.createNotificationChannel(silent);

        NotificationChannel alert = new NotificationChannel(
                CH_ALERT, "小鲸鱼提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("点击挂件后的唤醒提醒：点通知即可让 Zorv AI 检查补充提示");
        alert.enableVibration(true);
        nm.createNotificationChannel(alert);
    }

    private void startAsForeground() {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);

        b.setSmallIcon(android.R.drawable.ic_menu_info_details)
         .setContentTitle("小鲸鱼挂件运行中")
         .setContentText("点一下小鲸鱼即可补充提示")
         .setOngoing(true);

        // specialUse 这个类型是 API 34 才有的：在 Android 11 上传进去会被拒，只在 34+ 带类型。
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTI_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTI_ID, b.build());
        }
    }

    /**
     * B 方案：ZorvAI 没有 hook 挂载点，点了挂件 AI 不会自己醒。
     * 于是把「该叫 AI 了」变成一条可点的高优先级通知，点一下就把 ZorvAI 拉到前台。
     */
    private void notifyUser(String eventPath) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        boolean ok = eventPath != null;

        PendingIntent pi = null;
        Intent open = getPackageManager().getLaunchIntentForPackage(ZORV_PKG);
        if (open == null) {
            // 兜底：缺少 queries 声明时上一句会返回 null，隐式意图仍能把包拉起来
            open = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .setPackage(ZORV_PKG);
        }
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            open.putExtra("whale_event_hint", "检查小鲸鱼挂件事件");
            open.putExtra("whale_event_path", ok ? eventPath : "");
            pi = PendingIntent.getActivity(this, 1, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CH_ALERT)
                : new Notification.Builder(this);

        b.setSmallIcon(ok ? android.R.drawable.ic_dialog_info : android.R.drawable.ic_dialog_alert)
         .setContentTitle(ok ? "\uD83D\uDC0B 已通知 Zorv AI" : "\uD83D\uDC0B 事件写入失败")
         .setContentText(ok ? "点这里让 Zorv AI 立刻检查你的补充提示"
                            : "请授予「所有文件访问」权限后重试")
         .setAutoCancel(true)
         .setPriority(Notification.PRIORITY_HIGH);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setDefaults(Notification.DEFAULT_VIBRATE);
        }
        if (pi != null) b.setContentIntent(pi);

        // 同一个 id：连点只会刷新同一条通知，不会刷屏
        nm.notify(NOTI_ALERT_ID, b.build());
    }

    private void showWhale() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        whale = new WhaleView(this);

        int type = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        lp = new WindowManager.LayoutParams(
                dp(SIZE_DP), dp(SIZE_DP), type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = getSharedPreferences("whale", MODE_PRIVATE).getInt("x", dp(12));
        lp.y = getSharedPreferences("whale", MODE_PRIVATE).getInt("y", 600);

        whale.setOnTouchListener(new DragOrTap());
        try {
            wm.addView(whale, lp);
        } catch (Exception e) {
            Toast.makeText(this, "悬浮窗添加失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            stopSelf();
        }
    }

    /** 拖动 / 点击二合一：位移超过 8dp 才算拖动，否则算点击 */
    private final class DragOrTap implements View.OnTouchListener {
        private float downRawX, downRawY;
        private int startX, startY;
        private boolean moved;

        @Override public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downRawX = e.getRawX();
                    downRawY = e.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    moved = false;
                    return true;

                case MotionEvent.ACTION_MOVE: {
                    int dx = (int) (e.getRawX() - downRawX);
                    int dy = (int) (e.getRawY() - downRawY);
                    if (Math.abs(dx) > dp(DRAG_SLOP_DP) || Math.abs(dy) > dp(DRAG_SLOP_DP)) moved = true;
                    if (moved) {
                        lp.x = startX + dx;
                        lp.y = startY + dy;
                        wm.updateViewLayout(whale, lp);
                    }
                    return true;
                }

                case MotionEvent.ACTION_UP:
                    if (moved) snapToEdge();
                    else onClickWhale();
                    return true;

                default:
                    return false;
            }
        }
    }

    private void snapToEdge() {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        boolean left = (lp.x + dp(SIZE_DP) / 2) < screenW / 2;
        lp.x = left ? dp(EDGE_DP) : screenW - dp(SIZE_DP) - dp(EDGE_DP);
        wm.updateViewLayout(whale, lp);
        getSharedPreferences("whale", MODE_PRIVATE).edit()
                .putInt("x", lp.x).putInt("y", lp.y).apply();
    }

    /** 核心：点一下就往事件队列递一个补充提示，并弹一条可点的唤醒通知 */
    private void onClickWhale() {
        whale.ping();
        String path = WhaleEvent.fire(this, "用户点击了小鲸鱼");
        notifyUser(path);
        Toast.makeText(this,
                path == null ? "事件写入失败：请授予「所有文件访问」权限" : "已通知 ZorvAI：" + path,
                Toast.LENGTH_SHORT).show();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        super.onDestroy();
        if (wm != null && whale != null) {
            try { wm.removeView(whale); } catch (Exception ignored) {}
        }
    }
}
