# 🐋 ZorvAI 小鲸鱼悬浮挂件 · 手机端移植交接文档

**版本** v1.0 · 2026-10-09
**上游项目** github.com/Elysia-laoda/whale-whisper（MIT）
**目标宿主** ZorvAI（com.ai.assistance.quro）on Android
**接收方** 电脑端构建者
**本机环境** vivo V2156FA / Android 11 / aarch64 / 未 root / Shizuku 在线(uid 2000)

---

## 0. 一句话目标（可判定完成/未完成）

> 手机上出现一只**常驻屏幕、可拖动**的小鲸鱼悬浮窗；**点它一下**，ZorvAI 在当前会话里立刻问我「有什么要补充的吗？」，我答完它继续干活 —— 真机跑通一次即完成。

---

## 1. 上游事实（源码级，已逐文件核实）

### 1.1 目录清单

```
.mcp.json        {"mcpServers":{"supplement-widget":{"command":"node","args":["./mcp-server/server.js"]}}}
mcp-server/      server.js(6.0KB) · package.json · test-server.mjs
                 widget/widget.html(360KB 构建产物) · widget/widget.template.html(20KB 模板)
hooks/           supplement-widget-hook.mjs (9.3KB) —— 单脚本挂四类事件
overlay/         overlay.py(31.5KB PySide6) · whale.svg · start/stop/enable/disable-autostart.vbs
skills/supplement-widget/SKILL.md (3.7KB) —— AI 行为规则
scripts/         build-widget.mjs
zcode/           ZCode 移植版（README + hooks + overlay + scripts + skills）
docs/            截图 5 张
```

### 1.2 四类 hook 事件（上游机制核心）

| 事件 | 行为 |
|---|---|
| `SessionStart` | 注入 SESSION_TEXT —— 告诉 AI「本机有挂件、点它会派发事件」 |
| `UserPromptSubmit` | ① 识别「关掉挂件」意图（本会话静默）② 消费 pending 请求并注入提问指令 |
| `PostToolUse(*)` | **主路径**：消费 pending → 注入提问指令；用户手动打开对话内挂件时做已读标记 |
| `Stop` | 有未处理 pending → `process.exitCode = 2` 阻止停止，stderr 作为反馈注入模型 |

### 1.3 状态与去重

- 状态文件 + `pending-request.json`，**消费式**取走（`takePending()`）
- 去重靠**事件 id**：同一 id 只提问一次
- 任何异常静默跳过，**永不阻塞会话**（`process.exit(0)` 兜底）

### 1.4 挂件两种形态

1. **桌面版（默认）**：PySide6 画布自绘，`WA_TranslucentBackground + WindowStaysOnTopHint + Qt.Tool`；Win32 `EnumWindows/GetWindowRect` 跟随宿主窗口；命名互斥体单实例；启停用 UTF-16 LE 的 .vbs
2. **对话内版**：MCP App HTML，资源 `ui://supplement-widget/panel`，MIME `text/html;profile=mcp-app`，约 333KB（内联 `@modelcontextprotocol/ext-apps@1.7.5`）

### 1.5 MCP server（stdio）

- 工具：`open_supplement_widget(float=true)`；资源：`ui://supplement-widget/panel`
- 依赖：`@modelcontextprotocol/sdk ^1.32.1` + `@modelcontextprotocol/ext-apps ^1.7.5`
- **手机端 proot 实测**：依赖安装 96 包/18s，`node test-server.mjs` → **ALL PASSED ✓**（工具 / 资源 / 333.1KB HTML / callTool / float:false 五项全绿）

### 1.6 必须逐字移植的两段文案（本地化改写时保持语义）

```js
const SESSION_TEXT =
  '【补充提示挂件·上下文】本机装有"补充提示挂件"：桌面版小鲸鱼常驻屏幕右下角（用户可拖动、可点击）。'
+ '机制：用户点击挂件后，你会收到一条「补充提示挂件·事件 <id>」提醒（可能出现在工具结果后或用户消息里），'
+ '届时请立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后把他的补充纳入计划再继续；'
+ '同一事件 <id> 只需提问一次。另有一个对话内挂件（工具 open_supplement_widget）：仅在用户明确要求"放到对话里"时才打开，'
+ '不要主动打开。若用户表示过不需要挂件，则本会话不再处理挂件事件。';

function pendingText(id) {
  return '【补充提示挂件·事件 ' + id + '】用户按下了补充提示挂件，希望在任务继续前补充提示。'
       + '请立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后再继续当前任务；'
       + '不要推迟到任务结束。若你已处理过同一事件（' + id + '）则忽略本提醒。';
}
```

### 1.7 ZCode 移植版的先例（重要取舍参考）

- 悬浮挂件 + 钩子注入机制**保持一致**；会话枚举改读 ZCode `db.sqlite`；Stop 改走 `decision:block + reason`
- **砍掉了 MCP server 与对话内挂件**（ZCode CLI 不渲染 MCP Apps）
- 结论：**ZorvAI 版同样只保留「悬浮挂件 + 注入机制」，其余全部本土化**

---

## 2. 手机端限制 → 等价物映射

| 上游能力 | ZorvAI 手机端等价物 | 说明 |
|---|---|---|
| PySide6 + Win32 悬浮窗 | **Android 悬浮窗 Service**（WindowManager + `TYPE_APPLICATION_OVERLAY`） | 电脑端构建 |
| hooks 四事件 | **技能注入 + 轮首检查/定时轮询** | ZorvAI 无 hook 挂载点 |
| `AskUserQuestion` | **AI 直接在会话里提问** | 无同名工具，语义等价 |
| 对话内挂件（MCP App） | `quro-card` / `ui_widget`（可选，次选） | 用户已否决「只做卡片」 |
| `pending-request.json` | **公共目录 `pending.json`**（见 §5） | Android 11 分区存储限制 |
| stdio MCP server | 可选：改 HTTP/SSE 供 ZorvAI MCP 客户端连 | 需先确认客户端 transport |
| Stop-hook 阻止停止 | 无等价 → 降级为「下次工具调用后 / 下一轮」提问 | 可接受 |

---

## 3. 目标架构（数据流）

```
[用户点击鲸鱼悬浮窗]
        ↓
[OverlayService 写事件]  pending.json {id, ts, source, state:"pending"}
        ↓
[ZorvAI 侧读到事件]  ① 技能硬规则：每轮回复前检查一次
                     ② schedule_task 每分钟轮询
                     ③ Termux 守护中转（秒级，可选）
        ↓
[AI 立即提问]  「有什么要补充的吗？」（对齐上游 pendingText 语义）
        ↓
[用户作答 → ack 事件]  标记 acked / 清空 pending → 补充纳入计划后继续
```

---

## 4. Android 悬浮窗 APK 设计（电脑端构建）

### 4.1 工程结构

```
whale-overlay/
├── settings.gradle
├── build.gradle
├── gradle.properties
└── app/
    ├── build.gradle
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/zorv/whale/
        │   ├── MainActivity.java      权限引导 + 启停服务
        │   ├── OverlayService.java    前台服务 + WindowManager 挂件
        │   ├── WhaleView.java         自绘鲸鱼（气泡 + emoji + 脉冲）
        │   ├── WhaleEvent.java        事件写入（多通道回退 + 原子写）
        │   ├── WhalePaths.java        路径常量
        │   └── BootReceiver.java      开机自启（可选）
        └── res/values/strings.xml
```

### 4.2 权限与组件

| 项 | 值 |
|---|---|
| 包名 | `com.zorv.whale` |
| minSdk / targetSdk | 26 / 34 |
| 权限 | `SYSTEM_ALERT_WINDOW`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_SPECIAL_USE`、`POST_NOTIFICATIONS`、`RECEIVE_BOOT_COMPLETED`、`WAKE_LOCK`、`MANAGE_EXTERNAL_STORAGE`（可选，用于直写工作区） |
| 组件 | `MainActivity`（LAUNCHER）、`OverlayService`（foregroundServiceType=specialUse）、`BootReceiver` |

### 4.3 关键源码（完整可编译）

**AndroidManifest.xml**
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />

    <application
        android:allowBackup="false"
        android:label="小鲸鱼挂件">

        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service
            android:name=".OverlayService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="floating supplement widget" />
        </service>

        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    </application>
</manifest>
```

**WhalePaths.java**
```java
package com.zorv.whale;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

public final class WhalePaths {

    /** ZorvAI 工作区状态目录（需 MANAGE_EXTERNAL_STORAGE 才可写） */
    public static final String WORKSPACE_DIR =
            "/sdcard/Android/data/com.ai.assistance.quro/files/QuroWorkspace/whale-whisper/state";

    /** 公共交换区（Termux 桥接同款目录） */
    public static final String QSHARE_DIR = "/sdcard/qshare/whale";

    /** 公共兜底（任何文件管理器可见） */
    public static final String DOWNLOAD_DIR = "/sdcard/Download/whale";

    private WhalePaths() {}

    public static List<File> pendingCandidates() {
        List<File> out = new ArrayList<>();
        out.add(new File(WORKSPACE_DIR, "pending.json"));
        out.add(new File(QSHARE_DIR, "pending.json"));
        out.add(new File(DOWNLOAD_DIR, "pending.json"));
        return out;
    }
}
```

**WhaleEvent.java**
```java
package com.zorv.whale;

import android.content.Context;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

public final class WhaleEvent {

    private WhaleEvent() {}

    /** 产生一个「补充提示」事件；返回真正写入的绝对路径，全通道失败返回 null */
    public static synchronized String fire(Context ctx, String note) {
        long now = System.currentTimeMillis();
        try {
            JSONObject o = new JSONObject();
            o.put("id", "w" + now);
            o.put("ts", now);
            o.put("source", "android-overlay");
            o.put("state", "pending");
            o.put("note", note == null ? "" : note);

            String body = o.toString(2);
            for (File f : WhalePaths.pendingCandidates()) {
                if (writeAtomic(f, body)) return f.getAbsolutePath();
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** 临时文件 + rename，避免并发写坏 */
    private static boolean writeAtomic(File target, String body) {
        try {
            File dir = target.getParentFile();
            if (dir == null) return false;
            if (!dir.exists() && !dir.mkdirs()) return false;

            File tmp = new File(dir, target.getName() + ".tmp");
            try (OutputStreamWriter w = new OutputStreamWriter(
                    new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
                w.write(body);
                w.flush();
            }
            if (tmp.renameTo(target)) return true;
            return target.delete() && tmp.renameTo(target);
        } catch (Exception e) {
            return false;
        }
    }
}
```

**WhaleView.java**
```java
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
    private float pulse = 0f;

    public WhaleView(Context c) {
        super(c);
        glyph.setColor(Color.WHITE);
        glyph.setTextAlign(Paint.Align.CENTER);
        glyph.setTextSize(38f);
    }

    @Override protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float r = Math.min(w, h) / 2f - 4f;
        bg.setShader(new RadialGradient(w / 2f, h / 2f, r,
                new int[]{0xFF3E8BFF, 0xFF1B6DF0, 0xFF0E4BB8},
                new float[]{0f, 0.6f, 1f}, Shader.TileMode.CLAMP));
        cv.drawCircle(w / 2f, h / 2f, r + pulse, bg);

        Paint.FontMetrics fm = glyph.getFontMetrics();
        float y = h / 2f - (fm.ascent + fm.descent) / 2f;
        cv.drawText("🐋", w / 2f, y, glyph);
    }

    public void ping() {
        pulse = 6f;
        invalidate();
        postDelayed(new Runnable() {
            @Override public void run() { pulse = 0f; invalidate(); }
        }, 180);
    }
}
```

**OverlayService.java**
```java
package com.zorv.whale;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
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

    private static final String CHANNEL = "whale";
    private static final int NOTI_ID = 0x5A1;
    private static final int SIZE_DP = 64;
    private static final int EDGE_DP = 8;

    private WindowManager wm;
    private WhaleView whale;
    private WindowManager.LayoutParams lp;

    @Override public void onCreate() {
        super.onCreate();
        startAsForeground();
        showWhale();
    }

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel c = new NotificationChannel(
                    CHANNEL, "小鲸鱼挂件", NotificationManager.IMPORTANCE_MIN);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);

        b.setSmallIcon(android.R.drawable.ic_menu_info_details)
         .setContentTitle("小鲸鱼挂件运行中")
         .setContentText("点一下小鲸鱼即可补充提示")
         .setOngoing(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTI_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTI_ID, b.build());
        }
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

    /** 拖动 / 点击二合一（位移 8dp + 时长阈值区分） */
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
                    if (Math.abs(dx) > dp(8) || Math.abs(dy) > dp(8)) moved = true;
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
            }
            return false;
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

    /** ★ 核心：点一下就往 ZorvAI 递一个「补充提示」事件 */
    private void onClickWhale() {
        whale.ping();
        String path = WhaleEvent.fire(this, "用户点击了小鲸鱼");
        Toast.makeText(this,
                path == null ? "事件写入失败：请授予存储权限" : "已通知 ZorvAI ✓",
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
```

**BootReceiver.java**
```java
package com.zorv.whale;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        Intent s = new Intent(ctx, OverlayService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(s);
        else ctx.startService(s);
    }
}
```

**MainActivity.java**
```java
package com.zorv.whale;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(56, 120, 56, 56);

        TextView tv = new TextView(this);
        tv.setTextSize(16f);
        tv.setText("小鲸鱼挂件 🐋\n\n① 授予悬浮窗权限\n② 启动挂件（出现鲸鱼）\n③ 点鲸鱼 → ZorvAI 会问你「有什么要补充的吗？」");
        box.addView(tv);

        Button perm = new Button(this);
        perm.setText("① 授予悬浮窗权限");
        perm.setOnClickListener(v -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            } else {
                Toast.makeText(this, "已授权 ✓", Toast.LENGTH_SHORT).show();
            }
        });
        box.addView(perm);

        Button start = new Button(this);
        start.setText("② 启动挂件");
        start.setOnClickListener(v -> {
            Intent s = new Intent(this, OverlayService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(s);
            else startService(s);
            Toast.makeText(this, "鲸鱼已就位", Toast.LENGTH_SHORT).show();
            finish();
        });
        box.addView(start);

        Button stop = new Button(this);
        stop.setText("③ 停止挂件");
        stop.setOnClickListener(v -> {
            stopService(new Intent(this, OverlayService.class));
            Toast.makeText(this, "已停止", Toast.LENGTH_SHORT).show();
        });
        box.addView(stop);

        setContentView(box);
    }
}
```

**res/values/strings.xml**
```xml
<resources>
    <string name="app_name">小鲸鱼挂件</string>
</resources>
```

### 4.4 gradle 配置（AGP 8.x）

**settings.gradle**
```gradle
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "whale-overlay"
include ':app'
```

**build.gradle（根）**
```gradle
plugins {
    id 'com.android.application' version '8.5.2' apply false
}
```

**app/build.gradle**
```gradle
plugins { id 'com.android.application' }

android {
    namespace 'com.zorv.whale'
    compileSdk 34

    defaultConfig {
        applicationId "com.zorv.whale"
        minSdk 26
        targetSdk 34
        versionCode 1
        versionName "1.0.0"
    }

    buildTypes {
        release {
            minifyEnabled false
            signingConfig signingConfigs.debug   // 正式发布请换 release keystore
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}
```

**gradle.properties**
```properties
android.useAndroidX=false
org.gradle.jvmargs=-Xmx2048m
```

### 4.5 构建命令

```bash
cd whale-overlay
./gradlew :app:assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
# 校验：apkanalyzer manifest print app-release.apk | grep -i overlay
```

---

## 5. 事件协议（跨 App 通道）

### 5.1 ⚠️ 第一大坑：Android 11 分区存储

- 从 Android 11 起，**App 无法访问其它 App 的 `/sdcard/Android/data/<pkg>/`**
- 因此悬浮窗**默认写不进** ZorvAI 工作区（`.../com.ai.assistance.quro/files/QuroWorkspace/`）
- 两条破解路径：
  1. **公共目录（默认）**：`/sdcard/qshare/whale/`（qshare 已是 Termux 桥接的公共交换区）
  2. **申请 `MANAGE_EXTERNAL_STORAGE`** 后由 Shizuku 代开：
     `appops set com.zorv.whale MANAGE_EXTERNAL_STORAGE allow` → 即可直写工作区
- 实现策略：**三级回退**（工作区 → qshare → Download/whale），见 `WhalePaths` + `WhaleEvent`

### 5.2 pending.json schema

```json
{
  "id": "w1760000000000",
  "ts": 1760000000000,
  "source": "android-overlay",
  "state": "pending",
  "note": "用户点击了小鲸鱼"
}
```

- **消费式**：ZorvAI 处理后把 `state` 改 `done` 或写入 `acked[]` 实现去重
- **原子写**：`.tmp` + rename
- 事件文件单一（覆盖式），历史追加可选 `/sdcard/qshare/whale/events.log`

### 5.3 通道优先级

| 序 | 通道 | 前提 | 实时性 |
|---|---|---|---|
| 1 | 直写工作区 `pending.json` | MANAGE_EXTERNAL_STORAGE 已代开 | 好 |
| 2 | 公共目录 `/sdcard/qshare/whale/pending.json` | 存储读写 | 好 |
| 3 | Termux 中转（qshare/inbox 命令队列） | Termux 常驻 | 秒级 |

---

## 6. ZorvAI 侧（手机端可自行完成，不必等 APK）

### 6.1 技能注入 —— 取代 hooks

路径 `QuroWorkspace/skills/whale/`：
- `whale.skill.json`（结构照抄 `skills/turn-cost/turn-cost.skill.json`）
- `whale.prompt.txt`（内容 = 上游 SESSION_TEXT 本地化 + 硬规则「每轮回复前先检查 pending」）

↳ 用户需在「技能管理」里新增并启用（与现有 cost-turn 技能同一机制）

### 6.2 ToolPkg —— 取代 pending 读写

路径 `QuroWorkspace/packages/whale/`（结构照抄 `packages/turn-cost/`：`manifest.json` + `index.js`）：

| 工具 | 作用 |
|---|---|
| `whale_pending` | 读 pending.json，返回未处理事件（id/ts/note） |
| `whale_ack(id)` | 标记已处理（去重） |
| `whale_simulate` | 手动产生一个事件（等价于点挂件，用于无 APK 时联调） |
| `whale_state` | 查看 / 重置状态 |

### 6.3 触发策略（可叠加）

| 策略 | 实时性 | 代价 |
|---|---|---|
| 技能硬规则：每轮回复前检查一次 | 下一轮 | 零成本，最简 |
| `schedule_task` 每分钟轮询 | ~1 分钟 | 需建定时任务 |
| Termux 守护轮询 → 秒级触发 | 秒级 | 需 Termux 常驻 |

### 6.4 Termux 的角色（已实测确认）

| 能做 | 不能做 |
|---|---|
| ✅ 常驻服务宿主（轮询守护 / HTTP 端点） | ❌ **系统级悬浮窗**（拿不到 `SYSTEM_ALERT_WINDOW`） |
| ✅ MCP server 宿主（node v24.18.0，whale-whisper 依赖已装、自测全绿） | ❌ 替代悬浮窗（`termux-notification` 只是常驻通知） |
| ✅ 桥接中转：`/usr/local/bin/termux "<cmd>"`（SSH 8022）或 `/sdcard/qshare/inbox` 命令队列 | |

---

## 7. 安装与授权

**方式 A（电脑 adb，推荐）**
```bash
adb install -r app-release.apk
adb shell appops set com.zorv.whale SYSTEM_ALERT_WINDOW allow
adb shell appops set com.zorv.whale MANAGE_EXTERNAL_STORAGE allow   # 想直写工作区才需要
adb shell cmd deviceidle whitelist +com.zorv.whale                  # 电池白名单
adb shell settings put global cached_apps_freezer disabled           # 防冻结（可选）
```

**方式 B（手机端，Shizuku 在线）**
1. `install_app` 工具静默安装 APK
2. `shizuku_exec` 执行上面的 `appops set` 两条
3. 点图标 → 「② 启动挂件」

---

## 8. 验证清单（逐条可判定）

| # | 验证项 | 证据 |
|---|---|---|
| 1 | 构建成功 | gradle `BUILD SUCCESSFUL` + APK 路径 |
| 2 | 安装成功 | `pm list packages \| grep com.zorv.whale` |
| 3 | 悬浮窗可见 | 截图 / `visual_analysis` 看到鲸鱼 |
| 4 | 可拖动 + 位置记忆 | 拖动后重启 App，位置不变 |
| 5 | 点击写事件 | `cat pending.json` 的 `id` 递增 |
| 6 | ZorvAI 读到 | `whale_pending` 返回该 id |
| 7 | AI 提问 | 会话里出现「有什么要补充的吗？」 |
| 8 | 去重生效 | 同 id 不重复提问；ack 后不再出现 |
| 9 | 端到端 | 长任务中点挂件 → 补充提示被纳入执行 |

---

## 9. 已知风险与规避

| 风险 | 规避 |
|---|---|
| 分区存储读不到工作区 | 三级回退（§5.1） |
| 后台被冻结/杀（vivo 激进） | 前台服务 + 电池白名单 + `cached_apps_freezer disabled` |
| 无 hook，实时性差 | 轮询 + 轮首检查叠加 |
| 国产 ROM 拦截悬浮窗 | `appops set ... SYSTEM_ALERT_WINDOW allow` |
| 事件并发写坏 | tmp + rename 原子写 |
| 拖动误判为点击 | 位移 8dp 阈值 |
| Android 14+ FGS 类型强制 | 已用 `specialUse` + subtype property |

---

## 10. 上游文件索引（对照移植）

| 上游 | 手机端对应 |
|---|---|
| `overlay/overlay.py` | `OverlayService.java` + `WhaleView.java` |
| `hooks/supplement-widget-hook.mjs` | `skills/whale/*` + `packages/whale/*` |
| `skills/supplement-widget/SKILL.md` | `skills/whale/whale.prompt.txt` |
| `mcp-server/server.js` | 可选：HTTP MCP（或省略） |
| `mcp-server/widget/widget.html` | 可选：`quro-card` 卡片 |
| `.mcp.json` | ZorvAI「设置 → MCP 服务」 |

---

## 11. 决策记录

- 2026-10-09 用户明确：**不能只做挂件卡片，必须悬浮窗**（卡片会随对话滚走、找不到）
- 用户提供 Termux 作为辅助（可当事件中枢/MCP 宿主，但**不承担悬浮窗**）
- 构建改由电脑端完成（本机端侧构建台工具链虽齐备）
- 已有资产：
  - proot `/root/whale-whisper`（完整 clone + 依赖 + 自测 ALL PASSED）
  - 工作区 `QuroWorkspace/whale-whisper/`（源码副本 912K）

---

## 附录 A：本机环境事实（实测）

| 项 | 值 |
|---|---|
| 设备 | vivo V2156FA / Android 11 / aarch64 / 未 root |
| ZorvAI 包名 | com.ai.assistance.quro |
| 工作区 | /storage/emulated/0/Android/data/com.ai.assistance.quro/files/QuroWorkspace |
| proot Ubuntu | node v22.23.2 / npm 10.9.8 / pnpm 11.25.0（npmmirror 源） |
| proot 内仓库 | /root/whale-whisper（依赖已装，`node test-server.mjs` 全绿） |
| 端侧构建台 | filesDir/buildproject/libs：android.jar(20MB) · ecj.jar · d8.jar · apksigner.jar · base.apk(13KB) · web_base.apk(4KB) |
| Shizuku | installed/alive/ready = true，uid 2000 |
| Termux | node v24.18.0 / python 3.14.6 / u0_a612 / sshd 8022 |

## 附录 B：上游 MCP server 自测输出（手机实测）

```
[supplement-widget] MCP server ready (stdio). widget=/root/whale-whisper/mcp-server/widget/widget.html
[test] connected to server
[test] ✓ tool ok: _meta.ui.resourceUri = ui://supplement-widget/panel
[test] ✓ resource ok: ui://supplement-widget/panel text/html;profile=mcp-app
[test] ✓ html ok: 333.1 KB, mime = text/html;profile=mcp-app
[test] ✓ callTool ok: float = true
[test] ✓ callTool(float:false) ok
[test] ALL PASSED ✓
```

## 附录 C：许可

上游 whale-whisper 为 **MIT**；移植产物建议同样以 MIT 发布并署名原作者 `Elysia-laoda`。

---

## 12. 手机侧（ZorvAI 半边）完成情况 · 实测记录（2026-10-09）

> 本节由手机端实测产出，电脑端出包后按 §12.5 对接即可。

### 12.1 已交付文件

| 路径 | 大小 | 作用 |
|---|---|---|
| `QuroWorkspace/packages/whale/manifest.json` | 1319 B | ToolPkg 声明（4 个工具） |
| `QuroWorkspace/packages/whale/index.js` | 6538 B | 事件队列实现（pending/ack/simulate/state） |
| `QuroWorkspace/skills/whale/whale.skill.json` | 3017 B | 技能定义（**需在「技能管理」里新增并启用**） |
| `QuroWorkspace/skills/whale/whale.prompt.txt` | 2656 B | 行为规则（= 上游 hooks 的等价物） |
| `/sdcard/qshare/whale/pending.json` | — | **公共区事件文件（APK 写入点）** |
| `QuroWorkspace/whale-whisper/state/pending.json` | — | 工作区事件队列（ToolPkg 读取点） |
| proot `/usr/local/bin/whale-click` | — | 模拟点挂件（无 APK 时联调） |
| proot `/usr/local/bin/whale-sync` | — | 公共区 → 工作区 搬运合并 |

### 12.2 四个工具与实测结果

| 工具 | 实测 |
|---|---|
| `whale_pending` | ✅ 返回 `{count:1, items:[…]}` |
| `whale_ack(id)` | ✅ 返回 `{acked:"w1791529570241", remaining:1}`，队列随之减少（**去重生效**） |
| `whale_simulate` | ✅ 生成事件 `id=w1791529570241` |
| `whale_state` | ✅ `reset / mute / sync / probe` 全部可用 |

### 12.3 ⚠️ 沙箱能力实测（关键架构依据）

`whale_state({probe:true})` 返回：

```json
{
  "toolsKeys": ["Files", "Net", "System", "calc", "Media", "Git"],
  "canReadQshare": false,
  "canWriteWorkspace": true
}
```

**结论：ToolPkg 沙箱只能读写工作区，读不到 `/sdcard/qshare`（绝对路径被沙箱拦住）。**
→ 因此必须存在「三段桥」：

```
[悬浮窗 APK] --写--> /sdcard/qshare/whale/pending.json
                            |
                    proot（唯一同时能访问两边的进程）
                            |  whale-sync
                            v
      QuroWorkspace/whale-whisper/state/pending.json
                            |  whale_pending
                            v
                        [AI 提问]
```

替代方案（更省事）：APK 申请 `MANAGE_EXTERNAL_STORAGE` 并由 Shizuku 代开，**直写工作区**，即可跳过搬运。

### 12.4 端到端联调记录（原始输出）

```
=== 联调：点一下挂件 + 同步 ===
clicked id=w1791529590337
synced: +1, queue=2, acked=0
--- 工作区队列 ---
{"events":[{"id":"w1791529570241","ts":1791529570241,"source":"simulate","state":"pending",
            "note":"（联调）用户点击了小鲸鱼"},
           {"id":"w1791529590337","ts":1791529590337,"source":"proot-click","state":"pending",
            "note":"（联调）点了小鲸鱼"}],"acked":[],"mute":false}
```

ack 之后：`{"acked":"w1791529570241","remaining":1}` → `whale_pending` 只返回未 ack 的那 1 条 ✅

### 12.5 APK 出包后的对接（两步）

1. **APK 侧**：把事件写到 `/sdcard/qshare/whale/pending.json`
   （若能拿到 `MANAGE_EXTERNAL_STORAGE`，可直接写
   `/sdcard/Android/data/com.ai.assistance.quro/files/QuroWorkspace/whale-whisper/state/pending.json`）
   - 写入格式：`{"events":[{id,ts,source,state,note}],"acked":[],"mute":false}`（同 §5.2）
2. **ZorvAI 侧**：无需改代码 —— 技能规则里已内置「每轮先 `whale-sync`、再 `whale_pending`」

### 12.6 还差一步（用户操作）

在 ZorvAI「**技能管理**」里新增并启用技能 **`whale`**
（路径 `QuroWorkspace/skills/whale/whale.skill.json`），
否则 AI 不会自动执行「每轮检查挂件事件」这条铁律。
—— 参照已启用的 `cost-turn` 技能，机制完全相同。

### 12.7 无 APK 时的联调手段

```bash
# 模拟点一下小鲸鱼
whale-click "补充说明"
# 搬运到工作区
whale-sync
# 然后问 AI：刚才是不是有挂件事件？（AI 应走 whale_pending → 提问 → whale_ack）
```
