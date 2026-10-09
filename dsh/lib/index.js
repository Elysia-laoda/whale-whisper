/**
 * dsh-whisper-whale — 宿主半（host half）。
 *
 * 参考实现：https://github.com/Elysia-laoda/whale-whisper （WorkBuddy 版
 * 「补充提示挂件」）。DSH 版把外挂的桌面挂件换成了 DSH Web GUI 里的常驻小鲸鱼，
 * 把「配置文件 + 四个钩子进程」换成了进程内的原生 cordis 插件。
 *
 * 它做两件事：
 *
 *   1. 在本地 web 服务器上注册四个 `/whisper-whale/*` 路由，供浏览器半使用：
 *         GET  /whisper-whale/targets   列出「正在工作中」的会话
 *         GET  /whisper-whale/state     查询某会话的挂件状态（气泡用）
 *         POST /whisper-whale/click     用户点了小鲸鱼 —— 登记一个待处理事件
 *         POST /whisper-whale/mute      本会话开/关挂件
 *      只接受回环地址的请求。
 *
 *   2. 挂在 harness 的三个拦截点上，把待处理事件投递给模型：
 *         agent/created       会话开头注入一次「挂件是什么、收到事件怎么办」
 *         agent/pre-step      用户发言时消费事件（并识别「关掉挂件」意图）
 *         tools/post-execute  任务运行中的主路径：工具跑完立刻带上提醒
 *         agent/turn-stopping 兜底：回合要结束了还没投递 → steer() 再走一步
 *
 * 设计原则（沿用参考实现）：绝不阻塞、绝不抛错。任何一个拦截点里出错都只记一条
 * warning 然后放行——挂件坏了不能把用户的会话搞坏。
 *
 * @module dsh-whisper-whale
 */
import { randomUUID } from 'node:crypto';
import { SESSION_TEXT, DISMISSED_TEXT, isDismissIntent, pendingText } from './copy.js';
import { createWhaleState } from './whale-state.js';

/** 插件身份（cordis.yml 行里显示的名字）。 */
export const name = 'whisper-whale';

/**
 * 刻意不声明必需服务。
 *
 * 拦截注入（agent/created、agent/pre-step、tools/post-execute、agent/turn-stopping）
 * 在任何档案里都该工作；web 服务器只是**浏览器挂件的传输层**，没有它的档案
 * （TUI / headless）里插件照样能通过 ctx.whisperWhale 被别的插件驱动。
 * 之前的写法把 webServer 设成必需依赖，结果是 TUI/headless 档案里整条链都不装载、
 * 启动日志还会多出一条 "entry did not activate" 警告。
 */
export const inject = [];

/** 路由前缀。 */
const ROUTE_PREFIX = '/whisper-whale';

/** 请求体上限，防止一个畸形请求把内存吃掉。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 判定回环地址：挂件只服务本机浏览器。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function isLoopback(req) {
  try {
    const address = req?.socket?.remoteAddress;
    if (typeof address !== 'string') return false;
    return LOOPBACK.has(address);
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch {
    try { res.destroy(); } catch { /* 已经断了 */ }
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish(undefined);
          try { req.destroy(); } catch { /* ignore */ }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw.length === 0) return finish({});
        try { finish(JSON.parse(raw)); } catch { finish(undefined); }
      });
      req.on('error', () => finish(undefined));
      req.on('aborted', () => finish(undefined));
    } catch {
      finish(undefined);
    }
  });
}

/** 深冻结一条消息，和 @deepseek-ai/dsh-llm 的 createMessage 保持同一形状。 */
function frozenMessage(message) {
  const clone = { ...message, content: message.content.map((block) => ({ ...block })) };
  for (const block of clone.content) Object.freeze(block);
  Object.freeze(clone.content);
  Object.freeze(clone.source);
  return Object.freeze(clone);
}

/**
 * 造一条注入用的 user 消息。刻意不 import @deepseek-ai/dsh-llm：
 * 形状是稳定的（id/role/content/source），自己造可以把插件的运行时依赖降到零。
 */
function whisperMessage(text) {
  return frozenMessage({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'whisper-whale' },
  });
}

/**
 * 把「真人输入」的文本拼起来，用于「关掉挂件」意图识别。
 *
 * 只取没有 `source` 的 user 消息 / `source.kind === 'user'` 的消息：带其它
 * source 的都是插件或系统注入的上下文。这一条是必须的 —— 本插件自己的会话开头
 * 上下文就是一条 user 消息，而它的文案里写着「若用户说过『关掉挂件』…」。如果连
 * 它一起扫，插件会在第一个回合把自己关掉（这个坑真实踩过，见 tests/host.test.mjs
 * 的「不会把自己的开头上下文当成关闭指令」）。
 *
 * @param messages - agent/pre-step 这一步 claim 到的消息。
 * @returns 拼接后的文本；读不动就返回空串。
 */
function flattenText(messages) {
  try {
    const parts = [];
    for (const message of messages ?? []) {
      if (message?.role !== 'user') continue;
      const kind = message.source?.kind;
      if (kind !== undefined && kind !== 'user') continue;
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/**
 * 插件正文。
 * @param ctx - 宿主 cordis 上下文。
 * @param config - cordis.yml 里的 config（可选）。
 */
export function apply(ctx, config = {}) {
  const state = createWhaleState({
    ttlMs: Number.isFinite(config.ttlMinutes) ? config.ttlMinutes * 60_000 : undefined,
  });

  const warn = (where, error) => {
    try { ctx.logger?.warn?.(`whisper-whale: ${where} failed: ${String(error)}`); } catch { /* logger 不可用也不能抛 */ }
  };
  /** 安全求值：任何异常都降级成 undefined，绝不让拦截点炸掉。 */
  const safe = (where, fn) => {
    try { return fn(); } catch (error) { warn(where, error); return undefined; }
  };

  const agentsService = () => safe('ctx.get(agents)', () => ctx.get('agents'));

  /** 会话标题：优先用 title 投影，退回到 header，最后空串。 */
  function sessionTitle(agent) {
    return safe('sessionTitle', () => {
      const projections = ctx.get('sessionProjections');
      const projected = projections?.stateOf?.(agent.session, 'title');
      if (typeof projected === 'string' && projected.trim().length > 0) return projected.trim();
      const header = agent?.session?.header;
      if (typeof header?.title === 'string' && header.title.length > 0) return header.title;
      return '';
    }) ?? '';
  }

  /** 「正在工作中」的会话列表（与参考实现只列 working 对话一致）。 */
  function runningTargets() {
    return safe('runningTargets', () => {
      const agents = agentsService();
      if (typeof agents?.list !== 'function') return [];
      const out = [];
      for (const agent of agents.list()) {
        try {
          if (agent?.status !== 'running') continue;
          // 子代理在跑是父对话回合里的一步，不该单独出现在选择清单里
          if (!isTopLevel(agent)) continue;
          out.push({
            id: agent.id,
            title: sessionTitle(agent),
            cwd: typeof agent.session?.header?.cwd === 'string' ? agent.session.header.cwd : '',
          });
        } catch { /* 单个会话读不动就跳过 */ }
      }
      return out.reverse();
    }) ?? [];
  }

  /** 顶层 agent 才算「对话」；子代理继承的是父对话的回合，不该单独提醒。 */
  function isTopLevel(agent) {
    const verdict = safe('isTopLevel', () => {
      const agents = agentsService();
      if (typeof agents?.roots !== 'function') return true;
      return agents.roots().includes(agent);
    });
    return verdict !== false;
  }

  /* ────────────────────────── 挂件能力（路由与 ctx.whisperWhale 共用） ────────────────────────── */

  /**
   * 派发一次点击。同一个函数既是 HTTP 路由的实现，也是 ctx.whisperWhale.click()
   * 的实现 —— 别的插件（快捷键、托盘、自动化脚本）可以走服务，行为完全一致。
   * @param requested - 指定会话 id，或 null 表示「按当前唯一在跑的对话自动选」。
   * @returns 结构化结果：ok / reason / eventId / target / targets。
   */
  function performClick(requested) {
    const targets = runningTargets();
    if (requested === null) {
      if (targets.length === 0) return { ok: false, reason: 'idle', targets: [] };
      if (targets.length > 1) return { ok: false, reason: 'ambiguous', targets };
    }
    const match = requested === null ? targets[0] : targets.find((item) => item.id === requested);
    if (requested !== null && match === undefined) {
      // 不在「正在工作」清单里：可能刚收尾。只要 agent 还活着就登记，等它下次活动。
      const live = safe('agents.get', () => agentsService()?.get?.(requested));
      if (live === undefined || live === null) return { ok: false, reason: 'gone', targets };
    }
    const target = match ?? { id: requested, title: '', cwd: '' };
    if (state.isDismissed(target.id)) {
      return { ok: false, reason: 'muted', target: { id: target.id, title: target.title }, targets };
    }
    const event = state.click(target.id);
    return {
      ok: true,
      eventId: event.id,
      target: { id: target.id, title: target.title, cwd: target.cwd },
      targets,
    };
  }

  /**
   * 开/关某个会话的挂件。关掉时顺手往会话里注入一句说明，模型不会继续等挂件。
   * @param sessionId - 目标会话。
   * @param muted - true = 本会话不再理会挂件。
   * @returns 该会话最新的挂件状态。
   */
  function performMute(sessionId, muted) {
    if (muted) state.dismiss(sessionId);
    else state.undismiss(sessionId);
    const agent = safe('agents.get', () => agentsService()?.get?.(sessionId));
    if (muted && agent && typeof agent.inject === 'function') {
      safe('mute.inject', () => agent.inject(whisperMessage(DISMISSED_TEXT)));
    }
    return state.status(sessionId);
  }

  /* ────────────────────────── HTTP 路由（浏览器半 → 宿主） ────────────────────────── */

  const routes = [
      {
        kind: 'exact',
        path: ROUTE_PREFIX + '/targets',
        handler: (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' });
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method' });
          sendJson(res, 200, { ok: true, targets: runningTargets() });
        },
      },
      {
        kind: 'exact',
        path: ROUTE_PREFIX + '/state',
        handler: (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' });
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method' });
          let sessionId = '';
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            sessionId = url.searchParams.get('sessionId') ?? '';
          } catch { /* 保持空 */ }
          sendJson(res, 200, { ok: true, status: state.status(sessionId) });
        },
      },
      {
        kind: 'exact',
        path: ROUTE_PREFIX + '/click',
        handler: async (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' });
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method' });
          const body = await readJsonBody(req);
          if (body === undefined) return sendJson(res, 400, { ok: false, reason: 'bad-body' });
          const requested = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null;
          return sendJson(res, 200, performClick(requested));
        },
      },
      {
        kind: 'exact',
        path: ROUTE_PREFIX + '/mute',
        handler: async (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' });
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method' });
          const body = await readJsonBody(req);
          if (body === undefined) return sendJson(res, 400, { ok: false, reason: 'bad-body' });
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          if (sessionId.length === 0) return sendJson(res, 400, { ok: false, reason: 'bad-body' });
          return sendJson(res, 200, { ok: true, status: performMute(sessionId, body.muted !== false) });
        },
      },
    ];

  // 路由只在有 web 服务器时注册。ctx.inject 会等它出现（并在它消失时自动摘掉路由），
  // 所以档案装配顺序变了也不会漏注册。
  safe('webServer scope', () => {
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer = httpCtx?.webServer ?? ctx.get('webServer');
      if (!webServer || typeof webServer.register !== 'function') return;
      for (const route of routes) {
        try {
          const dispose = webServer.register(route);
          if (typeof dispose === 'function') {
            httpCtx.effect(() => dispose, `whisper-whale: route ${route.path}`);
          }
        } catch (error) {
          warn(`register ${route.path}`, error);
        }
      }
    });
  });

  /* ────────────────────────── 对其他插件暴露的服务 ────────────────────────── */

  // ctx.whisperWhale —— 别的插件（快捷键、托盘、自动化脚本、测试驱动）可以走
  // 这里触发一次「补充提示」，不必自己拼 HTTP 请求。路由与它共用同一份实现。
  safe('provide', () => ctx.provide('whisperWhale', {
    /** 正在工作中的顶层对话。 */
    targets: () => runningTargets(),
    /** 触发一次点击；sessionId 省略时按当前唯一在跑的对话自动选。 */
    click: (sessionId) => performClick(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null),
    /** 开/关某会话的挂件。 */
    mute: (sessionId, muted = true) => performMute(sessionId, muted !== false),
    /** 某会话的挂件状态（气泡轮询用的同一份数据）。 */
    status: (sessionId) => state.status(sessionId ?? ''),
  }));

  /* ────────────────────────── 拦截点（宿主 → 模型） ────────────────────────── */

  // 1) 会话开头：讲清挂件机制。顶层对话注入一次，子代理不打扰。
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!agent || typeof agent.inject !== 'function') return;
      if (!isTopLevel(agent)) return;
      if (state.isDismissed(agent.id)) return;
      if (!state.takeGreeting(agent.id)) return;
      agent.inject(whisperMessage(SESSION_TEXT));
    } catch (error) {
      warn('agent/created', error);
    }
  });

  // 2) 用户发言：识别「关掉挂件」意图，并消费待处理事件。
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    let injection;
    try {
      if (agent) {
        const text = flattenText(messages);
        if (text.length > 0 && isDismissIntent(text)) {
          if (state.dismiss(agent.id)) {
            injection = whisperMessage(DISMISSED_TEXT);
          }
        }
        if (injection === undefined && !state.isDismissed(agent.id)) {
          const delivered = state.deliver(agent.id);
          if (delivered !== undefined) injection = whisperMessage(pendingText(delivered.id));
        }
      }
    } catch (error) {
      warn('agent/pre-step', error);
      injection = undefined;
    }
    const downstream = await next();
    if (injection === undefined) return downstream;
    try {
      if (downstream?.kind !== 'enter') return downstream;
      return { ...downstream, messages: [...downstream.messages, injection] };
    } catch (error) {
      warn('agent/pre-step.merge', error);
      return downstream;
    }
  });

  // 3) 任务运行中的主路径：每次工具跑完都看一眼有没有人点了小鲸鱼。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    let injection;
    try {
      const agent = exec?.agent;
      if (agent && !state.isDismissed(agent.id)) {
        const delivered = state.deliver(agent.id);
        if (delivered !== undefined) injection = whisperMessage(pendingText(delivered.id));
      }
    } catch (error) {
      warn('tools/post-execute', error);
      injection = undefined;
    }
    const downstream = await next();
    if (injection === undefined) return downstream;
    try {
      const inherited = Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : undefined;
      return { ...downstream, additionalContexts: inherited ? [injection, ...inherited] : [injection] };
    } catch (error) {
      warn('tools/post-execute.merge', error);
      return downstream;
    }
  });

  // 4) 兜底：回合马上要结束了，事件还没投出去 → 再走一步，先把问题问了。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      if (!agent || typeof agent.steer !== 'function') return;
      if (state.isDismissed(agent.id)) return;
      if (!state.hasUndelivered(agent.id)) return;
      const delivered = state.deliver(agent.id);
      if (delivered === undefined) return;
      agent.steer(whisperMessage(pendingText(delivered.id)));
    } catch (error) {
      warn('agent/turn-stopping', error);
    }
  });

  try {
    ctx.logger?.info?.('whisper-whale: 小鲸鱼已就位 —— 点右下角的 🐋，AI 会在下一个动作里问你要补充什么');
  } catch { /* ignore */ }
}
