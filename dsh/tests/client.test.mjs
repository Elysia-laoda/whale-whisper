import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/**
 * 在一个 jsdom 页里把浏览器半加载起来，和 dsh-client-modules 的做法一致：
 * 先注册工厂（页面加载时执行一次），再在插件启用时调用 apply(ctx)。
 */
function mount(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:19387/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const calls = [];
  const routes = options.routes ?? {};
  window.fetch = (url, init) => {
    const path = String(url);
    calls.push({ path, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[path.split('?')[0]];
    const result = typeof handler === 'function' ? handler(path, init) : handler;
    if (result === undefined) {
      return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false, reason: 'not-found' }) });
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve(result) });
  };

  let registration = null;
  window.__ModuleLoader__ = { load: (definition) => { registration = definition; } };
  window.eval(CLIENT_SOURCE);
  assert.ok(registration, 'bundle 必须通过 __ModuleLoader__.load 注册工厂');
  assert.equal(registration.id, 'dsh-whisper-whale');

  const exported = registration.factory();
  // 跨 realm 的数组原型不同，只断言形状
  assert.equal(Array.isArray(exported.inject), true);
  assert.equal(exported.inject.length, 0);
  assert.equal(typeof exported.apply, 'function');

  const disposers = [];
  const fakeCtx = { effect: (fn) => { disposers.push(fn()); } };
  exported.apply(fakeCtx);

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const q = (selector) => window.document.querySelector(selector);

  return { dom, window, calls, q, flush, dispose: () => disposers.forEach((fn) => fn && fn()) };
}

function pointer(window, element, type, props) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...props });
  if (props && props.pointerId !== undefined) {
    Object.defineProperty(event, 'pointerId', { value: props.pointerId });
  }
  element.dispatchEvent(event);
}

function clickWhale(window, q) {
  const button = q('.dshww-btn');
  pointer(window, button, 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
  pointer(window, button, 'pointerup', { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
}

test('挂件挂进 DOM：一只可点的鲸鱼 + 气泡 + 卡片 + 右键菜单', () => {
  const app = mount();
  assert.ok(app.q('[data-dshww="root"]'), '根节点存在');
  assert.ok(app.q('.dshww-btn svg'), '鲸鱼是内联 SVG（无需外部资源）');
  assert.ok(app.q('.dshww-bubble'));
  assert.ok(app.q('.dshww-card'));
  assert.equal(app.q('.dshww-root').style.right, '20px');
  assert.equal(app.q('.dshww-root').style.bottom, '20px');
});

test('单个对话在跑：点一下直接派发，并回一句「已通知 AI」', async () => {
  const app = mount({
    routes: {
      '/whisper-whale/targets': { ok: true, targets: [{ id: 's-1', title: '写文档', cwd: 'D:\\docs' }] },
      '/whisper-whale/click': { ok: true, eventId: 'w-1', target: { id: 's-1', title: '写文档' } },
      '/whisper-whale/state': { ok: true, status: { phase: 'queued' } },
    },
  });
  clickWhale(app.window, app.q);
  await app.flush();

  const click = app.calls.find((c) => c.path === '/whisper-whale/click');
  assert.ok(click, '必须真的 POST 了 /click');
  assert.equal(click.method, 'POST');
  assert.equal(click.body.sessionId, 's-1');
  assert.match(app.q('.dshww-bubble').textContent, /已通知 AI/);
  assert.ok(app.q('.dshww-ping'), '点一下要有一圈涟漪');
});

test('没有正在工作的对话：只提示，不发请求', async () => {
  const app = mount({ routes: { '/whisper-whale/targets': { ok: true, targets: [] } } });
  clickWhale(app.window, app.q);
  await app.flush();

  assert.equal(app.calls.some((c) => c.path === '/whisper-whale/click'), false);
  assert.match(app.q('.dshww-bubble').textContent, /没有正在工作的对话/);
});

test('多个对话在跑：先弹清单，点谁就通知谁', async () => {
  const targets = [
    { id: 's-a', title: '重构登录', cwd: 'D:\\a' },
    { id: 's-b', title: '写周报', cwd: 'D:\\b' },
  ];
  const app = mount({
    routes: {
      '/whisper-whale/targets': { ok: true, targets },
      '/whisper-whale/click': { ok: true, eventId: 'w-2', target: targets[1] },
      '/whisper-whale/state': { ok: true, status: { phase: 'queued' } },
    },
  });
  clickWhale(app.window, app.q);
  await app.flush();

  const card = app.q('.dshww-card');
  assert.ok(card.classList.contains('dshww-on'), '清单要展开');
  const rows = card.querySelectorAll('.dshww-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /重构登录/);

  rows[1].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await app.flush();

  const click = app.calls.find((c) => c.path === '/whisper-whale/click');
  assert.equal(click.body.sessionId, 's-b');
  assert.equal(card.classList.contains('dshww-on'), false, '选完要收起');
});

test('宿主半没起来（404）：明说挂件没接上，而不是默默无反应', async () => {
  const app = mount({ routes: {} });
  clickWhale(app.window, app.q);
  await app.flush();
  assert.match(app.q('.dshww-bubble').textContent, /没接上 DSH 宿主/);
});

test('拖动会记住位置，而且不会被误判成点击', async () => {
  const app = mount({
    routes: {
      '/whisper-whale/targets': { ok: true, targets: [{ id: 's-1', title: 'x' }] },
      '/whisper-whale/click': { ok: true, eventId: 'w-3', target: { id: 's-1' } },
    },
  });
  const button = app.q('.dshww-btn');
  pointer(app.window, button, 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 7 });
  pointer(app.window, button, 'pointermove', { clientX: 140, clientY: 130, pointerId: 7 });
  pointer(app.window, button, 'pointerup', { clientX: 140, clientY: 130, pointerId: 7 });
  await app.flush();

  assert.equal(app.calls.some((c) => c.path === '/whisper-whale/click'), false, '拖动不该当成点击');
  const stored = JSON.parse(app.window.localStorage.getItem('dshWhisperWhale.pos'));
  assert.equal(typeof stored.right, 'number');
  assert.equal(typeof stored.bottom, 'number');
});

test('右键弹菜单，菜单里能隐藏小鲸鱼并留下一个回来的小圆点', async () => {
  const app = mount();
  const button = app.q('.dshww-btn');
  const menuEvent = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  button.dispatchEvent(menuEvent);
  assert.equal(menuEvent.defaultPrevented, true);
  assert.ok(app.q('.dshww-menu').classList.contains('dshww-on'));

  const items = [...app.q('.dshww-menu').querySelectorAll('button')];
  const hide = items.find((b) => b.textContent.includes('隐藏'));
  hide.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));

  assert.equal(app.q('[data-dshww="root"]').style.display, 'none');
  assert.ok(app.q('.dshww-tab').classList.contains('dshww-on'));
  assert.equal(app.window.localStorage.getItem('dshWhisperWhale.hidden'), '1');

  app.q('.dshww-tab').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  assert.equal(app.q('[data-dshww="root"]').style.display, '');
});

test('插件卸载（ctx.effect 的 disposer）会把挂件从页面上摘干净', () => {
  const app = mount();
  assert.ok(app.q('[data-dshww="root"]'));
  app.dispose();
  assert.equal(app.q('[data-dshww="root"]'), null);
  assert.equal(app.q('.dshww-menu'), null);
  assert.equal(app.q('[data-dshww="style"]'), null);
});

test('把接口暴露在 window.__whisperWhale 上，方便用户在控制台微调', () => {
  const app = mount();
  assert.equal(typeof app.window.__whisperWhale.hint, 'function');
  app.window.__whisperWhale.hint('测试文案');
  assert.equal(app.q('.dshww-bubble').textContent, '测试文案');
});
