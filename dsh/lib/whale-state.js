/**
 * dsh-whisper-whale — 挂件状态机（纯逻辑、无 I/O、可单测）。
 *
 * 一次「点击」产生一个待处理事件（pending），带唯一 id 用于去重。事件只会被
 * 投递一次（deliver），投递后状态从 queued 变成 delivered，客户端据此更新气泡。
 * 事件有 TTL：用户点了挂件但目标对话一直不动（且没被 turn-stopping 兜住）时，
 * 超时自动作废，避免很久以后突然冒出来打扰。
 *
 * @module dsh-whisper-whale/whale-state
 */

/** 待处理事件有效期：15 分钟（与参考实现一致）。 */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/** 每个会话保留的最近事件数（仅用于状态展示，不做持久化）。 */
const HISTORY_LIMIT = 20;

/**
 * 生成一个短小、可读、可用于去重的事件 id。
 * @param {number} [now] - 注入时间戳，便于测试。
 * @param {() => number} [rand] - 注入随机源，便于测试。
 * @returns {string} 形如 `w-3f2a91-4c7`。
 */
export function makeEventId(now = Date.now(), rand = Math.random) {
  const stamp = now.toString(36).slice(-6);
  const noise = Math.floor(rand() * 46655).toString(36).padStart(3, '0');
  return 'w-' + stamp + '-' + noise;
}

/**
 * 创建一份挂件状态。所有方法都是同步的、不会抛错。
 * @param {{ ttlMs?: number, now?: () => number, makeId?: () => string }} [options]
 * @returns {object} 状态对象。
 */
export function createWhaleState(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : PENDING_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const makeId = typeof options.makeId === 'function' ? options.makeId : () => makeEventId(now());

  /** @type {Map<string, {dismissed:boolean, greeted:boolean, lastAt:number, history:string[]}>} */
  const sessions = new Map();
  /** @type {Map<string, {id:string, at:number, deliveredAt:number|null, readyAt:number|null}>} */
  const pending = new Map();

  /** 会话 id 归一：空值统一落到 'unknown'，保证 click / status 用的是同一个键。 */
  function keyOf(sessionId) {
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown';
  }

  function session(sessionId) {
    const key = keyOf(sessionId);
    let entry = sessions.get(key);
    if (entry === undefined) {
      entry = { dismissed: false, greeted: false, lastAt: 0, history: [] };
      sessions.set(key, entry);
    }
    entry.lastAt = now();
    return entry;
  }

  /** 丢掉过期事件；返回仍有效的事件或 undefined。 */
  function live(sessionId) {
    const key = keyOf(sessionId);
    const entry = pending.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.at > ttlMs) {
      pending.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    /** 读取（并按需创建）会话记录。 */
    session,

    /** 本会话是否已经被用户关掉。 */
    isDismissed(sessionId) {
      return sessions.get(keyOf(sessionId))?.dismissed === true;
    },

    /**
     * 标记「用户关掉了本会话的挂件」。
     * @returns {boolean} 本次调用是否改变了状态（用于只注入一次说明）。
     */
    dismiss(sessionId) {
      const entry = session(sessionId);
      const changed = !entry.dismissed;
      entry.dismissed = true;
      pending.delete(keyOf(sessionId));
      return changed;
    },

    /** 重新打开本会话的挂件（用户改主意时用）。 */
    undismiss(sessionId) {
      const entry = session(sessionId);
      const changed = entry.dismissed;
      entry.dismissed = false;
      return changed;
    },

    /** 是否已经在本会话注入过开头上下文。 */
    isGreeted(sessionId) {
      return sessions.get(keyOf(sessionId))?.greeted === true;
    },

    /** 标记开头上下文已注入；返回 true 表示这次应该注入。 */
    takeGreeting(sessionId) {
      const entry = session(sessionId);
      if (entry.greeted) return false;
      entry.greeted = true;
      return true;
    },

    /**
     * 用户点了一下挂件：为这个会话登记一个新事件。
     * 同一会话已有未投递事件时直接替换（后来的点击覆盖前一次，避免积压）。
     * @param {string} sessionId - 目标会话 id。
     * @returns {{id:string, at:number}} 新事件。
     */
    click(sessionId) {
      const entry = { id: makeId(), at: now(), deliveredAt: null, readyAt: null };
      pending.set(keyOf(sessionId), entry);
      const record = session(sessionId);
      record.history.unshift(entry.id);
      if (record.history.length > HISTORY_LIMIT) record.history.length = HISTORY_LIMIT;
      return { id: entry.id, at: entry.at };
    },

    /** 是否有一个「还没投递给模型」的有效事件。 */
    hasUndelivered(sessionId) {
      const entry = live(sessionId);
      return entry !== undefined && entry.deliveredAt === null;
    },

    /**
     * 投递（消费）事件：返回它并标记已投递。同一个事件只会被投递一次。
     * @returns {{id:string, at:number}|undefined}
     */
    deliver(sessionId) {
      const entry = live(sessionId);
      if (entry === undefined || entry.deliveredAt !== null) return undefined;
      entry.deliveredAt = now();
      return { id: entry.id, at: entry.at };
    },

    /** 客户端查询用：这个会话现在的挂件状态。 */
    status(sessionId) {
      const entry = live(sessionId);
      const record = sessions.get(keyOf(sessionId));
      return {
        dismissed: record?.dismissed === true,
        greeted: record?.greeted === true,
        phase: entry === undefined ? 'idle' : entry.deliveredAt === null ? 'queued' : 'delivered',
        eventId: entry?.id ?? null,
        clickedAt: entry?.at ?? null,
        deliveredAt: entry?.deliveredAt ?? null,
        lastEventId: record?.history[0] ?? null,
        lastAt: record?.lastAt ?? 0,
      };
    },

    /** 显式清掉某会话的待处理事件（例如用户关掉挂件）。 */
    clear(sessionId) {
      return pending.delete(keyOf(sessionId));
    },

    /** 测试/诊断用：当前有事件的会话快照。 */
    snapshot() {
      return {
        sessions: [...sessions.entries()].map(([id, value]) => ({ id, ...value })),
        pending: [...pending.entries()].map(([id, value]) => ({ sessionId: id, ...value })),
      };
    },
  };
}
