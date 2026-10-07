#!/usr/bin/env node
/**
 * supplement-widget-hook.mjs — 「ZCode 补充提示挂件」总钩子（强制版）
 *
 * 一个脚本挂五类事件（由 stdin 的 hook_event_name 区分）：
 *
 *   SessionStart    → 注入挂件上下文：桌面版小鲸鱼跟随 ZCode 窗口，点击后派发事件
 *   UserPromptSubmit→ ① 识别"关掉挂件"意图（本会话闭嘴，并清掉未决事件）
 *                     ② 用户发话时清掉未决事件（用户主动接管）
 *                     ③ 消费桌面挂件的待处理请求（pending-request.json）→ 记为未决事件并注入指令
 *   PreToolUse      → 未决事件存在时，拒绝除 AskUserQuestion 之外的一切工具调用，
 *                     直到模型真的提问为止（硬强制主通道）
 *   PostToolUse     → ① 消费待处理请求 → 记为未决事件并注入指令（任务运行中点击的主路径）
 *                     ② 看到 AskUserQuestion 跑完 → 清除未决事件（模型已提问）
 *   Stop            → 未决事件仍在 → decision:block 阻止收尾，要求先提问（兜底通道）
 *
 * 未决事件（pendingEvent）的解除条件（任一）：
 *   - PostToolUse 看到 AskUserQuestion（模型真的问了）
 *   - UserPromptSubmit（用户自己开口了）
 *   - 超时（15 分钟）
 *   - 强制次数耗尽：工具拒绝最多 MAX_TOOL_DENIES 次、Stop 拦截最多 MAX_STOP_BLOCKS 次
 *     （防止模型死不提问时无限烧 token；ZCode 对 Stop 续写本身也限 3 次）
 *
 * 桌面挂件（overlay/overlay.py）点击时写 pending-request.json；
 * 按 sessionHint 定向消费：只让目标会话处理，避免多会话串台。
 *
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
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;       // 待处理请求/未决事件有效期
const MAX_TOOL_DENIES = 5;                       // 未决事件期间最多拒绝多少次工具调用
const MAX_STOP_BLOCKS = 2;                       // 未决事件期间最多拦截多少次收尾

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

/** 轻量事件日志（只在消费/注入/强制/解除时追加，便于排查；不记录常规事件） */
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
  return { version: 3, sessions: {} };
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
    state.sessions[id] = { opened: false, dismissed: false, injected: 0, pendingEvent: null, lastAt: 0 };
  }
  return state.sessions[id];
}

/** 未决事件状态：返回事件对象 / 'expired'（已过期并就地清除）/ null（无事件） */
function activeEvent(st) {
  const ev = st.pendingEvent;
  if (!ev || typeof ev.id !== 'string') return null;
  if (!ev.at || Date.now() - ev.at > PENDING_MAX_AGE_MS) {
    st.pendingEvent = null;
    return 'expired';
  }
  return ev;
}

function clearEvent(st, why) {
  if (st.pendingEvent) {
    eventLog('event ' + st.pendingEvent.id + ' cleared: ' + why);
  }
  st.pendingEvent = null;
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
  '【补充提示挂件·上下文】本机装有"ZCode 补充提示挂件"：桌面版小鲸鱼跟随 ZCode 窗口（用户可拖动、可点击）。机制：用户点击挂件后，你会收到一条「补充提示挂件·事件 <id>」的最高优先级指令' +
  '（出现在工具边界或收尾时）。届时你在提问之前的一切其他工具调用都会被钩子拒绝、回合也会被禁止结束——唯一出路是立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后把补充纳入计划再继续；同一事件 <id> 只需提问一次。' +
  '若用户表示过不需要挂件，则本会话不再处理挂件事件。';

function pendingText(id) {
  return '【最高优先级·用户指令｜补充提示挂件·事件 ' + id + '】用户刚按下了补充提示挂件：在做任何其他事情之前，必须先调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答后把补充纳入计划，再继续当前任务。' +
    '此指令优先于当前任务的一切后续步骤：不允许先调用其他工具、不允许推迟、不允许只用文字回应而不调用提问工具。在模型提问之前，其他工具调用会被钩子拒绝、回合会被禁止结束。' +
    '若你已处理过同一事件（' + id + '）则忽略本提醒。';
}

function denyText(id) {
  return '补充提示挂件·事件 ' + id + ' 未处理：用户要求先被提问。本次工具调用已被拒绝——立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」；不要调用任何其他工具。';
}

function stopText(id) {
  return '你还没有回应补充提示挂件·事件 ' + id + '。在回合结束前必须先调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」，等用户回答并纳入计划后再收尾。这是硬性要求，不允许只用文字带过。';
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

/** PreToolUse / Stop 共用的硬拦截格式（command-guard 同款，本机生产验证过） */
function blockWith(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
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
  const toolName = String(input.tool_name || input.toolName || '');
  debug('event =', event, 'session =', sessionId, 'tool =', toolName);

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

  /* ---------- PreToolUse：未决事件期间拒绝一切非提问工具 ---------- */
  if (event === 'PreToolUse') {
    if (st.dismissed) return null;
    const ev = activeEvent(st);
    if (ev === 'expired') { saveState(state); return null; }
    if (!ev) return null;
    if (toolName.includes('AskUserQuestion')) return null;   // 提问工具放行
    ev.denies = (ev.denies || 0) + 1;
    if (ev.denies > MAX_TOOL_DENIES) {
      clearEvent(st, 'deny cap reached (' + MAX_TOOL_DENIES + '), degrade to soft');
      saveState(state);
      return null;
    }
    saveState(state);
    eventLog('tool denied id=' + ev.id + ' tool=' + toolName + ' n=' + ev.denies);
    return { kind: 'block', text: denyText(ev.id) };
  }

  /* ---------- UserPromptSubmit ---------- */
  if (event === 'UserPromptSubmit') {
    const prompt = input.prompt ?? input.user_prompt ?? '';
    // 用户开口即接管：清掉未决事件（无论是否 dismiss）
    if (activeEvent(st)) clearEvent(st, 'user submitted a prompt');
    if (isDismiss(prompt)) {
      st.dismissed = true;
      saveState(state);
      debug('dismissed by prompt');
      return null;
    }
    const pend = takePending(sessionId);
    if (pend && !st.dismissed) {
      st.pendingEvent = { id: pend.id, at: pend.at, denies: 0, blocks: 0 };
      saveState(state);
      return { kind: 'emit', event: 'UserPromptSubmit', text: pendingText(pend.id) };
    }
    saveState(state);
    return null;
  }

  /* ---------- PostToolUse ---------- */
  if (event === 'PostToolUse') {
    // 模型真的提问了 → 解除强制
    if (toolName.includes('AskUserQuestion')) {
      if (activeEvent(st)) clearEvent(st, 'AskUserQuestion completed');
      saveState(state);
      return null;
    }
    if (st.dismissed) return null;
    const pend = takePending(sessionId);
    if (pend) {
      st.pendingEvent = { id: pend.id, at: pend.at, denies: 0, blocks: 0 };
      saveState(state);
      return { kind: 'emit', event: 'PostToolUse', text: pendingText(pend.id) };
    }
    saveState(state);
    return null;
  }

  /* ---------- Stop：未决事件兜底拦截 ---------- */
  if (event === 'Stop') {
    if (input.stop_hook_active) { debug('stop_hook_active, skip'); return null; }
    const ev = activeEvent(st);
    if (ev === 'expired') { saveState(state); return null; }
    if (!ev) return null;
    ev.blocks = (ev.blocks || 0) + 1;
    if (ev.blocks > MAX_STOP_BLOCKS) {
      clearEvent(st, 'stop block cap reached (' + MAX_STOP_BLOCKS + '), give up');
      saveState(state);
      return null;
    }
    saveState(state);
    eventLog('stop blocked id=' + ev.id + ' n=' + ev.blocks);
    return { kind: 'block', text: stopText(ev.id) };
  }

  return null;
}

function runAction(action) {
  if (!action) return;
  if (action.kind === 'emit') emit(action.event, action.text);
  else if (action.kind === 'block') blockWith(action.text);
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

  const run = (input) => {
    let captured = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => { captured += c; return true; };
    try { runAction(dispatch(input)); } finally { process.stdout.write = orig; }
    return captured;
  };

  const freshState = () => saveState({ version: 3, sessions: {} });
  const writePending = (id, hint) => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(pendingPath(), JSON.stringify(
      hint ? { id, at: Date.now(), sessionHint: hint } : { id, at: Date.now() }));
  };

  push('SessionStart 注入上下文（含强制机制说明）', () => {
    freshState();
    const out = run({ hook_event_name: 'SessionStart', session_id: SESS });
    assert(out.includes('SessionStart') && out.includes('补充提示挂件'), out);
    assert(out.includes('AskUserQuestion'), '应说明提问工具');
    return 'ok';
  });

  push('SessionStart 注入上限（第 5 次静默）', () => {
    freshState();
    for (let i = 0; i < 4; i++) run({ hook_event_name: 'SessionStart', session_id: SESS });
    assert(run({ hook_event_name: 'SessionStart', session_id: SESS }) === '', '应静默');
    return '静默';
  });

  push('PostToolUse 消费 pending → 未决事件建立 → PreToolUse 拒绝普通工具', () => {
    freshState();
    writePending('sup-t1');
    const out1 = run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    assert(out1.includes('sup-t1'), out1);
    const out2 = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' });
    assert(out2.includes('"block"'), `应拒绝，实际：${out2}`);
    assert(out2.includes('sup-t1'), out2);
    return '拒绝生效';
  });

  push('PreToolUse 放行 AskUserQuestion', () => {
    freshState();
    writePending('sup-t2');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    const out = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'AskUserQuestion' });
    assert(out === '', `应放行，实际：${out}`);
    return '放行';
  });

  push('PostToolUse(AskUserQuestion) 解除强制', () => {
    freshState();
    writePending('sup-t3');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'AskUserQuestion' });
    const out = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Edit' });
    assert(out === '', `解除后不应再拒，实际：${out}`);
    return '已解除';
  });

  push('Stop 兜底拦截，且第 3 次放弃', () => {
    freshState();
    writePending('sup-t4');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    const b1 = run({ hook_event_name: 'Stop', session_id: SESS });
    assert(b1.includes('"block"') && b1.includes('sup-t4'), b1);
    const b2 = run({ hook_event_name: 'Stop', session_id: SESS });
    assert(b2.includes('"block"'), b2);
    const b3 = run({ hook_event_name: 'Stop', session_id: SESS });
    assert(b3 === '', `第 3 次应放弃，实际：${b3}`);
    const out = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' });
    assert(out === '', '放弃后 PreToolUse 也不该再拒');
    return '拦 2 放 1';
  });

  push('工具拒绝第 6 次降级放行', () => {
    freshState();
    writePending('sup-t5');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    let last = '';
    for (let i = 0; i < 5; i++) {
      last = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' });
      assert(last.includes('"block"'), `第 ${i + 1} 次应拒绝`);
    }
    last = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' });
    assert(last === '', `第 6 次应降级放行，实际：${last}`);
    return '拒 5 放 1';
  });

  push('UserPromptSubmit 清掉未决事件（用户接管）', () => {
    freshState();
    writePending('sup-t6');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    const out1 = run({ hook_event_name: 'UserPromptSubmit', session_id: SESS, prompt: '继续' });
    assert(out1 === '', '无新 pending 时用户消息不该注入');
    const out2 = run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' });
    assert(out2 === '', '用户发话后不应再强制');
    return '已解除';
  });

  push('sessionHint 定向：目标不符不消费', () => {
    freshState();
    writePending('sup-t7', 'sess_other');
    const out = run({ hook_event_name: 'PostToolUse', session_id: SESS });
    assert(out === '', '不该被别的会话消费');
    assert(fs.existsSync(pendingPath()), 'pending 应保留');
    safeUnlink(pendingPath());
    return '保留给目标会话';
  });

  push('sessionHint 与 sess_ 前缀差异不影响定向', () => {
    freshState();
    writePending('sup-t8', 'selftest1234');
    const out = run({ hook_event_name: 'PostToolUse', session_id: SESS });
    assert(out.includes('sup-t8'), `应消费，实际：${out}`);
    return '前缀归一化生效';
  });

  push('过期 pending 被丢弃；未决事件超时自动解除', () => {
    freshState();
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(pendingPath(), JSON.stringify({ id: 'sup-t9', at: Date.now() - 20 * 60 * 1000 }));
    assert(run({ hook_event_name: 'PostToolUse', session_id: SESS }) === '', '过期请求不该注入');
    assert(!fs.existsSync(pendingPath()), '过期文件应删除');
    // 未决事件超时
    const st0 = loadState();
    st0.sessions[SESS] = { dismissed: false, injected: 0, pendingEvent: { id: 'sup-t10', at: Date.now() - 20 * 60 * 1000, denies: 0, blocks: 0 }, lastAt: 0 };
    saveState(st0);
    assert(run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' }) === '', '超时后不应拒绝');
    assert(loadState().sessions[SESS].pendingEvent === null, '超时事件应被清掉');
    return '两条 TTL 都生效';
  });

  push('「关掉挂件」触发 dismiss 且全链路静默', () => {
    freshState();
    writePending('sup-t11');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    run({ hook_event_name: 'UserPromptSubmit', session_id: SESS, prompt: '帮我关掉挂件吧' });
    assert(run({ hook_event_name: 'PreToolUse', session_id: SESS, tool_name: 'Bash' }) === '', 'dismiss 后不拒');
    assert(run({ hook_event_name: 'Stop', session_id: SESS }) === '', 'dismiss 后不拦');
    return 'dismiss 生效';
  });

  push('Stop stop_hook_active 时跳过（不消耗次数）', () => {
    freshState();
    writePending('sup-t12');
    run({ hook_event_name: 'PostToolUse', session_id: SESS, tool_name: 'Bash' });
    const out = run({ hook_event_name: 'Stop', session_id: SESS, stop_hook_active: true });
    assert(out === '', '续写循环内不该再拦');
    assert(loadState().sessions[SESS].pendingEvent.blocks === 0, '不应消耗拦截次数');
    return '跳过';
  });

  push('camelCase 载荷也能识别', () => {
    freshState();
    writePending('sup-t13');
    assert(run({ hookEventName: 'PostToolUse', sessionId: 'selftest1234' }).includes('sup-t13'), '应消费');
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
