# 补充提示挂件 · Supplement Widget

> 🐋 **Whisper to your running AI.** 给正在干活的 AI 递悄悄话——点一下挂件，AI 停下来问你「有什么要补充的吗？」，不打断、不等候。
>
> [![WorkBuddy](https://img.shields.io/badge/WorkBuddy-Plugin-2f7de1)](#) [![MCP Apps](https://img.shields.io/badge/MCP-Apps-8a63d2)](#) [![PySide6](https://img.shields.io/badge/UI-PySide6-41cd52)](#) [![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-6b7280)](#) [![License](https://img.shields.io/badge/license-MIT-f59e0b)](#)

> 一只常驻屏幕右下角的小鲸鱼 🐋（可拖动、可换位置）。
> 任务跑得正欢时你突然想补一句提示词？**点一下它，AI 立刻停下来问你：「有什么要补充的吗？」**
> 不用强行打断它，也不用等它全干完。

参考交互设计：[DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（DSH 右下角小鲸鱼常驻挂件）。

本插件提供**两种形态**：

| 形态 | 是什么 | 位置 |
| --- | --- | --- |
| **桌面版小鲸鱼**（推荐，默认） | 独立桌面悬浮窗：置顶、无边框、跟随 WorkBuddy 窗口右下角、可自由拖动（位置自动记忆） | 屏幕右下角 |
| **对话内挂件**（按需） | MCP App 卡片，渲染在对话消息里 | 对话流中（宿主不支持 pip 悬浮，所以它拖不动——要"可拖动的常驻挂件"请用桌面版） |

两种形态点击后效果一致：AI 在下一个动作里调用提问功能问你「有什么要补充的吗？」。

---

## 它解决什么问题

AI 正在跑一个长任务（写长文档、批量处理、大型开发……），你中途想到：

- 「输出记得用中文，别提英文术语」
- 「刚才那个范围和我说错了，只处理 2024 年的数据」
- 「先别删旧文件，我要留备份」

以前只有两条路：**忍着等它做完** 或 **强行打断重来**。
现在：**点一下挂件** → AI 在下一个动作里先调用提问功能 → 你把补充丢给它 → 它把补充纳入计划继续干活。

## 桌面版挂件 · 使用

放在 `overlay/` 目录，双击对应脚本即可（无需命令行）：

| 操作 | 文件 | 说明 |
| --- | --- | --- |
| 启动 | `overlay/start-overlay.vbs` | 出现在 WorkBuddy 窗口右下角；之后跟随窗口移动 |
| 停止 | `overlay/stop-overlay.vbs` | 也可右键挂件 → 「退出挂件」 |
| 开机自启 | `overlay/enable-autostart.vbs` | 在启动文件夹放一个代理脚本（可随时取消） |
| 取消自启 | `overlay/disable-autostart.vbs` | |

交互：

- **左键单击**：
  - 只有 1 个"**正在工作中**"的对话 → 直接定向通知（气泡「已通知 AI ✓」）；
  - 检测到多个工作中对话 → 卡片右上角出现蓝色数字角标，点击后**展开对话清单**（任务标题 + 最近活跃时间），点选要注入哪个对话；
  - 没有工作中对话 → 气泡提示（AI 已经停下时，直接在对话框输入即可）；
- **按住拖动**：放到任意位置，自动记忆（相对 WorkBuddy 窗口右下角保存）；
- **右键**：菜单（重置位置 / 退出挂件）；
- **生命周期跟随 WorkBuddy**：WorkBuddy 打开/从最小化恢复 → 挂件出现；关闭/最小化 → 约 3 秒后自动隐藏（进程保留、随时归来）；
- WorkBuddy 窗口移动、缩放都会跟随。
- 开机自启已默认配置（启动文件夹里的代理脚本），登录 Windows 后挂件随 WorkBuddy 一起出现。

依赖：Python + PySide6（启动脚本会自动找 `~/.workbuddy/binaries/python/envs/hwime` 等常见位置的 pythonw；找不到时会弹提示，`pip install PySide6` 即可）。

## 点击 → AI 的链路原理

**桌面版**（不需要对话里有任何东西）：

```
点击桌面小鲸鱼
   │  （多个"工作中"对话时先弹出选择清单，由你点选目标对话）
   │  写 overlay → ~/.workbuddy/supplement-widget/pending-request.json
   │  （带 sessionHint：精确锁定你选的对话，避免多任务串台）
   ▼
引擎钩子（PostToolUse / Stop / UserPromptSubmit）
   │  消费 pending 文件 → 以 additionalContext 注入：
   │  「【补充提示挂件·事件 <id>】用户按下了挂件……请立即调用 AskUserQuestion」
   ▼
AI 在下一个动作里调用 AskUserQuestion：「有什么要补充的吗？」
   │
   └─ 用户回答 → AI 把补充纳入计划 → 继续原任务
```

**目标会话的判定规则**：只列 `status=working` 的对话——历史对话不断累积也不会让清单变臃肿；一个都没有时不会瞎猜目标。

**对话内版**（`open_supplement_widget`）：点击后走 MCP App 通道 —— `updateModelContext`（系统提醒，下一次模型调用可见）+ `sendMessage`（回写用户消息），同样携带 `事件 <id>` 供 AI 去重。

共同约定：

- **事件 ID 去重**：同一 id 只问一次；
- **不会硬中断**：AI 会让"当前正在执行的单个工具"跑完，立刻提问；
- **任务结束时兜底**：Stop 钩子发现未消费的点击，会阻止收尾并提示 AI 先提问。

## 钩子（hooks）总览

插件在 `~/.workbuddy/settings.json` 注册（脚本：`hooks/supplement-widget-hook.mjs`，纯 Node、毫秒级、永不阻塞）：

| 事件 | 做什么 |
| --- | --- |
| `SessionStart` | 会话开头注入挂件上下文（含"收到事件必须立即提问"、"不要主动打开对话内挂件"） |
| `UserPromptSubmit` | 识别「关掉挂件」意图（本会话闭嘴）+ 消费待处理请求 |
| `PostToolUse`（matcher `*`） | **主路径**：任务运行中消费待处理请求并注入提问指令；识别对话内挂件已打开 |
| `Stop` | 回合将结束时若发现未消费的点击 → 阻止停止并提示提问 |

状态目录：`~/.workbuddy/supplement-widget/`（`hook-state.json` 会话状态、`pending-request.json` 待处理请求、`overlay-pos.json` 挂件位置、`hook-events.log` 事件日志）。

## 目录结构

```
wb-supplement-widget/
├── overlay/                        # ★ 桌面版小鲸鱼
│   ├── overlay.py                  # 主程序（PySide6：置顶/透明/拖动/跟随/记忆/点击触发）
│   ├── whale.svg                   # 鲸鱼矢量图
│   ├── start-overlay.vbs           # 启动（双击）
│   ├── stop-overlay.vbs            # 停止（双击）
│   ├── enable-autostart.vbs        # 开机自启（双击）
│   ├── disable-autostart.vbs       # 取消自启（双击）
│   └── autostart-proxy.template.vbs
├── mcp-server/
│   ├── server.js                   # MCP 服务器（stdio）：工具 open_supplement_widget + UI 资源
│   ├── widget/
│   │   ├── widget.template.html    # 对话内挂件源码
│   │   └── widget.html             # 构建产物（内联 ext-apps，离线可用）
│   ├── test-server.mjs             # 协议自测
│   └── package.json
├── hooks/
│   └── supplement-widget-hook.mjs  # 总钩子（SessionStart / UserPromptSubmit / PostToolUse / Stop）
├── skills/
│   └── supplement-widget/SKILL.md  # 技能：AI 侧的行为规范
├── scripts/
│   ├── build-widget.mjs            # 重建 widget.html
│   ├── install.mjs                 # 一键安装（MCP 注册 + 技能 + 权限放行 + hooks 注册）
│   └── uninstall.mjs               # 一键卸载
├── .codebuddy-plugin/plugin.json   # 插件清单（发布形态预留）
└── .mcp.json                       # 插件形态的 MCP 声明（发布形态预留）
```

## 安装

### 一键安装（推荐）

```bash
node scripts/install.mjs
```

脚本做四件事（每个文件写前自动备份 `.bak-<时间戳>`）：

1. 在 `~/.workbuddy/mcp.json` 注册 MCP 服务器 `supplement-widget`（用当前 node 的绝对路径）；
2. 把技能复制到 `~/.workbuddy/skills/supplement-widget`；
3. 在 `~/.workbuddy/settings.json` 的 `permissions.allow` 里放行 `mcp__supplement-widget`（加 `--no-settings` 可跳过）；
4. 在 `~/.workbuddy/settings.json` 的 `hooks` 里注册四个事件（加 `--no-hooks` 可跳过）。

桌面挂件不需要安装脚本 —— 直接双击 `overlay/start-overlay.vbs` 就能用（想开机自启再双击 `enable-autostart.vbs`）。

### 安装后必做：信任连接器（只影响"对话内版"）

打开 **WorkBuddy → 连接器管理页 → 右上角「自定义连接器」**，找到 `supplement-widget`，点 **Trust / 启用**。之后新会话生效。

### 手动安装（关键片段）

`~/.workbuddy/mcp.json`：

```json
{
  "mcpServers": {
    "supplement-widget": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\WBproject\\wb-supplement-widget\\mcp-server\\server.js"]
    }
  }
}
```

`~/.workbuddy/settings.json` 的 hooks（路径换成实际路径）：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/WBproject/wb-supplement-widget/hooks/supplement-widget-hook.mjs\"", "timeout": 15 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/WBproject/wb-supplement-widget/hooks/supplement-widget-hook.mjs\"", "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/WBproject/wb-supplement-widget/hooks/supplement-widget-hook.mjs\"", "timeout": 15 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/WBproject/wb-supplement-widget/hooks/supplement-widget-hook.mjs\"", "timeout": 15 }] }
    ]
  }
}
```

## 使用

| 时机 | 你说 / 你做 | 发生什么 |
| --- | --- | --- |
| 平时 | 双击 `start-overlay.vbs`（或开机自启） | 小鲸鱼常驻右下角（拖到顺手的位置即可） |
| 任务运行中 | **点一下小鲸鱼** | 单对话直接通知；多对话先弹清单选目标 → 几秒内 AI 调用提问功能问你「有什么要补充的吗？」 |
| 补充后 | 直接输入你的补充 | AI 简述调整后的计划，带着补充继续 |
| 不想要了 | 说「关掉挂件」 | 本会话闭嘴（不再处理挂件事件）；退出桌面挂件用右键→退出 |
| 想在对话里挂一个 | 说「把挂件放到对话里」 | AI 调用 `open_supplement_widget` 渲染对话内卡片 |

## 验证清单（首次使用）

1. 双击 `overlay/start-overlay.vbs` → 右下角出现小鲸鱼，可拖动、位置重启后保留；
2. 在某个任务运行中（或随便让我干个多步活）点一下小鲸鱼 → 鲸鱼冒泡「已通知 AI ✓」；
3. 几秒内我弹出提问卡片「有什么要补充的吗？」；
4. 回答「补充：xxx」→ 我把 xxx 纳入计划并继续；
5. 右键小鲸鱼 → 「退出挂件」→ 消失；`stop-overlay.vbs` 同样可停。

任意一步不符合预期，见下方 FAQ。

## FAQ

**Q：点「悬浮」提示不支持？**
WorkBuddy 桌面端宿主目前不支持 MCP App 的 pip 悬浮（已实测确认），所以对话内挂件拖不动——**要常驻可拖动的挂件请直接用桌面版**（`overlay/start-overlay.vbs`）。对话内挂件的悬浮按钮会自动禁用并给出提示。

**Q：点了小鲸鱼，AI 没反应？**
- 确认小鲸鱼在跑（任务栏无窗口，但右键菜单能弹出说明活着；不在就跑 `start-overlay.vbs`）；
- 注入发生在"下一个工具调用/回合结束"边界：如果 AI 正在执行一个很长的单步工具（比如跑一个几分钟的命令），它会在这一步结束后立刻提问（设计如此）；
- 如果 AI 全程空闲（没有任务在跑），点击会等到你下一次发消息时由 AI 补问；
- 查日志：`~/.workbuddy/supplement-widget/hook-events.log`（消费记录）、`overlay.log`（挂件侧，需 `SUPPLEMENT_WIDGET_DEBUG=1`）。

**Q：同时开多个任务，点挂件会去哪个任务？**
点击时会检测所有"**正在工作中**"的对话：
- 只有一个 → 直接定向注入；
- 有多个 → 挂件展开清单（任务标题 + 最近活跃时间），**由你点选**要注入哪个对话；请求会精确锁定该对话，其他任务不会抢答；
- 经验：历史对话、已完成任务不会被列出，清单不会随对话数量增长而臃肿。

**Q：挂件会跟着 WorkBuddy 开关吗？**
会。WorkBuddy 打开/恢复 → 挂件出现；WorkBuddy 关闭/最小化 → 挂件约 3 秒后自动隐藏。挂件进程常驻（很轻），所以 WorkBuddy 重新打开时它能立刻回来；彻底退出用右键菜单→退出挂件。

**Q：目标对话一直空闲，请求会怎样？**
请求 15 分钟内有效：目标对话下一次活动（发消息/工具调用/回合结束）时交付；超时自动作废。若 AI 已经停下手上没活，直接在对话框输入更直接。

**Q：多个屏幕 / 缩放？**
默认跟随 WorkBuddy 主窗口右下角；拖到别的屏幕也可以，位置会记住。

**Q：第一次用对话内版弹权限确认？**
MCP 工具默认需要授权。装的时候放行了 `mcp__supplement-widget` 就不会弹；也可以在弹窗里选「始终允许」。

**Q：历史消息里对话内挂件变成占位块？**
宿主对历史 widget 默认收起（安全策略），点开即可重新加载。

**Q：怎么卸载？**
```bash
node scripts/uninstall.mjs
```
会移除 mcp.json 注册项、技能目录、allow 规则和 hooks 注册（均自动备份）。桌面挂件直接删掉整个 `overlay/` 文件夹即可；记得先双击 `disable-autostart.vbs`。

**Q：钩子会让 AI 干多余的事吗？**
不会。常规事件静默秒过；只有"会话开头一次上下文注入"和"点击挂件后的提问指令"两种可见输出。一切异常静默跳过，不会拖慢或阻塞会话。

## 二次开发

- **桌面挂件外观/行为**：`overlay/overlay.py`（颜色、尺寸、气泡文案 `CLICK_SEQ`、默认偏移 `DEFAULT_OFFSETS`）；
- **桌面挂件图标**：`overlay/whale.svg`；
- **注入文案**：`hooks/supplement-widget-hook.mjs` 的 `SESSION_TEXT` / `pendingText()`（改完即生效）；
- **对话内挂件**：改 `widget.template.html` 后必须重建 —— `node scripts/build-widget.mjs`；
- **自测**：`node mcp-server/test-server.mjs`（MCP 协议）；钩子可用假输入直接喂，例如：
  `echo '{"hook_event_name":"SessionStart","session_id":"t1"}' | node hooks/supplement-widget-hook.mjs`。

## 技术备注

- 桌面挂件：PySide6 画布自绘（圆角/阴影/气泡/鲸鱼动画），`WA_TranslucentBackground + WindowStaysOnTopHint + Qt.Tool`；通过 Win32 `EnumWindows/GetWindowRect` 跟随 WorkBuddy 主窗口；单实例用命名互斥体；启停脚本为 UTF-16 LE 编码的 .vbs（Windows 脚本宿主要求）。
- 对话内挂件 HTML **完全离线**：`@modelcontextprotocol/ext-apps@1.7.5` 客户端库已内联；CSP 无外部域名；约 330KB（超过 256KB 预取阈值时宿主自动运行时拉取）。
- 钩子读取位置：`~/.workbuddy/settings.json` 的 `hooks` 字段（配置目录可用 `WORKBUDDY_CONFIG_DIR` 覆盖），经 Git Bash 执行命令（node 使用绝对路径）。
- MCP 服务器只写 stderr 日志，协议纯净。
