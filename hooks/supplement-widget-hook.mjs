#!/usr/bin/env node
/**
 * supplement-widget-hook.mjs — 「补充提示挂件」总钩子
 *
 * 一个脚本挂四类事件（由 stdin 的 hook_event_name 区分）：
 *
 *   SessionStart    → 注入挂件上下文：桌面版挂件常驻屏幕右下角，点击后会派发事件；
 *                     收到事件时必须立刻 AskUserQuestion（不主动打开对话内挂件）
 *   UserPromptSubmit→ ① 识别"关掉挂件"意图（本会话闭嘴）
 *                     ② 消费桌面挂件的待处理请求（pending-request.json）并注入提问指令
 *   PostToolUse (*) → ① 消费待处理请求 → 注入提问指令（任务运行中点击挂件的主路径）
 *                     ② 用户手动打开对话内挂件时做已读标记（停止后续提醒）
 *   Stop            → 回合即将结束时发现待处理请求 → 阻止停止并提示模型先提问
 *
 * 桌面挂件（overlay/overlay.py）点击时写 pending-request.json；
 * 这里按 sessionHint 定向消费：只让目标会话处理，避免多任务串台。
 *
 * 设计原则：绝不打扰、绝不阻塞。任何异常都静默退出（exit 0 且无输出）。
 * 状态文件：<configDir>/supplement-widget/{hook-state.json,pending-request.json}
 * （configDir = WORKBUDDY_CONFIG_DIR 或 ~/.workbuddy）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEBUG = process.env.SUPPLEMENT_WIDGET_HOOK_DEBUG === '1';
const MAX_INJECTIONS = 4;                        // 会话开头注入上限（含 SessionStart）
const KEEP_SESSIONS = 100;                       // 状态文件保留的最近会话数
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;       // 待处理请求有效期

function debug(...args) {
  if (DEBUG) console.error('[supplement-widget-hook]', ...args);
}

function configDir() {
  const fromEnv = (process.env.WORKBUDDY_CONFIG_DIR || '').trim();
  return fromEnv || path.join(os.homedir(), '.workbuddy');
}

function stateDir() { return path.join(configDir(), 'supplement-widget'); }
function statePath() { return path.join(stateDir(), 'hook-state.json'); }
function pendingPath() { return path.join(stateDir(), 'pending-request.json'); }

function safeUnlink(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

/** 轻量事件日志（只在消费/注入时追加，便于排查；不记录常规事件） */
function eventLog(line) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), 'hook-events.log'),
      new Date().toISOString() + ' ' + line + '\n');
  } catch { /* ignore */ }
}

/* ---------------- 会话状态 ---------------- */

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (j && typeof j === 'object' && j.sessions && typeof j.sessions === 'object') return j;
  } catch { /* 忽略 */ }
  return { version: 2, sessions: {} };
}

function saveState(state) {
  try {
    const entries = Object.entries(state.sessions || {});
    entries.sort((a, b) => (b[1]?.lastAt || 0) - (a[1]?.lastAt || 0));
    state.sessions = Object.fromEntries(entries.slice(0, KEEP_SESSIONS));
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = statePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath());
  } catch (e) { debug('saveState failed', e && e.message); }
}

function getSession(state, id) {
  if (!state.sessions[id]) {
    state.sessions[id] = { opened: false, dismissed: false, injected: 0, lastAt: 0 };
  }
  return state.sessions[id];
}

/* ---------------- 文案 ---------------- */

const SESSION_TEXT =
  '【补充提示挂件·上下文】本机装有"补充提示挂件"：桌面版小鲸鱼常驻屏幕右下角（用户可拖动、可点击）。机制：用户点击挂件后，你会收到一条「补充提示挂件·事件 <id>」提醒' +
  '（可能出现在工具结果后或用户消息里），届时请立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后把他的补充纳入计划再继续；同一事件 <id> 只需提问一次。' +
  '另有一个对话内挂件（工具 open_supplement_widget）：仅在用户明确要求"放到对话里"时才打开，不要主动打开。若用户表示过不需要挂件，则本会话不再处理挂件事件。';

function pendingText(id) {
  return '【补充提示挂件·事件 ' + id + '】用户按下了补充提示挂件，希望在任务继续前补充提示。' +
    '请立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后再继续当前任务；不要推迟到任务结束。' +
    '若你已处理过同一事件（' + id + '）则忽略本提醒。';
}

/* ---------------- 意图识别 ---------------- */

const DISMISS_RE = new RegExp(
  [
    '(关|关闭|关掉|收起|收掉|撤掉|不用|不要|不需要|别开|别在|别再)[^，。！？,.]{0,8}(挂件|悬浮窗?)',
    '(挂件|悬浮窗?)[^，。！？,.]{0,8}(关掉|关闭|收起|收掉|撤掉|不用了|不要了|不需要了|别开了)',
  ].join('|'),
);

function isDismiss(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  return DISMISS_RE.test(prompt);
}

/* ---------------- 待处理请求（桌面挂件点击） ---------------- */

/**
 * 尝试消费待处理请求。
 * - 过期（>15min）→ 删除并返回 null
 * - 带 sessionHint 且与当前会话不符 → 不消费（留给目标会话）
 * - 消费成功 → 删除文件并返回 payload
 */
function takePending(sessionId) {
  let raw;
  try { raw = fs.readFileSync(pendingPath(), 'utf8'); } catch { return null; }
  let j = null;
  try { j = JSON.parse(raw); } catch { safeUnlink(pendingPath()); return null; }
  const at = j && typeof j.at === 'number' ? j.at : 0;
  if (!j || !at || Date.now() - at > PENDING_MAX_AGE_MS) {
    debug('pending expired/stale, drop');
    safeUnlink(pendingPath());
    return null;
  }
  if (j.sessionHint && sessionId && j.sessionHint !== sessionId) {
    debug('pending targets another session, keep', j.sessionHint, '!=', sessionId);
    return null;
  }
  try {
    fs.unlinkSync(pendingPath());   // 成功删除者获得消费权
  } catch {
    debug('pending race lost');
    return null;
  }
  debug('pending consumed', j.id);
  eventLog('pending consumed id=' + j.id + ' by session=' + sessionId);
  return j;
}

/* ---------------- 输出 ---------------- */

function emit(eventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  }));
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      setTimeout(finish, 5000);
    } catch { finish(); }
  });
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* 无输入 */ }

  const event = input.hook_event_name;
  const sessionId = input.session_id || 'unknown';
  debug('event =', event, 'session =', sessionId);

  const state = loadState();
  const st = getSession(state, sessionId);
  st.lastAt = Date.now();

  /* ---------- SessionStart ---------- */
  if (event === 'SessionStart') {
    if (st.dismissed) { debug('session dismissed, skip'); return; }
    if (st.injected >= MAX_INJECTIONS) { debug('injection cap reached'); return; }
    st.injected += 1;
    saveState(state);
    emit('SessionStart', SESSION_TEXT);
    return;
  }

  /* ---------- UserPromptSubmit ---------- */
  if (event === 'UserPromptSubmit') {
    if (isDismiss(input.prompt)) {
      st.dismissed = true;
      saveState(state);
      debug('dismissed by prompt');
      return;
    }
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      saveState(state);
      emit('UserPromptSubmit', pendingText(pend.id));
    }
    return;
  }

  /* ---------- PostToolUse（matcher: *） ---------- */
  if (event === 'PostToolUse') {
    const toolName = input.tool_name || '';
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      saveState(state);
      emit('PostToolUse', pendingText(pend.id));
      return;
    }
    if (toolName.includes('open_supplement_widget')) {
      st.opened = true;
      st.dismissed = false;
      saveState(state);
      debug('marked opened');
    }
    return;
  }

  /* ---------- Stop ---------- */
  if (event === 'Stop') {
    if (input.stop_hook_active) { debug('stop_hook_active, skip'); return; }
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      saveState(state);
      process.exitCode = 2;   // 阻止停止：stderr 会作为反馈注入给模型
      process.stderr.write(pendingText(pend.id));
    }
    return;
  }

  // 其他事件：静默
}

main().catch((e) => {
  debug('fatal', e && e.stack);
  process.exit(0); // 永远不阻塞会话
});
