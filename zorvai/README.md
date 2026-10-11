# ZorvAI 补充提示挂件 / ZorvAI Supplement Widget

给 ZorvAI（Android，`com.ai.assistance.quro`）挂一只常驻屏幕的小鲸鱼 🐋：任务跑得正欢时点一下它，AI 在下一个动作边界问你「有什么要补充的吗？」。

The **ZorvAI (Android)** implementation of this repository — the third Android-side port after RikkaHub. A resident system overlay on the phone, a public event file it writes to, and a ToolPkg + skill pair inside ZorvAI that reads it back.

## ⚠️ 先读这条：这个宿主没有钩子，「点一下立刻」做不到 / Read this first: no hooks, so "instant" is impossible

ZorvAI 目前**没有任何外部事件注入机制**——没有 WorkBuddy 的 `PostToolUse` / `Stop`，也没有 ZCode 的 `decision:block`。第三方 App 无法让 ZorvAI「在下一步动作时」主动处理一条提示。

本移植的真机实测结论很干脆：**采集链路一条不丢（连点 12 次，12 条事件全部被 AI 读到），但点击之后 AI 不会自己醒** —— 必须等用户再发一条消息，AI 才会在轮首检查时接住那条事件。用户感受到的就是「点了没反应、不灵敏」。

想在这个宿主上做到**接近即时**，只有一条路：让 AI **每一步都去审查一次请求**——每轮回复前、或每个工具调用之后，都先查一次事件队列。代价是**持续消耗 token**：这套检查只要开始了，就会跟着每一次模型请求重复执行，任务越长、工具调用越多，烧掉的 token 越多；改用定时轮询（例如 5 分钟一次）同样要烧，约 **288 次无效调用/天**。换句话说，**「即时性」在这个宿主上是用 token 换的，而且换来的也只是「下一步就查」，不是真正的打断。**

所以本移植的定位是：**采集与读取做扎实，即时性如实承认做不到**；上游已经把这两个缺口分别提成 issue（[#12 检索层不一致](https://github.com/Quor-a/ZorvAI/issues/12)、[#13 外部事件唤醒/前置钩子](https://github.com/Quor-a/ZorvAI/issues/13)），等宿主补上钩子后，这一版可以不改交互、只改触发。

ZorvAI has **no external event injection**: no `PostToolUse` / `Stop` like WorkBuddy, no `decision:block` like ZCode. In real-device testing the capture path never lost an event (12 taps, 12 events read), but **the AI never wakes up on its own** — the user must send one more message before the agent checks the queue. The only way to get close to instant is to make the model **review the queue on every step**, which **burns tokens continuously**; polling on a timer costs the same (about 288 wasted calls per day at a 5-minute interval). Instantaneity here is bought with tokens, and what you buy is "checked on the next step", not a real interrupt.

## 与其它宿主的差别 / Key differences

| | WorkBuddy | ZCode | DSH | RikkaHub | **ZorvAI（本目录）** |
| --- | --- | --- | --- | --- | --- |
| 挂件形态 | PySide6 桌面悬浮窗 | PySide6 桌面悬浮窗 | 对话界面内挂件 | Android 系统悬浮窗 | **Android 系统悬浮窗** |
| 接入方式 | 4 个外部钩子进程 | 5 个外部钩子进程 | 进程内 cordis 插件 | 进程内前台服务 + 生成循环回调 | **无钩子：技能规则每轮自查 + proot 搬运** |
| 点击 → AI | 写 pending 文件，钩子消费 | 写 pending 文件，钩子消费 | 回环 HTTP → 状态机 | 进程内标志位 → 模型请求前 | **写公共文件 → 每轮搬运 → 下一轮才被读到** |
| 即时性 | 下一个工具调用 | 下一个工具调用 | 下一个动作边界 | 下一个模型请求之前 | **下一轮（用户再说话才会到）** |
| 代价 | 无额外 | 无额外 | 无额外 | 无额外 | **要即时就得每步审查请求，持续烧 token** |

| | WorkBuddy | ZCode | DSH | RikkaHub | **ZorvAI (this dir)** |
| --- | --- | --- | --- | --- | --- |
| Widget | PySide6 desktop overlay | PySide6 desktop overlay | in-page widget | Android system overlay | **Android system overlay** |
| Wiring | 4 external hook processes | 5 external hook processes | in-process cordis plugin | in-process foreground service + loop callback | **no hooks: skill self-check each turn + proot relay** |
| Tap → AI | pending file, consumed by hooks | pending file, consumed by hooks | loopback HTTP → state machine | in-process flag → before next model request | **public file → relayed each turn → read one turn later** |
| Latency | next tool call | next tool call | next action boundary | before the next model request | **next turn (only after the user speaks again)** |
| Cost | none | none | none | none | **instantaneity requires a per-step review that burns tokens** |

## 三段桥 / The three-stage bridge

```
[点击鲸鱼]
   ↓  悬浮窗 APK 写事件（读-追加-原子改名）
/sdcard/qshare/whale/pending.json        ← 公共区：第三方 App 与 proot 都够得着
   ↓  whale-sync（proot，唯一同时够得着公共区和工作区的进程）
QuroWorkspace/whale-whisper/state/pending.json   ← 工作区：ToolPkg 只读得到这里
   ↓  whale_pending（技能规则里规定每轮先查）
[AI 提问 → 用户作答 → whale_ack 去重]
```

为什么必须绕这一圈：实测 ToolPkg 沙箱**读不到公共区**（`canReadQshare:false`），而 Android 11 的分区存储让第三方 App **写不进工作区**（即使 `MANAGE_EXTERNAL_STORAGE` 已 `appops allow`，FUSE 仍挡住跨 App 的 `Android/data` 写入——本版实测确认，交接文档里「直写工作区可跳过搬运」那条只存在于纸面）。proot 是唯一两边都能碰的进程。

```
[tap the whale] → overlay APK writes the event (read-append-atomic rename)
/sdcard/qshare/whale/pending.json        ← public area, reachable by both the APK and proot
   → whale-sync (proot) → QuroWorkspace/whale-whisper/state/pending.json   ← the only place ToolPkg can read
   → whale_pending (checked at the start of every turn) → the AI asks → whale_ack dedupes
```

## 目录 / Layout

| 路径 | 内容 |
| --- | --- |
| `whale-overlay/` | 悬浮窗 APK 的可编译工程（v1.1.1，Java，Gradle 9.5.0 + AGP 9.3.1） |
| `zorvai-side/whale-pkg/` | ToolPkg：`whale_pending` / `whale_ack` / `whale_simulate` / `whale_state` |
| `zorvai-side/whale-skill/` | 技能规则（含「必须用 `visual_question` 工具提问，不能当卡片下发」） |
| `zorvai-side/whale-sync` | proot 侧搬运脚本（公共区 → 工作区） |
| `zorvai-side/whale-click` | proot 侧模拟点击（无 APK 时联调） |
| `docs/` | 交接文档、本体说明书、B 方案规格、包内说明（手机侧原文，未改动） |
| `evidence/` | 真机实测原始输出（环境、搬运输出、两侧队列、技能规则快照） |

## 构建与安装 / Build and install

```bash
cd whale-overlay
./gradlew :app:assembleRelease        # 产物 app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell appops set com.zorv.whale SYSTEM_ALERT_WINDOW allow
adb shell appops set com.zorv.whale MANAGE_EXTERNAL_STORAGE allow   # 可选；实测写工作区仍会被 FUSE 挡
adb shell cmd deviceidle whitelist +com.zorv.whale                  # vivo 后台冻结较激进
```

打开 App → 「③ 启动挂件」→ 屏幕上出现小鲸鱼。点它：事件写进公共区，同时弹一条高优先级「唤醒通知」，点通知即可把 ZorvAI 拉到前台（这是无钩子宿主下能给出的最接近「叫醒」的手段）。

签名：工程不在仓库里放任何口令；构建时用环境变量 `WHALE_KEYSTORE_PROPS` 指向一个外部 properties（`storeFile` / `storePassword` / `keyAlias` / `keyPassword`），文件不存在时退回 debug 签名。

## 两个已修的坑 / Two bugs this port already fixed

1. **Android 11 包可见性**：targetSdk 30+ 若不在清单里写 `<queries><package android:name="com.ai.assistance.quro" /></queries>`，`getLaunchIntentForPackage()` 直接返回 `null`，于是通知的 `PendingIntent` 建不出来——现象是通知正常弹出、点它毫无反应，`dumpsys notification` 里 `contentIntent=null`。
2. **事件文件格式**：公共区实际用的是 `{"events":[{id,ts,source,state,note}],"acked":[],"mute":false}` 队列（交接文档 §5.2 写的是单事件对象）。本版按现场格式实现成「读-追加-原子改名」，因此不会冲掉还没同步的旧事件。

## 实测证据 / Evidence

| 环节 | 结果 |
| --- | --- |
| 悬浮窗可见 | `dumpsys window` 里有 192×192 的 `APPLICATION_OVERLAY` 窗口；截图可见 |
| 拖动 + 位置记忆 | 拖到右边缘 (864,1106)，`force-stop` 重启后仍在原位 |
| 点击写事件 | 新事件进入队列，旧事件保留，无 `.tmp` 残留 |
| 唤醒通知 | `whale_alert` 渠道（IMPORTANCE_HIGH + 振动），`contentIntent` 非空 |
| 点通知拉起 ZorvAI | 真机实测：`mResumedActivity` 变为 `com.ai.assistance.quro/.activity.QuroMainActivity` |
| 采集不丢 | 连点 12 次 → 12 条事件全部被 AI 读到（手机侧实测，见 `evidence/`） |
| 即时性 | **做不到**：必须用户再发一条消息才会被读到 |

## 许可 / License

上游 whale-whisper 为 MIT（作者 Elysia-laoda）；本移植同样以 MIT 发布并保留上游署名。ZorvAI 侧实现（ToolPkg / 技能 / proot 脚本）与 APK 源码均在本目录内。

MIT, same as upstream. The ZorvAI-side implementation (ToolPkg, skill, proot scripts) and the APK source both live in this directory.
