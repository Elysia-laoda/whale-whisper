#!/usr/bin/env node
/**
 * install.mjs — 一键安装「补充提示挂件」
 *
 * 做了三件事（每步写文件前自动备份）：
 *   1. 在 ~/.workbuddy/mcp.json 注册 MCP 服务器 supplement-widget
 *   2. 复制技能到 ~/.workbuddy/skills/supplement-widget
 *   3. 在 ~/.workbuddy/settings.json 的 permissions.allow 里放行 mcp__supplement-widget
 *      （避免每次调用都弹权限确认；加 --no-settings 跳过）
 *
 * 用法：
 *   node scripts/install.mjs
 *   node scripts/install.mjs --no-settings
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const home = os.homedir();
const wbDir = path.join(home, '.workbuddy');

const args = new Set(process.argv.slice(2));
const noSettings = args.has('--no-settings');
const noHooks = args.has('--no-hooks');

const pad = (n) => String(n).padStart(2, '0');
function ts() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function backup(p) {
  if (!fs.existsSync(p)) return;
  const b = `${p}.bak-${ts()}`;
  fs.copyFileSync(p, b);
  console.log('  [backup]', path.basename(p), '->', path.basename(b));
}

/* ---------- 0. 前置检查 ---------- */
const serverJs = path.join(root, 'mcp-server', 'server.js');
const widgetHtml = path.join(root, 'mcp-server', 'widget', 'widget.html');
const sdkDir = path.join(root, 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk');

if (!fs.existsSync(serverJs)) { console.error('✗ 缺少 mcp-server/server.js'); process.exit(1); }
if (!fs.existsSync(sdkDir)) {
  console.error('✗ 依赖未安装。请先执行：cd mcp-server && npm install');
  process.exit(1);
}
if (!fs.existsSync(widgetHtml)) {
  console.error('✗ 挂件未构建。请先执行：node scripts/build-widget.mjs');
  process.exit(1);
}

fs.mkdirSync(wbDir, { recursive: true });
console.log('安装「补充提示挂件」到', wbDir);

/* ---------- 1. 注册 MCP 服务器 ---------- */
const mcpPath = path.join(wbDir, 'mcp.json');
let mcp = {};
if (fs.existsSync(mcpPath)) {
  const raw = fs.readFileSync(mcpPath, 'utf8').trim();
  if (raw) {
    try { mcp = JSON.parse(raw); } catch (e) {
      console.error('✗ 现有 mcp.json 不是合法 JSON，请先手工检查：', mcpPath);
      process.exit(1);
    }
    backup(mcpPath);
  }
}
mcp.mcpServers = mcp.mcpServers || {};
mcp.mcpServers['supplement-widget'] = {
  command: process.execPath,
  args: [serverJs],
};
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
console.log('✓ [1/4] MCP 服务器已注册到', mcpPath);
console.log('        command =', process.execPath);
console.log('        args    =', serverJs);

/* ---------- 2. 安装技能 ---------- */
const srcSkill = path.join(root, 'skills', 'supplement-widget');
const dstSkill = path.join(wbDir, 'skills', 'supplement-widget');
if (!fs.existsSync(srcSkill)) { console.error('✗ 缺少 skills/supplement-widget'); process.exit(1); }
fs.mkdirSync(path.dirname(dstSkill), { recursive: true });
fs.rmSync(dstSkill, { recursive: true, force: true });
fs.cpSync(srcSkill, dstSkill, { recursive: true });
console.log('✓ [2/4] 技能已安装到', dstSkill);

/* ---------- 3. 放行权限（可选） ---------- */
if (noSettings) {
  console.log('• [3/4] 已跳过 settings.json（--no-settings）');
} else {
  const setPath = path.join(wbDir, 'settings.json');
  try {
    let s = {};
    if (fs.existsSync(setPath)) {
      const raw = fs.readFileSync(setPath, 'utf8').trim();
      if (raw) s = JSON.parse(raw);
    }
    s.permissions = s.permissions || {};
    if (!Array.isArray(s.permissions.allow)) s.permissions.allow = [];
    if (!s.permissions.allow.includes('mcp__supplement-widget')) {
      backup(setPath);
      s.permissions.allow.push('mcp__supplement-widget');
      fs.writeFileSync(setPath, JSON.stringify(s, null, 2) + '\n');
      console.log('✓ [3/4] 已放行 mcp__supplement-widget（免每次弹窗；如需撤销见 uninstall.mjs）');
    } else {
      console.log('✓ [3/4] permissions.allow 已包含 mcp__supplement-widget');
    }
  } catch (e) {
    console.warn('! [3/4] 更新 settings.json 失败（不影响安装，可自行在弹窗里选"始终允许"）：', e.message);
  }
}

/* ---------- 4. 注册 hooks（自动装载挂件） ---------- */
if (noHooks) {
  console.log('• [4/4] 已跳过 hooks 注册（--no-hooks）');
} else {
  const hookJs = path.join(root, 'hooks', 'supplement-widget-hook.mjs');
  const hookCmd = `"${process.execPath}" "${hookJs}"`;
  const MARK = 'supplement-widget-hook.mjs';
  const setPath = path.join(wbDir, 'settings.json');
  try {
    if (!fs.existsSync(hookJs)) throw new Error('缺少 hooks/supplement-widget-hook.mjs');
    let s = {};
    if (fs.existsSync(setPath)) {
      const raw = fs.readFileSync(setPath, 'utf8').trim();
      if (raw) s = JSON.parse(raw);
    }
    s.hooks = s.hooks || {};
    const isOurs = (group) =>
      Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARK));

    const merged = [];
    // 幂等：相同事件的既有 hooks 先保留，再追加我们的分组
    const ensure = (event, group) => {
      const arr = Array.isArray(s.hooks[event]) ? s.hooks[event].filter((g) => !isOurs(g)) : [];
      arr.push(group);
      s.hooks[event] = arr;
    };

    ensure('SessionStart', { hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] });
    ensure('UserPromptSubmit', { hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] });
    // "*" = 匹配所有工具：消费桌面挂件的待处理请求 + 识别对话内挂件已打开
    ensure('PostToolUse', { matcher: '*', hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] });
    // 回合结束前若发现待处理请求，阻止停止并提示模型先提问
    ensure('Stop', { hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] });

    backup(setPath);
    fs.writeFileSync(setPath, JSON.stringify(s, null, 2) + '\n');
    console.log('✓ [4/4] 已注册 hooks（SessionStart / UserPromptSubmit / PostToolUse:* / Stop）→', setPath);
    void merged;
  } catch (e) {
    console.warn('! [4/4] 注册 hooks 失败：', e.message);
  }
}

/* ---------- 提示 ---------- */
console.log(`
安装完成 🎉

接下来：
  1.（对话内版用到时）WorkBuddy → 连接器管理 → 右上角「自定义连接器」→ Trust "supplement-widget"（已信任可跳过）
  2.（桌面版）双击 overlay/start-overlay.vbs —— 右下角出现小鲸鱼；想开机自启再双击 overlay/enable-autostart.vbs
  3. 任务运行中点一下小鲸鱼 → AI 立即用提问工具问你「有什么要补充的吗？」

文件变化：
  ~/.workbuddy/mcp.json                 （新增 supplement-widget 一项）
  ~/.workbuddy/skills/supplement-widget （新增技能）
  ~/.workbuddy/settings.json            （permissions.allow 放行 + hooks 注册，均已备份）

卸载：node scripts/uninstall.mjs
`);
