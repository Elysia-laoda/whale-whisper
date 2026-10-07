#!/usr/bin/env node
/**
 * install.mjs — 一键安装「ZCode 补充提示挂件」
 *
 * 做了两件事（写文件前自动备份，均可跳过）：
 *   1. 在 ~/.zcode/cli/config.json 的 hooks.events 里注册四类钩子
 *      （SessionStart / UserPromptSubmit / PostToolUse / Stop）
 *   2. 复制技能到 ~/.zcode/skills/supplement-widget
 *
 * 用法：
 *   node scripts/install.mjs
 *   node scripts/install.mjs --no-hooks
 *   node scripts/install.mjs --no-skill
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const home = os.homedir();
const zcDir = (process.env.ZCODE_CLI_HOME || '').trim()
  ? path.resolve(process.env.ZCODE_CLI_HOME.trim())
  : path.join(home, '.zcode', 'cli');
const configPath = path.join(zcDir, 'config.json');

const args = new Set(process.argv.slice(2));
const noHooks = args.has('--no-hooks');
const noSkill = args.has('--no-skill');

const pad = (n) => String(n).padStart(2, '0');
function ts() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function backup(p) {
  if (!fs.existsSync(p)) return;
  const b = `${p}.bak-supplement-widget-${ts()}`;
  fs.copyFileSync(p, b);
  console.log('  [backup]', path.basename(p), '->', path.basename(b));
}

const hookJs = path.join(root, 'hooks', 'supplement-widget-hook.mjs');
if (!fs.existsSync(hookJs)) { console.error('✗ 缺少 hooks/supplement-widget-hook.mjs'); process.exit(1); }
console.log('安装「ZCode 补充提示挂件」到', zcDir);

/* ---------- 1. 注册 hooks ---------- */
if (noHooks) {
  console.log('• [1/2] 已跳过 hooks 注册（--no-hooks）');
} else {
  let cfg = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (raw) {
      try { cfg = JSON.parse(raw); } catch (e) {
        console.error('✗ 现有 config.json 不是合法 JSON，请先手工检查：', configPath);
        process.exit(1);
      }
    }
  }

  cfg.hooks = cfg.hooks || {};
  cfg.hooks.enabled = true;          // 配置文件钩子默认关闭，必须显式打开
  cfg.hooks.events = cfg.hooks.events || {};

  const MARK = 'supplement-widget-hook.mjs';
  const isOurs = (group) =>
    Array.isArray(group?.hooks) && group.hooks.some((h) =>
      (typeof h?.command === 'string' && h.command.includes(MARK)) ||
      (Array.isArray(h?.args) && h.args.some((a) => String(a).includes(MARK))));

  // 幂等：先移除既有本挂件分组，再追加新的
  const ensure = (event, group) => {
    const arr = Array.isArray(cfg.hooks.events[event])
      ? cfg.hooks.events[event].filter((g) => !isOurs(g))
      : [];
    arr.push(group);
    cfg.hooks.events[event] = arr;
  };

  const hookGroup = { hooks: [{ type: 'process', command: 'node', args: [hookJs], timeoutMs: 8000 }] };
  ensure('SessionStart', { matcher: 'startup|resume|clear', ...hookGroup }); // compact 时不重复注入
  ensure('UserPromptSubmit', hookGroup);
  ensure('PreToolUse', hookGroup);    // 未决事件期间拒绝非提问工具（强制通道）
  ensure('PostToolUse', hookGroup);   // 无 matcher = 所有工具：消费 pending 的主路径
  ensure('Stop', hookGroup);

  backup(configPath);
  fs.mkdirSync(zcDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('✓ [1/2] 已注册 hooks（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop）→', configPath);
}

/* ---------- 2. 安装技能 ---------- */
if (noSkill) {
  console.log('• [2/2] 已跳过技能安装（--no-skill）');
} else {
  const srcSkill = path.join(root, 'skills', 'supplement-widget');
  const dstSkill = path.join(home, '.zcode', 'skills', 'supplement-widget');
  if (!fs.existsSync(srcSkill)) { console.error('✗ 缺少 skills/supplement-widget'); process.exit(1); }
  fs.mkdirSync(path.dirname(dstSkill), { recursive: true });
  fs.rmSync(dstSkill, { recursive: true, force: true });
  fs.cpSync(srcSkill, dstSkill, { recursive: true });
  console.log('✓ [2/2] 技能已安装到', dstSkill);
}

/* ---------- 提示 ---------- */
console.log(`
安装完成 🎉

接下来：
  1.（桌面版）双击 overlay/start-overlay.vbs —— 右下角出现小鲸鱼；想开机自启再双击 overlay/enable-autostart.vbs
     依赖 Python + PySide6：pip install PySide6
  2. 任务运行中点一下小鲸鱼 → AI 立即用 AskUserQuestion 问你「有什么要补充的吗？」
  3. 已开着的 ZCode 会话要在新会话（或重启后）才会加载新钩子。

文件变化：
  ~/.zcode/cli/config.json          （hooks 注册，已备份）
  ~/.zcode/skills/supplement-widget （新增技能）

卸载：node scripts/uninstall.mjs
`);
