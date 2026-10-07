#!/usr/bin/env node
/**
 * uninstall.mjs — 卸载「ZCode 补充提示挂件」
 *
 *   1. 从 ~/.zcode/cli/config.json 的 hooks.events 里移除本挂件钩子（先备份）
 *   2. 删除 ~/.zcode/skills/supplement-widget
 *   3. 停止桌面挂件进程（尽力而为）
 *
 * 状态目录 ~/.zcode/cli/supplement-widget（pending 请求与日志）保留不删，
 * 需要彻底清理可手工删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const home = os.homedir();
const zcDir = (process.env.ZCODE_CLI_HOME || '').trim()
  ? path.resolve(process.env.ZCODE_CLI_HOME.trim())
  : path.join(home, '.zcode', 'cli');
const configPath = path.join(zcDir, 'config.json');

const MARK = 'supplement-widget-hook.mjs';
const isOurs = (group) =>
  Array.isArray(group?.hooks) && group.hooks.some((h) =>
    (typeof h?.command === 'string' && h.command.includes(MARK)) ||
    (Array.isArray(h?.args) && h.args.some((a) => String(a).includes(MARK))));

/* ---------- 1. 移除 hooks ---------- */
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg?.hooks?.events) {
      let removed = 0;
      for (const event of Object.keys(cfg.hooks.events)) {
        const arr = cfg.hooks.events[event];
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((g) => !isOurs(g));
        if (kept.length !== arr.length) removed += arr.length - kept.length;
        if (kept.length) cfg.hooks.events[event] = kept;
        else delete cfg.hooks.events[event];
      }
      if (removed) {
        const pad = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        fs.copyFileSync(configPath, `${configPath}.bak-supplement-widget-${stamp}`);
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
        console.log(`✓ [1/3] 已从 hooks 移除 ${removed} 个挂件分组（已备份）`);
      } else {
        console.log('• [1/3] hooks 里没有挂件分组，跳过');
      }
    } else {
      console.log('• [1/3] config.json 没有 hooks，跳过');
    }
  } catch (e) {
    console.warn('! [1/3] config.json 处理失败：', e.message);
  }
} else {
  console.log('• [1/3] config.json 不存在，跳过');
}

/* ---------- 2. 删除技能 ---------- */
const dstSkill = path.join(home, '.zcode', 'skills', 'supplement-widget');
if (fs.existsSync(dstSkill)) {
  fs.rmSync(dstSkill, { recursive: true, force: true });
  console.log('✓ [2/3] 技能已删除：', dstSkill);
} else {
  console.log('• [2/3] 技能不存在，跳过');
}

/* ---------- 3. 停止桌面挂件 ---------- */
const stopPy = path.join(root, 'overlay', 'overlay.py');
if (fs.existsSync(stopPy)) {
  try {
    const child = spawn('python', [stopPy, '--stop'], { stdio: 'ignore', shell: false });
    child.on('error', () => console.log('• [3/3] 未找到 python，桌面挂件进程未停止（可忽略）'));
    child.unref();
    console.log('✓ [3/3] 已向桌面挂件发送停止指令');
  } catch {
    console.log('• [3/3] 停止指令发送失败（可忽略）');
  }
}

console.log(`
卸载完成。

保留未删：~/.zcode/cli/supplement-widget（状态与日志，可手工删除）
如需恢复：node scripts/install.mjs
`);
