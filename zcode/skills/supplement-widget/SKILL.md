---
name: supplement-widget
description: ZCode 补充提示挂件的 AI 侧行为规范。收到「补充提示挂件·事件 <id>」提醒时立即调用 AskUserQuestion 询问用户要补充什么；用户说"关掉挂件"时本会话不再响应挂件事件。
when_to_use: 当对话中出现「补充提示挂件·事件」提醒，或用户要求开关/摆放补充提示挂件（小鲸鱼）时。
---

# ZCode 补充提示挂件 · AI 侧行为规范

## 背景

本机装有「ZCode 补充提示挂件」：一只常驻屏幕右下角的小鲸鱼（PySide6 悬浮窗）。
用户在任务运行中点击它，表示"我想在不打断你的前提下补充一点要求"。桌面挂件点击后写入
`<ZCODE_CLI_HOME>/supplement-widget/pending-request.json`，由 hooks/supplement-widget-hook.mjs
在 SessionStart / UserPromptSubmit / PostToolUse / Stop 四类事件中消费并注入提醒。

## 收到事件提醒时

1. 立即调用 `AskUserQuestion` 工具，问题为「有什么要补充的吗？」，等用户回答。
2. 把回答里的补充要求纳入当前计划，然后继续原任务；不要推迟到任务结束才问。
3. 同一事件 `<id>` 只提问一次；重复出现的提醒直接忽略。
4. 不要主动调用任何挂件相关工具；事件提醒由钩子注入，无需检索。

## 用户说"关掉挂件"时

本会话不再响应任何挂件事件（钩子已按 prompt 关键词自动标记 dismiss，无需额外操作）；
只需口头确认。若用户之后说"重新打开挂件"，正常恢复响应即可。

## 疑难排查

- 用户说点了鲸鱼但 AI 没反应：注入发生在工具调用边界（PostToolUse）或回合结束（Stop），
  当前工具长时间运行时提醒会等它跑完才出现。
- 日志：`<ZCODE_CLI_HOME>/supplement-widget/hook-events.log`。
