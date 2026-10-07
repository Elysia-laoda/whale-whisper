# ZCode 补充提示挂件 / ZCode Supplement Widget

给 ZCode 挂一只会传话的小鲸鱼——任务跑得正欢，点一下挂件就能补充提示，不打断、不等候。

Give ZCode a messenger whale — while a long task is running, click the whale to slip in an extra instruction. No interruption, no waiting.

本项目是 [whale-whisper](https://github.com/Elysia-laoda/whale-whisper)（WorkBuddy 版）的 ZCode 移植版：桌面悬浮挂件与钩子注入机制相同，会话枚举与钩子注册改为对接 ZCode 的配置与数据库。上游的"对话内挂件"（MCP App 卡片）依赖宿主渲染 MCP Apps，ZCode CLI 不支持，故未移植。

This is a ZCode port of [whale-whisper](https://github.com/Elysia-laoda/whale-whisper) (the WorkBuddy edition). The desktop overlay and the hook-injection mechanism are the same; session enumeration and hook registration are adapted to ZCode's config and database. The upstream "in-conversation widget" (an MCP App card) relies on the host rendering MCP Apps, which the ZCode CLI does not support, so it is not ported.

## 它解决什么问题 / What problem it solves

AI 在跑长任务时，想中途补充要求（比如"只用中文"、"只处理 2024 年数据"、"别删旧文件"），以前只能干等或打断重来。现在点一下常驻屏幕右下角的小鲸鱼 🐋，AI 会在下一个动作边界停下来，用提问工具问"有什么要补充的吗？"，把补充纳入计划后继续干活。

While the AI is running a long task, adding a requirement mid-flight ("Chinese only", "2024 data only", "don't delete the old files") used to mean waiting or interrupting. Now one click on the whale docked at the bottom-right corner makes the AI pause at the next action boundary, ask "anything to add?" via its question tool, fold the answer into the plan, and keep going.

## 工作原理 / How it works

```
点击小鲸鱼（PySide6 悬浮窗）
    │  写入 <ZCODE_CLI_HOME>/supplement-widget/pending-request.json
    │  （带 sessionHint 定向目标会话，15 分钟内有效）
    ▼
hooks/supplement-widget-hook.mjs  ← 注册在 ~/.zcode/cli/config.json
    │  SessionStart      注入挂件上下文（新会话知道这只鲸鱼存在）
    │  UserPromptSubmit  消费 pending → 注入提问指令；识别"关掉挂件"意图
    │  PostToolUse       消费 pending → 注入提问指令（任务运行中的主路径）
    │  Stop              回合即将结束时兜底消费 → 阻止停止并要求先提问
    ▼
AI 调用 AskUserQuestion 问「有什么要补充的吗？」→ 按回答继续原任务
```

设计原则：绝不打扰、绝不阻塞。钩子在任何异常下都静默退出（exit 0），不会拖住会话。

Design principle: never disturb, never block. Hooks exit silently (exit 0) on any error and never stall the session.

## 安装 / Install

前置要求 / Prerequisites：

- ZCode CLI（钩子通过 `~/.zcode/cli/config.json` 注册）
- Node.js（钩子脚本）
- Python 3 + PySide6（仅桌面挂件需要；`pip install PySide6`）

```bash
git clone <本仓库> zcode-whale-whisper
cd zcode-whale-whisper
node scripts/install.mjs        # 注册 hooks + 安装技能（均自动备份，幂等可重跑）
```

然后双击 `overlay/start-overlay.vbs` 启动小鲸鱼；想开机自启双击 `overlay/enable-autostart.vbs`。

Then double-click `overlay/start-overlay.vbs` to start the whale; double-click `overlay/enable-autostart.vbs` for autostart.

安装后已开启的 ZCode 会话不会立刻加载新钩子，新会话（或重启 ZCode）生效。

Sessions already open at install time do not pick up the new hooks; they load on the next session (or after restarting ZCode).

## 使用 / Usage

- 挂件生命周期跟随 ZCode 桌面端：ZCode 打开时出现在其窗口右下角，关闭/最小化约 3 秒后隐藏；ZCode 回来就跟着回来。ZCode 不在场时保持隐藏（进程常驻待命）。
- 任务运行中点一下小鲸鱼：只有一个活动会话时直接定向通知；检测到多个活动会话时弹出清单点选；没有活动会话时气泡提示。
- 挂件可拖动，位置自动记忆（相对 ZCode 窗口与相对屏幕两套记忆）；右键菜单可重置位置 / 退出。
- 对 AI 说"关掉挂件"，本会话就不再响应挂件事件。
- 请求 15 分钟内有效，超时作废；AI 不追问多半是当前工具还在跑，它会在下一个工具边界看到提醒。

- The whale follows the ZCode desktop app: it docks at the bottom-right of the ZCode window when the app is open, hides about 3 seconds after the app closes or minimizes, and reappears with it. While ZCode is absent the whale stays hidden (the process keeps waiting).
- Click the whale mid-task: with a single active session it notifies directly; with several, a picker opens; with none, a bubble explains.
- The whale is draggable, remembers its position per anchor (ZCode window / screen), and offers reset/exit in the right-click menu.
- Tell the AI "关掉挂件" (turn the widget off) to mute widget events for that session.
- A pending request expires after 15 minutes. If the AI doesn't ask right away, the current tool is still running — it sees the reminder at the next tool boundary.

## 文件结构 / Layout

```
overlay/                  # 桌面鲸鱼：overlay.py（PySide6）、whale.svg、启停与自启 VBS
hooks/                    # supplement-widget-hook.mjs（四类事件的统一钩子，含 --selftest）
skills/supplement-widget/ # SKILL.md，AI 侧行为规范
scripts/                  # install.mjs / uninstall.mjs
```

## 排查 / Troubleshooting

- **点了鲸鱼 AI 没反应**：看 `<ZCODE_CLI_HOME>/supplement-widget/hook-events.log` 有没有 "pending consumed"；有则注入已发生，AI 会在下一个边界提问。会话须在安装钩子之后启动。
- **想核对 ZCode 实际发给钩子的载荷**：设 `SUPPLEMENT_WIDGET_DUMP=<文件>` 环境变量后重启会话，原始 stdin 会追加落盘。
- **钩子分支自测**：`node hooks/supplement-widget-hook.mjs --selftest`。
- **挂件外观离屏验证**：`python overlay/overlay.py --render-test out.png [--state idle|clicked|sessions|badge]`。

- **Clicked the whale, no reaction**: check `<ZCODE_CLI_HOME>/supplement-widget/hook-events.log` for "pending consumed". If present, injection happened and the AI will ask at its next boundary. The session must have been started after the hooks were installed.
- **To inspect the raw payload ZCode sends the hooks**: set `SUPPLEMENT_WIDGET_DUMP=<file>` and restart the session; raw stdin is appended there.
- **Hook branch self-test**: `node hooks/supplement-widget-hook.mjs --selftest`.
- **Offscreen render check for the widget**: `python overlay/overlay.py --render-test out.png [--state ...]`.

## 卸载 / Uninstall

```bash
node scripts/uninstall.mjs   # 移除 hooks + 技能，并通知挂件进程退出
```

之后手工删除开机自启代理：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zc-supplement-widget-overlay.vbs`（或双击 `overlay/disable-autostart.vbs`）。

Then remove the autostart proxy manually: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zc-supplement-widget-overlay.vbs` (or double-click `overlay/disable-autostart.vbs`).

## 与上游的差异 / Differences from upstream

- 挂件跟随 ZCode 桌面端主窗口（按 Electron 窗口类名 `Chrome_WidgetWin_1` + 标题识别），窗口不在场时落在屏幕右下角并保持隐藏；拖动、位置记忆、右键菜单与上游一致。
- 会话枚举来自 ZCode 的 `db.sqlite`（`session` + `model_usage` 两表），"正在活动"= 最近 15 分钟内有模型请求或存在运行中的请求；子代理会话（有 parent）不进清单。
- Stop 钩子的"阻止停止"走 ZCode 的 `decision: block` + `reason` 通道。
- 不含 MCP 服务器与对话内挂件（ZCode CLI 不渲染 MCP Apps 卡片）。

- The overlay follows the ZCode desktop main window (identified by the Electron window class `Chrome_WidgetWin_1` plus the title) and falls back to the screen corner, staying hidden while the app is absent. Dragging, position memory and the context menu match upstream.
- Sessions are enumerated from ZCode's `db.sqlite` (`session` + `model_usage`); "active" means a model request within the last 15 minutes or one still running; subagent sessions (with a parent) are excluded.
- The Stop hook's continuation request goes through ZCode's `decision: block` + `reason` channel.
- No MCP server or in-conversation widget (the ZCode CLI does not render MCP App cards).

## 许可 / License

MIT，见 [LICENSE](LICENSE)。上游项目 [whale-whisper](https://github.com/Elysia-laoda/whale-whisper) 同为 MIT。
MIT; see [LICENSE](LICENSE). The upstream project whale-whisper is MIT as well.
