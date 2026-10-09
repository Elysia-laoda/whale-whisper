# 端到端自测（真实 harness）

`tests/` 用替身上下文验证逻辑；这里用**真实的 DSH 运行时 + 真实的 agent 循环**验证投递链。

## 它验证什么

| 检查项 | 期望 |
| --- | --- |
| 插件装载 | 无 web 服务器的档案里也激活（不再出现 "entry did not activate"） |
| `ctx.get('whisperWhale')` | 服务可读，`click()` 返回 `ok:true` 与事件 id |
| `agent/created` | 会话开头上下文确实进入了真实请求 |
| `agent/pre-step` | 事件提醒合并进了这一步的入参消息，且 eventId 与点击一致 |
| `tools/post-execute` | 真实 waterfall 返回 2 个 context（本插件的 + 下游的），下游的没被吃掉 |
| `agent/turn-stopping` | 用真实 `agentEvents` 派发器跑一遍，挂件状态 queued → delivered |
| 单次投递 | 一条事件只会被一条路径消费，第二条路径拿到的是空 |

## 前置：一份可读的 DSH 运行时

安装版把运行时压在一个 asar 里，Node 读不了；先解出来：

```bash
node e2e/extract-runtime.mjs --asar "D:/DSH/resources/app.asar" --out D:/dshproject/_ref/dsh-runtime
```

## 跑

```bash
node e2e/run.mjs --runtime D:/dshproject/_ref/dsh-runtime --home D:/dshproject/_e2ehome
```

脚本会：从 `headless` 模板建一个临时档案 → 装驱动 + 装本插件（顺序很重要：驱动必须先注册，
在 waterfall 里才是外层）→ 跑一次只发一句「你好」的任务 → 打印 stderr 里的 `[e2e]` 行 → 清理。

**不需要 API key**：`agent/pre-step` 在模型调用之前就会跑，而 `tools/post-execute` /
`agent/turn-stopping` 由驱动用真实 cordis API 直接触发。任务最后会因为缺凭据报
`MISSING_CREDENTIAL` 退出 —— 那是预期的，不影响上面的断言。

> 想在真实任务里看到 AI 真的开口问「有什么要补充的吗？」，需要一份能用的模型凭据。
> 把 `--api-key` 传进来即可（脚本会以 `DEEPSEEK_API_KEY` 注入子进程环境）。

## 输出长什么样

```
[e2e] agent created: session-… (delay=0ms)
[e2e] click -> {"ok":true,"eventId":"w-0t2suz-b09",…}
[e2e] probe turn-stopping: click ok=true, phase=queued
[e2e] probe turn-stopping: 派发之后 phase=delivered
[e2e] PASS post-execute 注入了事件提醒 (tool=e2e-probe, eventId=w-0t2tpx-t7h)
[e2e] waterfall tools/post-execute -> kind=result, contexts=2, ours=w-0t2tpx-t7h, theirsKept=true
[e2e] PASS 会话开头上下文已进入请求
[e2e] PASS pre-step 收到事件提醒，eventId=w-0t2tha-fdo

  ✔ click 成功派发
  ✔ 会话开头上下文进入请求
  ✔ pre-step 投递
  ✔ post-execute 投递
  ✔ post-execute 保留下游 context
  ✔ turn-stopping 兜底投递

e2e: 全部通过
```

## 踩过的坑（改这里之前先看）

- **不要用 `fs.rmSync(path, { recursive: true })` 删带链接的目录。** 用 `--link` 安装造出来的是
  目录联接（junction），Windows 上 rmSync 会**穿透**它去删真正的目标 —— 这个跑手真的因此删过
  一次插件源码。所以统一走 `scripts/profile-io.mjs` 的 `removeTree()`。
- **驱动必须排在 whisper-whale 前面。** cordis 的 waterfall 按注册顺序串：先注册的在外层，
  `await next()` 之后才能看到内层（本插件）合并出来的结果。
- **读服务要用 `ctx.get('whisperWhale')`。** 没写进 `inject` 时直接读 `ctx.whisperWhale` 会被
  cordis 拒绝（"cannot get property ... without inject"）。
