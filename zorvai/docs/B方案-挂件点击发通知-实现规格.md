# B 方案 · 挂件点击后发「唤醒通知」（实现规格 + 参考代码）

**目的**：用户点小鲸鱼 → 除写事件外，再发一条**高优先级通知**；点通知 → ZorvAI 被拉起 → AI 立刻检查挂件队列。
**代价**：零模型开销，从"不知道该说话"变成"点一下通知就行"。

---

## 一、为什么要这一步

ZorvAI **没有 hook 挂载点**（不像 WorkBuddy 有 `PostToolUse` / `Stop`），
所以"点击 → AI 自动醒来"这条线在官方加钩子之前**做不到**。

实测数据（12 次连点）：**事件一条不丢**（12/12 全部被 AI 读到），
缺的只是"点击之后 AI 不会自己醒"。

→ B 方案用**系统通知**补上这一环：让用户明确知道"该叫 AI 了"，并一键拉起。

---

## 二、改动清单（基于《交接文档》§4.3 的 OverlayService）

| # | 改动 | 位置 |
|---|---|---|
| 1 | 新增通知渠道 `whale_alert`（IMPORTANCE_HIGH，有声音/振动） | `OverlayService.ensureChannels()` |
| 2 | `onClickWhale()` 写完事件后调用 `notifyUser()` | `OverlayService` |
| 3 | 声明并请求 `POST_NOTIFICATIONS`（Android 13+ 运行时权限） | `AndroidManifest.xml` + `MainActivity` |
| 4 | 前台服务通知保持 `IMPORTANCE_MIN`（静默），与唤醒通知**分渠道** | 已有 |

---

## 三、参考代码

### 3.1 AndroidManifest.xml 追加

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### 3.2 OverlayService.java —— 新增

```java
    /* ================= B 方案：唤醒通知 ================= */

    private static final String CH_ALERT = "whale_alert";
    private static final int NOTI_ALERT_ID = 0x5A2;
    /** ZorvAI 包名 */
    private static final String ZORV_PKG = "com.ai.assistance.quro";

    /** 渠道：静默（服务常驻）+ 提醒（点击唤醒）分开，避免"点了没感觉" */
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

    /** 点挂件后：把「该叫 AI 了」这件事变成一条可点的通知 */
    private void notifyUser(String eventPath) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        // 点击通知 → 拉起 ZorvAI（顺带带上事件提示 extra：官方支持后即为全自动）
        PendingIntent pi = null;
        Intent open = getPackageManager().getLaunchIntentForPackage(ZORV_PKG);
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            open.putExtra("whale_event_hint", "检查小鲸鱼挂件事件");
            open.putExtra("whale_event_path", eventPath == null ? "" : eventPath);
            pi = PendingIntent.getActivity(this, 1, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CH_ALERT)
                : new Notification.Builder(this);

        b.setSmallIcon(android.R.drawable.ic_dialog_info)
         .setContentTitle("🐋 已通知 Zorv AI")
         .setContentText("点这里让 Zorv AI 立刻检查你的补充提示")
         .setAutoCancel(true)
         .setPriority(Notification.PRIORITY_HIGH)
         .setDefaults(Notification.DEFAULT_VIBRATE);

        if (pi != null) b.setContentIntent(pi);

        nm.notify(NOTI_ALERT_ID, b.build());
    }
```

### 3.3 OverlayService.onCreate() —— 调一次 ensureChannels()

```java
    @Override public void onCreate() {
        super.onCreate();
        ensureChannels();      // ← 新增
        startAsForeground();
        showWhale();
    }
```

### 3.4 onClickWhale() —— 追加一行

```java
    private void onClickWhale() {
        whale.ping();
        String path = WhaleEvent.fire(this, "用户点击了小鲸鱼");
        notifyUser(path);      // ← 新增：发唤醒通知
        Toast.makeText(this,
                path == null ? "事件写入失败：请授予存储权限" : "已通知 ZorvAI ✓",
                Toast.LENGTH_SHORT).show();
    }
```

### 3.5 MainActivity.java —— Android 13+ 请求通知权限

```java
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {   // Build.VERSION_CODES.TIRAMISU
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 101);
            }
        }
    }
```
在 `onCreate()` 里调用 `askNotificationPermission();`

---

## 四、验证步骤

```bash
# 1) 通知渠道已建
adb shell dumpsys notification --noredact | grep -A3 "whale_alert"

# 2) 点一下挂件 → 通知栏出现「🐋 已通知 Zorv AI」
# 3) 点该通知 → ZorvAI 被拉起
# 4) 对 AI 说「检查挂件」→ AI 应调 visual_question 问「有什么要补充的吗？」
```

---

## 五、进阶（配合 D 方案，出包后可再迭代）

若官方采纳「外部事件唤醒」（见 `ZorvAI-feature-request-外部事件唤醒与钩子.md`），
则通知可升级为**真正一键**：直接把提示塞进会话，连"你说一句"都省掉。

另外可选的本地增强（无需官方改动）：

- **通知带动作按钮**：
  - 「立刻检查」→ 同上拉起 ZorvAI
  - 「复制事件路径」→ `copy:` 风格，方便手动粘贴
- **只在有事件时响**：若 5 秒内已有通知，则更新它而不是重复弹（避免连点刷屏）——
  可用 `nm.notify(NOTI_ALERT_ID, ...)` 天然覆盖（同 id 自动替换），已经天然具备。
