import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { SESSION_TEXT, DISMISSED_TEXT } from '../lib/copy.js';
import {
  createFakeCtx, createFakeAgent, createFakeAgents,
  callRoute, nextEnter,
} from './helpers.mjs';

/** 起一个装好插件的宿主替身。 */
function setup(options = {}) {
  const agents = options.agents ?? [];
  const harness = createFakeCtx({
    services: {
      agents: createFakeAgents(agents, options.agentsOptions),
      sessionProjections: { stateOf: (session, key) => (key === 'title' ? session?.__title : undefined) },
    },
    webServer: options.webServer,
  });
  apply(harness.ctx, options.config ?? {});
  return harness;
}

/* ─────────────────────────── 路由 ─────────────────────────── */

test('注册了四个 /whisper-whale 路由', () => {
  const h = setup();
  for (const path of ['/whisper-whale/targets', '/whisper-whale/state', '/whisper-whale/click', '/whisper-whale/mute']) {
    assert.ok(h.route(path), '缺少路由 ' + path);
  }
  assert.deepEqual(h.routes.map((r) => r.kind), ['exact', 'exact', 'exact', 'exact']);
});

test('没有 webServer（TUI / headless 档案）时插件照样加载：不注册路由，但拦截点在线', () => {
  const h = setup({ webServer: null });
  assert.equal(h.routes.length, 0, '没有 webServer 就不该有路由');
  for (const event of ['agent/created', 'agent/pre-step', 'tools/post-execute', 'agent/turn-stopping']) {
    assert.equal(h.handlers(event).length, 1, event + ' 监听器必须照常注册');
  }
  assert.equal(h.logs.warn.length, 0, '缺少可选的传输层不该报错');
  assert.ok(h.ctx.get('whisperWhale'));
});

test('非回环地址一律 403', async () => {
  const h = setup();
  for (const path of ['/whisper-whale/targets', '/whisper-whale/state', '/whisper-whale/click']) {
    const res = await callRoute(h.route(path), { method: 'POST', remoteAddress: '10.0.0.9' });
    assert.equal(res.statusCode, 403, path);
  }
});

test('方法不对返回 405', async () => {
  const h = setup();
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('/targets 只列正在工作的会话', async () => {
  const busy = createFakeAgent('s-busy', { title: '写文档' });
  const idle = createFakeAgent('s-idle', { status: 'idle', title: '闲着' });
  const child = createFakeAgent('s-child', { status: 'running' });
  const h = setup({ agents: [busy, idle, child], agentsOptions: { roots: [busy, idle] } });

  const res = await callRoute(h.route('/whisper-whale/targets'), { method: 'GET' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.targets.map((t) => t.id), ['s-busy']);
  assert.equal(body.targets[0].title, '写文档');
});

test('click：没有在跑的对话 → idle', async () => {
  const h = setup({ agents: [] });
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: {} });
  assert.equal(res.json().reason, 'idle');
});

test('click：多个对话在跑 → 返回清单等用户选', async () => {
  const a = createFakeAgent('s-a', { title: 'A' });
  const b = createFakeAgent('s-b', { title: 'B' });
  const h = setup({ agents: [a, b] });
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: {} });
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'ambiguous');
  assert.equal(body.targets.length, 2);
});

test('click：指定了会话就直接派发，并返回事件 id', async () => {
  const a = createFakeAgent('s-a', { title: 'A' });
  const b = createFakeAgent('s-b', { title: 'B' });
  const h = setup({ agents: [a, b] });
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-b' } });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.target.id, 's-b');
  assert.match(body.eventId, /^w-/);
});

test('click：目标已经消失 → gone；没有事件被登记', async () => {
  const h = setup({ agents: [] });
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 'nope' } });
  assert.equal(res.json().reason, 'gone');
});

test('click：被静音过的会话直接拒绝', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/mute'), { method: 'POST', body: { sessionId: 's-a', muted: true } });
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });
  assert.equal(res.json().reason, 'muted');
});

test('state 反映 queued → delivered', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });

  let res = await callRoute(h.route('/whisper-whale/state'), { method: 'GET', url: '/whisper-whale/state?sessionId=s-a' });
  assert.equal(res.json().status.phase, 'queued');

  const [preStep] = h.handlers('agent/pre-step');
  await preStep({ agent: a, messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }], turn: 1 }, () => Promise.resolve(nextEnter()));

  res = await callRoute(h.route('/whisper-whale/state'), { method: 'GET', url: '/whisper-whale/state?sessionId=s-a' });
  assert.equal(res.json().status.phase, 'delivered');
});

test('mute 会往会话里注入一次性说明', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/mute'), { method: 'POST', body: { sessionId: 's-a', muted: true } });
  assert.equal(a.injected.length, 1);
  assert.equal(a.injected[0].content[0].text, DISMISSED_TEXT);
  assert.equal(a.injected[0].role, 'user');
  assert.equal(a.injected[0].source.kind, 'whisper-whale');
  assert.ok(Object.isFrozen(a.injected[0]));
  assert.ok(typeof a.injected[0].id === 'string' && a.injected[0].id.length > 10);
});

/* ─────────────────────────── 拦截点 ─────────────────────────── */

test('agent/created：顶层对话注入一次开头上下文，子代理不打扰', async () => {
  const top = createFakeAgent('s-top');
  const child = createFakeAgent('s-child');
  const h = setup({ agents: [top, child], agentsOptions: { roots: [top] } });
  const [created] = h.handlers('agent/created');

  created({ agent: top });
  created({ agent: top });
  created({ agent: child });

  assert.equal(top.injected.length, 1);
  assert.equal(top.injected[0].content[0].text, SESSION_TEXT);
  assert.equal(child.injected.length, 0);
});

test('agent/pre-step：把提醒追加到这一步入参消息末尾', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });

  const [preStep] = h.handlers('agent/pre-step');
  const original = { role: 'user', content: [{ type: 'text', text: '继续' }] };
  const entered = await preStep({ agent: a, messages: [original], turn: 1 }, () => Promise.resolve(nextEnter([original])));

  assert.equal(entered.kind, 'enter');
  assert.equal(entered.messages.length, 2);
  assert.equal(entered.messages[0], original, '原消息必须原样保留');
  assert.ok(entered.messages[1].content[0].text.includes('有什么要补充的吗'));

  const again = await preStep({ agent: a, messages: [original], turn: 1 }, () => Promise.resolve(nextEnter([original])));
  assert.equal(again.messages.length, 1);
});

test('agent/pre-step：下游 reject 时原样透传，不硬塞消息', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });
  const [preStep] = h.handlers('agent/pre-step');
  const rejected = { kind: 'reject' };
  const out = await preStep({ agent: a, messages: [{ role: 'user', content: [] }], turn: 1 }, () => Promise.resolve(rejected));
  assert.equal(out, rejected);
});

test('agent/pre-step：识别「关掉挂件」并只注入一次说明', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  const [preStep] = h.handlers('agent/pre-step');
  const message = { role: 'user', content: [{ type: 'text', text: '关掉挂件吧' }] };

  const first = await preStep({ agent: a, messages: [message], turn: 1 }, () => Promise.resolve(nextEnter([message])));
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[1].content[0].text, DISMISSED_TEXT);

  const second = await preStep({ agent: a, messages: [message], turn: 1 }, () => Promise.resolve(nextEnter([message])));
  assert.equal(second.messages.length, 1);

  await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });
  const third = await preStep({ agent: a, messages: [message], turn: 1 }, () => Promise.resolve(nextEnter([message])));
  assert.equal(third.messages.length, 1);
});

test('不会把自己的开头上下文当成「关掉挂件」指令（文案里就有这四个字）', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  const [preStep] = h.handlers('agent/pre-step');

  // 模拟真实时序：会话开头的 user 消息（source.kind = whisper-whale）先入队，
  // 然后才轮到用户本轮的发言。真实 harness 里就是这么排的（e2e 实测）。
  const greeting = { role: 'user', content: [{ type: 'text', text: SESSION_TEXT }], source: { kind: 'whisper-whale' } };
  const userTurn = { role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } };

  await preStep({ agent: a, messages: [greeting, userTurn], turn: 1 }, () => Promise.resolve(nextEnter([greeting, userTurn])));

  const clicked = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });
  assert.equal(clicked.json().ok, true, '自己的开头上下文不能把自己关掉');
});

test('别的插件注入的上下文同样不会被当成关闭指令', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  const [preStep] = h.handlers('agent/pre-step');
  const others = { role: 'user', content: [{ type: 'text', text: '把挂件关掉' }], source: { kind: 'hooks-claude-code' } };
  await preStep({ agent: a, messages: [others], turn: 1 }, () => Promise.resolve(nextEnter([others])));
  const clicked = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });
  assert.equal(clicked.json().ok, true);
});

test('tools/post-execute：把提醒挂成 additionalContexts', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });

  const [postExec] = h.handlers('tools/post-execute');
  const downstream = { kind: 'result', additionalContexts: [{ marker: 'theirs' }] };
  const out = await postExec({ agent: a, name: 'pwsh' }, { content: [] }, () => Promise.resolve(downstream));

  assert.equal(out.additionalContexts.length, 2);
  assert.equal(out.additionalContexts[0].content[0].text.includes('有什么要补充的吗'), true);
  assert.deepEqual(out.additionalContexts[1], { marker: 'theirs' }, '下游 context 不能被吃掉');

  const again = await postExec({ agent: a, name: 'pwsh' }, { content: [] }, () => Promise.resolve({ kind: 'result' }));
  assert.equal(again.additionalContexts, undefined);
});

test('agent/turn-stopping：事件还没投出去就 steer 一步', async () => {
  const a = createFakeAgent('s-a');
  const h = setup({ agents: [a] });
  await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-a' } });

  const [stopping] = h.handlers('agent/turn-stopping');
  stopping({ agent: a, turn: 1 });
  assert.equal(a.steered.length, 1);
  assert.ok(a.steered[0].content[0].text.includes('有什么要补充的吗'));

  stopping({ agent: a, turn: 1 });
  assert.equal(a.steered.length, 1, '重复触发不能形成死循环');
});

test('拦截点里抛错只记 warning：不冒泡、也不吞掉 next()', async () => {
  const injectBomb = {
    id: 's-bomb',
    status: 'running',
    session: { header: { id: 's-bomb', cwd: 'D:\\x' } },
    inject() { throw new Error('boom-inject'); },
    steer() { throw new Error('boom-steer'); },
  };
  const idBomb = {
    get id() { throw new Error('boom-id'); },
    session: { header: {} },
  };

  const h = createFakeCtx({
    services: {
      agents: {
        list: () => [injectBomb],
        roots: () => [injectBomb, idBomb],
        get: () => injectBomb,
      },
      sessionProjections: { stateOf: () => { throw new Error('boom-proj'); } },
    },
  });
  apply(h.ctx, {});

  const clicked = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: { sessionId: 's-bomb' } });
  assert.equal(clicked.json().ok, true);

  let nextCalls = 0;
  await assert.doesNotReject(async () => {
    for (const handler of h.handlers('agent/created')) await handler({ agent: injectBomb });
    for (const handler of h.handlers('agent/pre-step')) {
      await handler({ agent: idBomb, messages: [] }, () => { nextCalls += 1; return Promise.resolve(nextEnter()); });
    }
    for (const handler of h.handlers('tools/post-execute')) {
      await handler({ get agent() { throw new Error('boom-exec'); } }, {}, () => Promise.resolve({ kind: 'result' }));
    }
    for (const handler of h.handlers('agent/turn-stopping')) await handler({ agent: injectBomb });
  });

  assert.equal(nextCalls, 1, 'next() 必须仍然被调用一次');
  assert.ok(h.logs.warn.length >= 3, '每次失败都该留下 warning，实际 ' + h.logs.warn.length + ' 条');
});

test('roots() 抛错时按「顶层」处理，不因为探测失败就静默丢功能', async () => {
  const agent = createFakeAgent('s-a');
  const h = createFakeCtx({
    services: {
      agents: { list: () => [agent], roots: () => { throw new Error('boom'); }, get: () => agent },
      sessionProjections: { stateOf: () => undefined },
    },
  });
  apply(h.ctx, {});
  const res = await callRoute(h.route('/whisper-whale/targets'), { method: 'GET' });
  assert.deepEqual(res.json().targets.map((t) => t.id), ['s-a']);
});

test('缺少 agents 服务时路由不炸，click 返回 idle', async () => {
  const h = createFakeCtx({ services: {} });
  apply(h.ctx, {});
  const res = await callRoute(h.route('/whisper-whale/click'), { method: 'POST', body: {} });
  assert.equal(res.json().reason, 'idle');
});

test('ctx.whisperWhale 服务与 HTTP 路由共用同一份实现', async () => {
  const a = createFakeAgent('s-a', { title: 'A' });
  const h = setup({ agents: [a] });
  const api = h.ctx.get('whisperWhale');
  assert.ok(api, '必须 provide whisperWhale 服务');
  assert.deepEqual(api.targets().map((t) => t.id), ['s-a']);

  const clicked = api.click('s-a');
  assert.equal(clicked.ok, true);
  assert.match(clicked.eventId, /^w-/);
  assert.equal(api.status('s-a').phase, 'queued');

  const res = await callRoute(h.route('/whisper-whale/state'), { method: 'GET', url: '/whisper-whale/state?sessionId=s-a' });
  assert.equal(res.json().status.eventId, clicked.eventId);

  api.mute('s-a');
  assert.equal(api.status('s-a').dismissed, true);
  assert.equal(a.injected.length, 1, '关掉时要给模型一句说明');
});

test('路由 dispose 会挂到 ctx.effect 上（插件卸载即摘路由）', () => {
  const h = setup();
  assert.equal(h.effects.length, 4);
  assert.ok(h.effects.every((e) => typeof e.dispose === 'function'));
});
