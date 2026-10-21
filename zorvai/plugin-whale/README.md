# plugin-whale · 桥接插件

把挂件写在公共区的事件搬进宿主对话的 APK 插件（运行在 ZorvAI 进程内）。

A tiny APK plugin that runs inside the ZorvAI process and moves overlay events into the host conversation.

## 它做什么

1. 每 1.2s 读 `/sdcard/qshare/whale/pending.json`（宿主有 `MANAGE_EXTERNAL_STORAGE`）。
2. 新事件注入**本轮工作副本** `liveBuffers[convId]`（`role=user`、`hidden=true`，用户看不见、LLM 看得见）。
   失败时回落共享 store，再失败才写 `quro_inbox/` 交官方 `QuroInboxWatcher`。
3. 会话空闲时用 `send()` 的隐藏消息通道踢一轮（轮末唤醒）。
4. 注册 `whale_bridge_status` 工具，输出三组探针：事件源 / 注入回读 / 报文复核。

## 构建前置

- **ZorvAI v1.1.10 源码**（需要其中的 `:plugin-contract` 模块做 `compileOnly`）
- JDK 17；SDK 35 或 36

本目录只含模块本身。放进宿主仓库后：

```kotlin
// settings.gradle.kts
include(":plugin-contract", ":plugin-whale")
```

```bash
JAVA_HOME=<jdk17> ./gradlew :plugin-whale:assembleDebug
# 产物 plugin-whale/build/outputs/apk/debug/plugin-whale-debug.apk
```

两处按本机实际环境做的取舍（不是上游代码）：

| 项 | 说明 |
|---|---|
| `compileSdk = 35` | 本机只装了 `platforms/android-35`；上游模块用 36。插件只用 `org.json` / `File` / 线程，35 足够 |
| 无 `signingConfigs` | 用 Gradle 自带的 debug 签名；不作任何自定义签名逻辑 |

## 安装

宿主是官方发布签名（`CN=ZorvAI, OU=Release`），自研插件无法同签，只能走宿主自带调试口：

```
apk_plugin(action="install", path="/sdcard/Download/plugin-whale-debug.apk", skip_signature_check=true)
```

> ⚠️ 这是**本地调试通道**：插件将以非宿主签名运行在宿主进程内、权限等同宿主。仅限自用设备；
> `apk_plugin(action="uninstall", plugin_id="com.zorv.plugin.whale")` 可回退。

装完 **reload 两次 + 等 5 秒**（单次 reload 有时轮询线程不启动）。

## `whale_bridge_status` 字段

| 字段 | 含义 |
|---|---|
| 事件源 | 公共区 / 工作区队列哪个存在 |
| 已搬运 / 直调成功 / 直调失败 | 计数 |
| 最近通道 | `live-buffer` / `shared-store` / `file` |
| 注入后回读 | buf 条数前后、末条、`buf报文`、`归一化后`（含 `toLlmMessages` 与 `normalizeToolCallMessages` 两级）|
| buf现况 | 每 tick 采样本轮 buffer 的 size 与末条 |
| 模型回执 | 注入文案带 `WHALE-ACK-xxxxxx`，扫 assistant 输出是否回执 |
| 复核报文 | buf 尺寸变化即复算，确认标记长期保留 |

判定与限制见 `../docs/插件直调链路实测.md`。
