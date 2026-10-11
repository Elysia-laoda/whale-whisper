# 📦 包内说明：这份 zip 只装「电脑不知道的东西」

**包名** `whale-widget-zorvai-side.zip`
**打包时间** 2026-10-11
**设备** vivo V2156FA / Android 11 / aarch64 / 未 root / Shizuku uid 2000

---

## 0. 为什么这么打包

电脑端已经能构建 APK（源码在《交接文档》§4），所以：
- ❌ **不收 APK 本体**（电脑已有源码，且已装的那份就是它构建的）
- ✅ **只收 ZorvAI 手机端独有的东西** —— 电脑那边从未见过、也跑不出来的部分

---

## 1. 什么是「电脑不知道的」

| # | 内容 | 为什么电脑不知道 |
|---|---|---|
| 1 | **ZorvAI 侧实现**：ToolPkg（`packages/whale`）+ 技能（`skills/whale`） | 这是 ZorvAI 特有的扩展机制，电脑端没有这套东西 |
| 2 | **沙箱能力实测**：`canReadQshare:false` / `canWriteWorkspace:true` | 只有在本机沙箱里跑才测得出，它决定了整个架构 |
| 3 | **三段桥架构**：APK → 公共区 → proot 搬运 → 工作区 → ToolPkg | 由 (2) + Android 11 分区存储共同逼出来的方案 |
| 4 | **真机运行证据**：包已装、权限 allow、前台服务在跑、真机点击事件 JSON | 只有真机能产生 |
| 5 | **proot 桥脚本** `whale-sync` / `whale-click` | 手机端特有（proot 是唯一能同时访问公共区与工作区的进程） |
| 6 | **事件契约的实际落地路径与格式** | 电脑只能按契约写，落点由手机决定 |

---

## 2. 包内目录

```
whale-widget/
├── ZorvAI-whale-widget-移植交接文档.md     # 电脑端构建用（920 行，含 APK 全部源码 + §12 手机侧实测）
├── 小鲸鱼挂件-本体所做一切.md               # 本体行为说明书（它做什么/不做什么/权限边界）
├── README-包内说明.md                       # 本文件
├── zorvai-side/                             # ★ 手机侧独有实现
│   ├── whale-pkg/{manifest.json,index.js}   # ToolPkg（4 个工具）
│   ├── whale-skill/{whale.skill.json,whale.prompt.txt}  # 技能规则（含「必须用可点选组件提问」）
│   ├── whale-click                          # 模拟点击（联调）
│   └── whale-sync                           # 公共区 → 工作区 搬运
└── evidence/                                # ★ 真机实测原始输出
    ├── 01-真机环境.txt
    ├── 02-whale-sync输出.txt
    ├── 03-公共区pending.json
    ├── 04-工作区队列.json
    └── 05-技能规则快照.txt
```

---

## 3. 电脑端怎么对接（三步）

1. **构建 APK**：按《交接文档》§4 的源码 + §7 的安装授权命令
2. **让 APK 写事件**到 `/sdcard/qshare/whale/pending.json`（格式见《交接文档》§5.2）
   - 想省掉搬运：申请 `MANAGE_EXTERNAL_STORAGE`，直接写
     `/sdcard/Android/data/com.ai.assistance.quro/files/QuroWorkspace/whale-whisper/state/pending.json`
3. **ZorvAI 侧零改动** —— 接收端已在手机上跑通（技能里已内置「先 `whale-sync` 再 `whale_pending`」）

---

## 4. 已跑通的证据链（手机实测）

```
[点击鲸鱼] → APK 写公共区 {id:"w1791698791960", source:"android-overlay"}
           → whale-sync 搬进工作区队列
           → whale_pending 读到 count=2
           → AI 提问 → whale_ack → remaining 0（去重生效）
```

**真机验收**：`package:com.zorv.whale` 已装 · `SYSTEM_ALERT_WINDOW: allow` ·
进程 `u0_a303 pid 21562` · 前台服务 `com.zorv.whale/.OverlayService` 在跑。

---

## 5. 许可

上游 whale-whisper 为 MIT（作者 Elysia-laoda）；本包建议同样以 MIT 发布并保留上游署名。
