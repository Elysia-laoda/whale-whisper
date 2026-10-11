# 如何提交这两个 issue 到 ZorvAI 仓库

仓库：https://github.com/Quor-a/ZorvAI ｜ Issue 区：https://github.com/Quor-a/ZorvAI/issues

本次共两份，性质不同，建议**分开发**（一条 bug、一条 feature request）。

---

## ① Bug：visual_question 检索层与执行层不一致

**文件**：`ZorvAI-issue-visual_question检索层不一致.md`

**标题**：
```
[Bug] visual_question 等可视化交互工具「检索不到但能调用」——检索层与执行层不一致，且分类命名误导
```

**要点**：`get_schema("visual_question")` 找不到，但直接 tool call 能成功；它被归入 `ToolCategory.UI_CARDS` 而卡片目录里没有它 → 遵守「禁止猜工具名」规范的 AI 必然找不到它。

---

## ② Feature：外部事件唤醒 / 前置钩子

**文件**：`ZorvAI-feature-request-外部事件唤醒与钩子.md`

**标题**：
```
[Feature] 外部事件唤醒 / 前置钩子：让第三方 App 能主动向 ZorvAI「投递待处理提示」
```

**要点**：ZorvAI 无 hooks（WorkBuddy 有 `PostToolUse`/`Stop`，ZCode 有 `decision:block`）→ 外部点击无法唤醒 AI。
建议最小实现：**约定目录 + FileObserver**（零权限变更），另可考虑广播 / ACI 能力。

---

## 提交方式

### 方式 A：网页（最简单）
1. 打开 https://github.com/Quor-a/ZorvAI/issues/new
2. 标题照抄上面
3. 正文：把对应 md 文件内容整段粘贴
4. 两份分别提交

### 方式 B：gh CLI（装了 GitHub CLI）
```bash
gh issue create --repo Quor-a/ZorvAI \
  --title "[Bug] visual_question 等可视化交互工具「检索不到但能调用」——检索层与执行层不一致，且分类命名误导" \
  --body-file "ZorvAI-issue-visual_question检索层不一致.md"

gh issue create --repo Quor-a/ZorvAI \
  --title "[Feature] 外部事件唤醒 / 前置钩子：让第三方 App 能主动向 ZorvAI「投递待处理提示」" \
  --body-file "ZorvAI-feature-request-外部事件唤醒与钩子.md"
```

### 方式 C：先搜重复
提交前可在 issue 区搜索：`visual_question`、`tool_router`、`UI_CARDS`、`hook`，避免重复。

---

## 小提示

- 两个 issue 里都附了**真机实测数据**（12 次点击全中、三条通道对照表），可复现性强，便于维护者定位
- 如果只发一条，建议**先发 Bug**（它是当前可用性阻塞项）
