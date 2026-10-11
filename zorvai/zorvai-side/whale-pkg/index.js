/* ============================================================
 * whale · ZorvAI 小鲸鱼补充提示挂件 (ToolPkg)
 * ------------------------------------------------------------
 * 上游 : github.com/Elysia-laoda/whale-whisper (MIT)
 * 作用 : 提供挂件事件队列的「读取 / 确认 / 模拟」，配合 skills/whale
 *        的技能规则，让「点一下屏幕小鲸鱼 → AI 立刻问有什么要补充的」
 *        这条链路在 ZorvAI 上成立。
 *
 * 双通道存储（悬浮窗 APK 与 ToolPkg 各自能碰的位置不同）：
 *   A 工作区 : whale-whisper/state/pending.json    ToolPkg 原生相对路径，最稳
 *   B 公共区 : /sdcard/qshare/whale/pending.json   悬浮窗 APK / proot 可写
 *   → state({sync:true}) 把 B 合并进 A
 * ============================================================ */

var DIR = "whale-whisper/state";
var STORE_PATH = DIR + "/pending.json";
var QSHARE_PATH = "/sdcard/qshare/whale/pending.json";
var MAX_EVENTS = 50;
var MAX_ACKED = 200;

/* ---------------- 沙箱文件 API ---------------- */

function F() {
  try {
    if (typeof Tools !== "undefined" && Tools && Tools.Files) return Tools.Files;
  } catch (e) {}
  return null;
}

function readText(path) {
  try {
    var f = F(); if (!f) return null;
    var r = f.read(path);
    if (r == null) return null;
    if (typeof r === "string") return r;
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
    return null;
  } catch (e) { return null; }
}

function writeText(path, text) {
  try {
    var f = F(); if (!f) return false;
    try {
      if (f.mkdir) { f.mkdir("whale-whisper"); f.mkdir(DIR); }
    } catch (e) {}
    f.write(path, text);
    return true;
  } catch (e) { return false; }
}

function readJSON(path, def) {
  try {
    var t = readText(path);
    if (!t) return def;
    return JSON.parse(t);
  } catch (e) { return def; }
}

function writeJSON(path, obj) {
  return writeText(path, JSON.stringify(obj));
}

/* ---------------- 队列 ---------------- */

function emptyStore() {
  return { events: [], acked: [], mute: false, updatedAt: 0 };
}

function load() {
  var st = readJSON(STORE_PATH, null);
  if (!st || typeof st !== "object") st = emptyStore();
  if (!st.events) st.events = [];
  if (!st.acked) st.acked = [];
  return st;
}

function isLive(st, e) {
  return e && e.id && st.acked.indexOf(e.id) < 0 && e.state !== "done";
}

function liveOf(st) {
  return st.events.filter(function (e) { return isLive(st, e); });
}

function save(st) {
  st.updatedAt = Date.now();
  if (st.events.length > MAX_EVENTS) st.events = st.events.slice(-MAX_EVENTS);
  if (st.acked.length > MAX_ACKED) st.acked = st.acked.slice(-MAX_ACKED);
  writeJSON(STORE_PATH, st);
  return st;
}

/* ---------------- 工具：whale_pending ---------------- */

function pending(p) {
  p = p || {};
  var st = load();
  var live = liveOf(st);
  var limit = Number(p.limit || 10);
  return {
    ok: true,
    mute: !!st.mute,
    count: live.length,
    items: live.slice(-limit).map(function (e) {
      return { id: e.id, ts: e.ts, source: e.source, note: e.note, state: e.state };
    }),
    store: STORE_PATH,
    qshare: QSHARE_PATH,
    at: Date.now()
  };
}

/* ---------------- 工具：whale_ack ---------------- */

function ack(p) {
  p = p || {};
  var id = String(p.id || "");
  if (!id) return { ok: false, error: "缺少 id" };
  var st = load();
  if (st.acked.indexOf(id) < 0) st.acked.push(id);
  for (var i = 0; i < st.events.length; i++) {
    if (st.events[i].id === id) st.events[i].state = "done";
  }
  save(st);
  var live = liveOf(st);
  return { ok: true, acked: id, remaining: live.length };
}

/* ---------------- 工具：whale_simulate ---------------- */

function simulate(p) {
  p = p || {};
  var now = Date.now();
  var ev = {
    id: "w" + now,
    ts: now,
    source: p.source || "simulate",
    state: "pending",
    note: p.note || "（联调）用户点击了小鲸鱼"
  };
  var st = load();
  st.events.push(ev);
  save(st);
  return { ok: true, event: ev, hint: "事件已入队；调 whale_pending 可读到，或等技能规则自动检查" };
}

/* ---------------- 工具：whale_state ---------------- */

function probe() {
  var out = { toolsKeys: [], canReadQshare: false, qshareSample: null, canWriteWorkspace: false };
  try {
    if (typeof Tools !== "undefined" && Tools) out.toolsKeys = Object.keys(Tools);
  } catch (e) {}
  var t = readText(QSHARE_PATH);
  out.canReadQshare = t != null;
  if (t) out.qshareSample = String(t).slice(0, 100);
  out.canWriteWorkspace = writeText(".whale-probe.tmp", String(Date.now()));
  return out;
}

function syncFromQshare() {
  var raw = readText(QSHARE_PATH);
  if (!raw) {
    return { ok: false, reason: "读不到公共区 " + QSHARE_PATH + "（沙箱可能不允许绝对路径）", probe: probe() };
  }
  var remote;
  try { remote = JSON.parse(raw); } catch (e) { return { ok: false, reason: "公共区 JSON 解析失败" }; }
  var list = (remote && remote.events) ? remote.events : (remote && remote.id ? [remote] : []);
  var st = load();
  var added = 0;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || !e.id) continue;
    var dup = false;
    for (var j = 0; j < st.events.length; j++) { if (st.events[j].id === e.id) { dup = true; break; } }
    if (!dup) {
      st.events.push({ id: e.id, ts: e.ts || Date.now(), source: e.source || "overlay", state: e.state || "pending", note: e.note || "" });
      added++;
    }
  }
  save(st);
  var live = liveOf(st);
  return { ok: true, imported: added, count: live.length, items: live.slice(-5) };
}

function state(p) {
  p = p || {};
  var st = load();

  if (p.reset) {
    st = save(emptyStore());
    return { ok: true, reset: true, message: "挂件队列已清空" };
  }

  if (typeof p.mute === "boolean") {
    st.mute = p.mute;
    save(st);
    return { ok: true, mute: st.mute, message: st.mute ? "本会话已静音挂件事件" : "挂件事件已恢复" };
  }

  if (p.sync) return syncFromQshare();
  if (p.probe) return { ok: true, probe: probe() };

  var live = liveOf(st);
  return {
    ok: true,
    mute: !!st.mute,
    count: live.length,
    events: st.events.length,
    acked: st.acked.length,
    latest: live.length ? live[live.length - 1] : null,
    store: STORE_PATH,
    qshare: QSHARE_PATH,
    updatedAt: st.updatedAt
  };
}

module.exports = { pending: pending, ack: ack, simulate: simulate, state: state };
