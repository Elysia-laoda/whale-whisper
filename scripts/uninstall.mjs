#!/usr/bin/env node
/**
 * uninstall.mjs — 卸载「补充提示挂件」
 * 撤销 install.mjs 的三处修改（每个文件先备份）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const home = os.homedir();
const wbDir = path.join(home, '.workbuddy');

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

/* 1. mcp.json */
const mcpPath = path.join(wbDir, 'mcp.json');
if (fs.existsSync(mcpPath)) {
  try {
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8').trim() || '{}');
    if (mcp.mcpServers && mcp.mcpServers['supplement-widget']) {
      backup(mcpPath);
      delete mcp.mcpServers['supplement-widget'];
      fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
      console.log('✓ 已从 mcp.json 移除 supplement-widget');
    } else {
      console.log('• mcp.json 中未找到 supplement-widget');
    }
  } catch (e) {
    console.warn('! 处理 mcp.json 失败：', e.message);
  }
}

/* 2. skill */
const dstSkill = path.join(wbDir, 'skills', 'supplement-widget');
if (fs.existsSync(dstSkill)) {
  fs.rmSync(dstSkill, { recursive: true, force: true });
  console.log('✓ 已删除技能目录', dstSkill);
} else {
  console.log('• 技能目录不存在，跳过');
}

/* 3. settings.json 的 allow 规则 + hooks */
const setPath = path.join(wbDir, 'settings.json');
if (fs.existsSync(setPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(setPath, 'utf8').trim() || '{}');
    let changed = false;

    const allow = s.permissions && s.permissions.allow;
    if (Array.isArray(allow) && allow.includes('mcp__supplement-widget')) {
      s.permissions.allow = allow.filter((x) => x !== 'mcp__supplement-widget');
      changed = true;
      console.log('✓ 已移除 permissions.allow 中的 mcp__supplement-widget');
    }

    const MARK = 'supplement-widget-hook.mjs';
    if (s.hooks && typeof s.hooks === 'object') {
      for (const event of Object.keys(s.hooks)) {
        const arr = s.hooks[event];
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((g) =>
          !(Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARK))));
        if (kept.length !== arr.length) {
          if (kept.length) s.hooks[event] = kept;
          else delete s.hooks[event];
          changed = true;
          console.log('✓ 已移除 hooks.' + event);
        }
      }
      if (Object.keys(s.hooks).length === 0) delete s.hooks;
    }

    if (changed) {
      backup(setPath);
      fs.writeFileSync(setPath, JSON.stringify(s, null, 2) + '\n');
    } else {
      console.log('• settings.json 中无相关配置');
    }
  } catch (e) {
    console.warn('! 处理 settings.json 失败：', e.message);
  }
}

console.log('\n卸载完成。在 WorkBuddy 里可再手动刷新一下连接器列表。');
