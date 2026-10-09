/**
 * 测试用替身：一个够用的 cordis 上下文 + 假的 agent / webServer。
 * 不依赖任何 @deepseek-ai 包，跑起来就是 `node --test`。
 */
import { EventEmitter } from 'node:events';

export function createFakeCtx(options = {}) {
  const listeners = new Map();
  const effects = [];
  const routes = [];
  const logs = { info: [], warn: [], debug: [] };
  const provided = {};

  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      debug: (m) => logs.debug.push(String(m)),
    },
    get(name) {
      if (name in provided) return provided[name];
      if (name in (options.services ?? {})) return options.services[name];
      return undefined;
    },
    provide(name, value) {
      provided[name] = value;
      return () => { delete provided[name]; };
    },
    /** 极简 ctx.inject：依赖齐了就跑，回调里注册的 effect 归这个作用域。 */
    inject(deps, callback) {
      const scoped = { ...ctx, effect: ctx.effect };
      let ran = false;
      const run = () => {
        if (ran) return;
        if (!deps.every((name) => ctx.get(name) !== undefined)) return;
        ran = true;
        callback(scoped);
      };
      run();
      return () => { ran = false; };
    },
    effect(fn, label) {
      const dispose = typeof fn === 'function' ? fn() : undefined;
      effects.push({ label, dispose });
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
  };

  if (options.webServer !== null) {
    ctx.webServer = {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    };
    ctx.get = (name) => {
      if (name === 'webServer') return ctx.webServer;
      if (name in provided) return provided[name];
      return (options.services ?? {})[name];
    };
  }

  return {
    ctx,
    logs,
    effects,
    routes,
    handlers(event) { return listeners.get(event) ?? []; },
    async emit(event, ...args) {
      const out = [];
      for (const handler of listeners.get(event) ?? []) out.push(await handler(...args));
      return out;
    },
    route(path) { return routes.find((r) => r.path === path); },
  };
}

export function createFakeAgent(id, options = {}) {
  const agent = {
    id,
    status: options.status ?? 'running',
    injected: [],
    steered: [],
    session: {
      header: { id, cwd: options.cwd ?? 'D:\\demo', title: options.title },
      __title: options.title,
    },
    inject(message) { agent.injected.push(message); },
    steer(message) { agent.steered.push(message); },
  };
  return agent;
}

export function createFakeAgents(agents, options = {}) {
  const roots = options.roots ?? agents;
  return {
    list: () => [...agents],
    roots: () => [...roots],
    get: (id) => agents.find((a) => a.id === id),
  };
}

/** 造一个够用的 IncomingMessage。 */
export function fakeRequest({ method = 'GET', url = '/', body, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress };
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** 造一个记录型 ServerResponse。 */
export function fakeResponse() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    destroyed: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { if (chunk !== undefined) res.body += chunk; res.ended = true; },
    destroy() { res.destroyed = true; },
    json() { return JSON.parse(res.body || '{}'); },
  };
  return res;
}

export async function callRoute(route, options) {
  const req = fakeRequest(options);
  const res = fakeResponse();
  await route.handler(req, res);
  return res;
}

export function nextEnter(messages = []) {
  return { kind: 'enter', messages };
}
