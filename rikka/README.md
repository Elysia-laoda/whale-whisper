# RikkaHub 补充提示挂件 / RikkaHub Supplement Widget

给 RikkaHub Agent（Android）挂一只常驻的小鲸鱼——任务跑得正欢时，点一下就能补一句话，不打断、不等候。

The **RikkaHub Agent (Android)** implementation of this repository. The desktop overlay becomes a
system overlay above every app on the phone, and the external hook processes become an in-process
foreground service plus one callback on the generation loop: no Python, no state files.

## 与其它宿主的关键差别 / Key differences

| | WorkBuddy | ZCode | DSH | **RikkaHub（本目录）** |
| --- | --- | --- | --- | --- |
| 挂件形态 | PySide6 桌面悬浮窗 | PySide6 桌面悬浮窗 | 对话界面内常驻挂件 | **Android 系统悬浮窗**（SYSTEM_ALERT_WINDOW） |
| 接入方式 | 4 个外部钩子进程 | 5 个外部钩子进程 | 进程内 cordis 插件 | **进程内：一个常驻前台服务 + 生成循环回调** |
| 点击 → AI | 写 pending 文件，钩子消费 | 写 pending 文件，钩子消费 | 回环 HTTP → 进程内状态机 | **进程内标志位 → 生成循环的动作边界** |
| 运行时依赖 | Python + PySide6 | Python + PySide6 | 无 | **无**（只多一个前台服务的常驻通知） |
| 兜底手段 | Stop 钩子阻止收尾 | PreToolUse 拒绝其它工具 | turn-stopping 让回合再走一步 | 无需兜底：标志位在**下一个模型请求之前**必然被读到 |
| 目标选择 | 单个窗口 | 单个窗口 | 会话清单 | **正在生成的会话**：一个直接派发、多个弹清单 |

## 机制 / How it works

1. `WhaleOverlayService`（前台服务）用 SYSTEM_ALERT_WINDOW 把鲸鱼画在所有应用之上；拖动位置与隐藏状态存 SharedPreferences（`WhaleStore`）。
2. 点一下 → `ChatService.activeGeneratingConversations()`：**一个**任务在跑就直接派发，**多个**弹清单点选，**一个都没有**气泡提示「现在没有正在跑的任务」。
3. 派发 = 在 `WhaleStore` 给该会话置一个待处理标志；气泡依次显示「已通知 AI ✓」→「它马上就抽空来问你」。
4. `ChatService` 在 `GenerationLoop` 的 `onBeforeModelRequest`（每次模型请求之前，也就是**动作边界**）检查标志；命中就追加一条 user 消息（`WhaleStore.WHISPER_INSTRUCTION`）并清掉标志。
5. agent 照那条指令调用它自己的 `ask_user` 工具问「有什么要补充的吗？」；用户答完，回答作为工具结果回到上下文，agent 带着补充继续原任务。

一次点击只消费一次（`WhaleStore.consume`）。

## 安装 / Install

本版是 fork 的一部分（rikkahub-agent **2.6.2-mod** 起内置），没有单独的安装步骤：

```bash
# 在 rikkahub-agent 仓库根目录
git apply rikka/patches/rikkahub-agent-2.6.2-mod.patch
./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

- 补丁**不含**随包参考资料库的 19.5MB 资产（`assets/wb-library/`，来自 WorkBuddy 借鉴库的 01–06 + 10 分区）；需要时把它们复制进 `app/src/main/assets/wb-library/`。
- `assets/default-skills/whale-whisper/` 随包播种（App 启动时 `SkillManager.seedDefaultSkillsIfNeeded`），并由 `WbLibrarySeeder.BUNDLED_SKILL_NAMES` 对该助手自动启用一次。
- 挂件需要 **SYSTEM_ALERT_WINDOW**（App 清单里本就声明了；系统设置里给它「显示在其他应用上层」）。Android 13+ 还需要通知权限来跑前台服务。
- 常驻通知里点「藏起来」= 关掉挂件。

## 用法 / Usage

| 你做什么 / You do | 发生什么 / What happens |
| --- | --- |
| 平时 | 小鲸鱼常驻屏幕右下角、浮在所有应用之上；拖到顺手的位置，位置自动记住 |
| 有任务在跑时**点一下** | 只有一个任务 → 直接派发；多个 → 弹出清单点选；一个都没有 → 气泡提示 |
| 派发成功 | 气泡「已通知 AI ✓」→「它马上就抽空来问你」 |
| 几秒内 | agent 在下一个动作边界用 `ask_user` 问「有什么要补充的吗？」→ 你自由输入 |
| 补充之后 | agent 用一句话说明据此调整了什么，带着补充继续原任务 |
| **长按** | 点我提问 / 重置位置 / 隐藏小鲸鱼（留一个圆点）/ 关于 |
| 不想要了 | 常驻通知里点「藏起来」 |

## 文件 / Files

| 文件 | 作用 |
| --- | --- |
| `app/.../rikkahub/whale/WhaleOverlayService.kt` | 悬浮窗、拖动、气泡、菜单、派发、前台服务通知 |
| `app/.../rikkahub/whale/WhaleStore.kt` | 每会话待处理标志 + UI 偏好 + 注入文案 |
| `app/src/main/res/drawable/ic_whale.xml` | 原创鲸鱼矢量（与 `dsh/icon.svg` 同一份几何） |
| `app/.../rikkahub/service/ChatService.kt` | `activeGeneratingConversations()` + 动作边界注入 |
| `app/.../rikkahub/data/ai/GenerationLoop.kt` | `onBeforeModelRequest` 现在可以返回替换后的消息列表 |
| `app/.../rikkahub/RikkaHubApp.kt` | 开机（用户没关掉时）拉起挂件服务 |
| `app/src/main/AndroidManifest.xml` | 注册 `WhaleOverlayService`（`specialUse` 前台服务类型） |

## 验证状态 / Verification status

**2026-10-09 · vivo V2156FA（Android 11 / API 30）真机**，rikkahub-agent `2.6.2-mod`（versionCode 189）：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 挂件随包启动 | ✅ | `dumpsys activity services excp.rikkahub` 里 `WhaleOverlayService` `isForeground=true`，通知 id 2003 / channel `whale_widget` |
| 鲸鱼真的画在屏幕上 | ✅ | 真机截图（1080×2408）里鲸鱼与思考气泡浮在聊天界面之上、右侧偏下 |
| 点击 → 提问闭环 | ✅ | 用户本人在真机上点了一下挂件，agent 随即问出「有什么要补充的吗？」并收到回答 |
| 长按菜单 / 拖动记忆 | ✅（拖动） | 拖动后位置写入 SharedPreferences；长按菜单未单独拍照留存 |
| 随包库落盘 | ✅ | 让设备端 agent 自己调用 `list_files /data/data/excp.rikkahub/files/wb-library/`：9 项（`00-README.md` + 01–06、10 分区 + `.asset-version`） |
| agent 能读库 | ✅ | 同一次 `read_file` 读出 `00-README.md` 首行 `# WorkBuddy 借鉴库索引` |
| 五个随包技能已启用 | ✅ | 设备端 agent 自报系统提示里的技能名：`wb-design-verification`、`wb-imagegen-discipline`、`wb-library`、`wb-prompt-patterns`、`whale-whisper` |
| 与 MCP 共存 | ✅ | 经 `adb forward` + `rikka_status` 往返，返回 `version: 2.6.2-mod` |

未单独验证：多个任务同时运行时的选择清单（设备上始终只有一个会话在生成）。

## 与其它宿主共享的约定 / Shared contract

同一句话、同一个交互：**立刻**问、**只问一个问题**「有什么要补充的吗？」、**不给选项**、拿到补充纳入当前计划、用一句话说明调整了什么、**只处理一次**（用户跳过就按原计划继续，不反复追问）。用户说「关掉挂件」→ 本对话不再理会。鲸鱼图形是本项目手绘的原创矢量，四个宿主共用同一份几何。
