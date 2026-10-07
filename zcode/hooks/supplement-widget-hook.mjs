#!/usr/bin/env node
/**
 * supplement-widget-hook.mjs — 「ZCode 补充提示挂件」总钩子
 *
 * 一个脚本挂四类事件（由 stdin 的 hook_event_name 区分）：
 *
 *   SessionStart    → 注入挂件上下文：桌面版小鲸鱼常驻屏幕右下角，点击后会派发事件；
 *                     收到事件时必须立刻 AskUserQuestion（不主动打开对话内挂件）
 *   UserPromptSubmit→ ① 识别"关掉挂件"意图（本会话闭嘴）
 *                     ② 消费桌面挂件的待处理请求（pending-request.json）并注入提问指令
 *   PostToolUse     → 消费待处理请求 → 注入提问指令（任务运行中点击挂件的主路径）
 *   Stop            → 回合即将结束时发现待处理请求 → 阻止停止并提示模型先提问
 *
 * 桌面挂件（overlay/overlay.py）点击时写 pending-request.json；
 * 这里按 sessionHint 定向消费：只让目标会话处理，避免多会话串台。
 *
 * 设计原则：绝不打扰、绝不阻塞。任何异常都静默退出（exit 0 且无输出）。
 * 状态文件：<ZCODE_CLI_HOME>/supplement-widget/{hook-state.json,pending-request.json}
 * （ZCODE_CLI_HOME 默认 ~/.zcode/cli）
 *
 * 调试：
 *   SUPPLEMENT_WIDGET_HOOK_DEBUG=1        往 stderr 打过程日志
 *   SUPPLEMENT_WIDGET_DUMP=<文件>         把 stdin 原始载荷追加落盘（核对 ZCode 实际发什么）
 *   node supplement-widget-hook.mjs --selftest   合成输入跑全部分支
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
  const fromEnv = (process.env.ZCODE_CLI_HOME || '').trim();
  return fromEnv || path.join(os.homedir(), '.zcode', 'cli');
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

/* ---------------- 会话 id 归一化 ----------------
 * ZCode 载荷里的 session_id 与数据库里存的（sess_ 前缀）可能差一个前缀，
 * 挂件的 sessionHint 取自数据库，比对前两边都剥掉 sess_ 前缀。 */

function normSessionId(id) {
  const s = String(id || '').trim();
  return s.startsWith('sess_') ? s.slice(5) : s;
}

function sameSession(a, b) {
  const na = normSessionId(a);
  const nb = normSessionId(b);
  return na.length > 0 && na === nb;
}

/* ---------------- 文案 ---------------- */

const SESSION_TEXT =
  '【补充提示挂件·上下文】本机装有"ZCode 补充提示挂件"：桌面版小鲸鱼常驻屏幕右下角（用户可拖动、可点击）。机制：用户点击挂件后，你会收到一条「补充提示挂件·事件 <id>」提醒' +
  '（可能出现在工具结果后或用户消息里），届时请立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后把他的补充纳入计划再继续；同一事件 <id> 只需提问一次。' +
  '若用户表示过不需要挂件，则本会话不再处理挂件事件。';

function pendingText(id) {
  return '【补充提示挂件·事件 ' + id + '】用户按下了补充提示挂件，希望在任务继续前补充提示。' +
    '请立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后再继续当前任务；不要推迟到任务结束。' +
    '若你已处理过同一事件（' + id + '）则忽略本提醒。';
}

/* ---------------- 意图识别 ---------------- */

const DISMISS_RE = new RegExp(
  [
    '(关|关闭|关掉|收起|收掉|撤掉|不用|不要|不需要|别开|别在|别再)[^，。！？,.]{0,8}(挂件|悬浮窗?|小鲸鱼|鲸鱼)',
    '(挂件|悬浮窗?|小鲸鱼|鲸鱼)[^，。！？,.]{0,8}(关掉|关闭|收起|收掉|撤掉|不用了|不要了|不需要了|别开了)',
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
  if (j.sessionHint && sessionId && !sameSession(j.sessionHint, sessionId)) {
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

/* ---------------- 事件分发（与 stdin 解耦，便于自测） ---------------- */

function dispatch(input) {
  const event = input.hook_event_name || input.hookEventName;
  const sessionId = input.session_id || input.sessionId || 'unknown';
  debug('event =', event, 'session =', sessionId);

  const state = loadState();
  const st = getSession(state, sessionId);
  st.lastAt = Date.now();

  /* ---------- SessionStart ---------- */
  if (event === 'SessionStart') {
    if (st.dismissed) { debug('session dismissed, skip'); return null; }
    if (st.injected >= MAX_INJECTIONS) { debug('injection cap reached'); return null; }
    st.injected += 1;
    saveState(state);
    return { kind: 'emit', event: 'SessionStart', text: SESSION_TEXT };
  }

  /* ---------- UserPromptSubmit ---------- */
  if (event === 'UserPromptSubmit') {
    const prompt = input.prompt ?? input.user_prompt ?? '';
    if (isDismiss(prompt)) {
      st.dismissed = true;
      saveState(state);
      debug('dismissed by prompt');
      return null;
    }
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      saveState(state);
      return { kind: 'emit', event: 'UserPromptSubmit', text: pendingText(pend.id) };
    }
    return null;
  }

  /* ---------- PostToolUse ---------- */
  if (event === 'PostToolUse') {
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      saveState(state);
      return { kind: 'emit', event: 'PostToolUse', text: pendingText(pend.id) };
    }
    return null;
  }

  /* ---------- Stop ---------- */
  if (event === 'Stop') {
    if (input.stop_hook_active) { debug('stop_hook_active, skip'); return null; }
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      saveState(state);
      return { kind: 'block', text: pendingText(pend.id) };
    }
    return null;
  }

  return null;
}

function runAction(action) {
  if (!action) return;
  if (action.kind === 'emit') emit(action.event, action.text);
  else if (action.kind === 'block') {
    // ZCode 的 Stop 续写：decision block + reason（与 turn-cost 同一条已验证通道）
    process.stdout.write(JSON.stringify({ decision: 'block', reason: action.text }));
  }
}

/* ---------------- 自测 ---------------- */

function selftest() {
  const cases = [];
  const push = (name, fn) => {
    try {
      const r = fn();
      cases.push(`PASS  ${name}${r ? ` — ${r}` : ''}`);
    } catch (err) {
      cases.push(`FAIL  ${name} — ${err.message}`);
      process.exitCode = 1;
    }
  };
  const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

  const SESS = 'sess_selftest1234';
  const BARE = 'selftest1234';

  const run = (input) => {
    let captured = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => { captured += c; return true; };
    try { runAction(dispatch(input)); } finally { process.stdout.write = orig; }
    return captured;
  };

  const freshState = () => {
    saveState({ version: 2, sessions: {} });
  };

  push('SessionStart 注入上下文', () => {
    freshState();
    const out = run({ hook_event_name: 'SessionStart', session_id: SESS });
    assert(out.includes('SessionStart'), out);
    assert(out.includes('补充提示挂件'), out);
    return 'ok';
  });

  push('SessionStart 注入上限（第 5 次静默）', () => {
    freshState();
    for (let i = 0; i < 4; i++) run({ hook_event_name: 'SessionStart', session_id: SESS });
    const out = run({ hook_event_name: 'SessionStart', session_id: SESS });
    assert(out === '', `应静默，实际：${out}`);
    return '静默';
  });

  push('UserPromptSubmit 无 pending 时静默', () => {
    freshState();
    const out = run({ hook_event_name: 'UserPromptSubmit', session_id: SESS, prompt: '继续干活' });
    assert(out === '', `应静默，实际：${out}`);
    return '静默';
  });

  push('「关掉挂件」触发 dismiss 且不再注入', () => {
    freshState();
    run({ hook_event_name: 'UserPromptSubmit', session_id: SESS, prompt: '帮我关掉挂件吧' });
    assert(Object.values(loadState().sessions).some((x) => x.dismissed), 'dismissed 未落状态');
    const out = run({ hook_event_name: 'SessionStart', session_id: SESS });
    assert(out === '', 'dismiss 后 SessionStart 不应注入');
    return 'dismiss 生效';
  });

  push('PostToolUse 消费 pending 并注入', () => {
    freshState();
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-1', at: Date.now(), source: 'test' }));
    const out = run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    assert(out.includes('PostToolUse'), out);
    assert(out.includes('sup-test-1'), out);
    assert(!fs.existsSync(pendingPath()), 'pending 应被删除');
    return '消费成功';
  });

  push('sessionHint 定向：目标不符不消费', () => {
    freshState();
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-2', at: Date.now(), sessionHint: 'sess_other' }));
    const out = run({ hook_event_name: 'PostToolUse', session_id: SESS });
    assert(out === '', '不该被别的会话消费');
    assert(fs.existsSync(pendingPath()), 'pending 应保留');
    safeUnlink(pendingPath());
    return '保留给目标会话';
  });

  push('sessionHint 与 sess_ 前缀差异不影响定向', () => {
    freshState();
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-3', at: Date.now(), sessionHint: BARE }));
    const out = run({ hook_event_name: 'PostToolUse', session_id: SESS });
    assert(out.includes('sup-test-3'), `应消费，实际：${out}`);
    return '前缀归一化生效';
  });

  push('过期 pending 被丢弃', () => {
    freshState();
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-4', at: Date.now() - 20 * 60 * 1000 }));
    const out = run({ hook_event_name: 'PostToolUse', session_id: SESS });
    assert(out === '', '过期请求不该注入');
    assert(!fs.existsSync(pendingPath()), '过期文件应删除');
    return '已丢弃';
  });

  push('Stop 发现 pending 时 block', () => {
    freshState();
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-5', at: Date.now() }));
    const out = run({ hook_event_name: 'Stop', session_id: SESS });
    assert(out.includes('"block"'), `应 block，实际：${out}`);
    assert(out.includes('sup-test-5'), out);
    return 'block 生效';
  });

  push('Stop stop_hook_active 时跳过', () => {
    freshState();
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-6', at: Date.now() }));
    const out = run({ hook_event_name: 'Stop', session_id: SESS, stop_hook_active: true });
    assert(out === '', '续写循环内不该再拦');
    assert(fs.existsSync(pendingPath()), 'pending 应保留给下一轮');
    safeUnlink(pendingPath());
    return '跳过';
  });

  push('camelCase 载荷也能识别', () => {
    freshState();
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-test-7', at: Date.now() }));
    const out = run({ hookEventName: 'PostToolUse', sessionId: BARE });
    assert(out.includes('sup-test-7'), `应消费，实际：${out}`);
    return 'ok';
  });

  push('空载荷与未知事件静默', () => {
    freshState();
    assert(run({}) === '', '空载荷应静默');
    assert(run({ hook_event_name: 'PreCompact' }) === '', '未知事件应静默');
    return '静默';
  });

  console.log(cases.join('\n'));
  console.log(`\n${cases.filter((c) => c.startsWith('PASS')).length}/${cases.length} 通过`);
  return process.exitCode ?? 0;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const arg = process.argv[2];
  if (arg === '--selftest' || arg === 'selftest') process.exit(selftest());

  const raw = await readStdin();

  if (process.env.SUPPLEMENT_WIDGET_DUMP) {
    try {
      fs.appendFileSync(process.env.SUPPLEMENT_WIDGET_DUMP,
        JSON.stringify({ at: new Date().toISOString(), argv: process.argv.slice(2), raw: raw.slice(0, 200000) }) + '\n');
    } catch { /* ignore */ }
  }

  let input = {};
  try { input = JSON.parse(raw); } catch { /* 无输入 */ }

  try {
    runAction(dispatch(input));
  } catch (e) {
    // 钩子出错也不该影响正常会话：吞掉异常，退出码保持 0
    debug('fatal', e && e.stack);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
