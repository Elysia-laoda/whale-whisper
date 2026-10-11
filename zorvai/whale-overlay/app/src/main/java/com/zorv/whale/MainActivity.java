package com.zorv.whale;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private TextView status;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(56, 120, 56, 56);

        TextView tv = new TextView(this);
        tv.setTextSize(16f);
        tv.setText("\u5C0F\u9CB8\u9C7C\u6302\u4EF6 \uD83D\uDC0B\n\n"
                + "\u2460 \u6388\u4E88\u60AC\u6D6E\u7A97\u6743\u9650\n"
                + "\u2461 \u6388\u4E88\u300C\u6240\u6709\u6587\u4EF6\u8BBF\u95EE\u300D\n"
                + "\u2462 \u542F\u52A8\u6302\u4EF6\n"
                + "\u2463 \u70B9\u9CB8\u9C7C \u2192 ZorvAI \u4F1A\u95EE\u4F60\u300C\u6709\u4EC0\u4E48\u8981\u8865\u5145\u7684\u5417\uFF1F\u300D");
        box.addView(tv);

        status = new TextView(this);
        status.setTextSize(13f);
        status.setPadding(0, 24, 0, 24);
        box.addView(status);

        Button perm = new Button(this);
        perm.setText("\u2460 \u60AC\u6D6E\u7A97\u6743\u9650");
        perm.setOnClickListener(v -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            } else {
                Toast.makeText(this, "\u5DF2\u6388\u6743", Toast.LENGTH_SHORT).show();
            }
        });
        box.addView(perm);

        Button allFiles = new Button(this);
        allFiles.setText("\u2461 \u6240\u6709\u6587\u4EF6\u8BBF\u95EE");
        allFiles.setOnClickListener(v -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    Toast.makeText(this, "\u8BF7\u7528 adb \u4EE3\u5F00\uFF1Aappops set " + getPackageName()
                            + " MANAGE_EXTERNAL_STORAGE allow", Toast.LENGTH_LONG).show();
                }
            } else {
                Toast.makeText(this, "\u5DF2\u6388\u6743", Toast.LENGTH_SHORT).show();
            }
        });
        box.addView(allFiles);

        Button start = new Button(this);
        start.setText("\u2462 \u542F\u52A8\u6302\u4EF6");
        start.setOnClickListener(v -> {
            Intent s = new Intent(this, OverlayService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(s);
            else startService(s);
            Toast.makeText(this, "\u9CB8\u9C7C\u5DF2\u5C31\u4F4D", Toast.LENGTH_SHORT).show();
            finish();
        });
        box.addView(start);

        Button stop = new Button(this);
        stop.setText("\u2463 \u505C\u6B62\u6302\u4EF6");
        stop.setOnClickListener(v -> {
            stopService(new Intent(this, OverlayService.class));
            Toast.makeText(this, "\u5DF2\u505C\u6B62", Toast.LENGTH_SHORT).show();
        });
        box.addView(stop);

        setContentView(box);
        askNotificationPermission();
    }

    /** Android 13+ 才有运行时通知权限；更老的系统上通知默认可用 */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                   != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 101);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        boolean overlay = Settings.canDrawOverlays(this);
        boolean files = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                && Environment.isExternalStorageManager();
        status.setText("\u60AC\u6D6E\u7A97\uFF1A" + (overlay ? "\u2713" : "\u2717")
                + "\u3000\u6240\u6709\u6587\u4EF6\uFF1A" + (files ? "\u2713" : "\u2717")
                + "\n" + WhalePaths.WORKSPACE_DIR + "/pending.json");
    }
}