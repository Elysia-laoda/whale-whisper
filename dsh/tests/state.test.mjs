import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhaleState, PENDING_TTL_MS, makeEventId } from '../lib/whale-state.js';

function clocked(start = 1_000_000) {
  let now = start;
  const state = createWhaleState({ now: () => now, makeId: makeEventId(start, () => 0.5) });
  return { state, tick: (ms) => { now += ms; }, at: () => now };
}

test('makeEventId 稳定且带前缀', () => {
  const id = makeEventId(1234567, () => 0.25);
  assert.match(id, /^w-[0-9a-z]+-[0-9a-z]{3}$/);
  assert.equal(id, makeEventId(1234567, () => 0.25));
});

test('点击 → 待投递 → 投递一次；重复投递返回 undefined', () => {
  const { state } = clocked();
  const event = state.click('s1');
  assert.equal(state.status('s1').phase, 'queued');
  assert.equal(state.hasUndelivered('s1'), true);

  const delivered = state.deliver('s1');
  assert.equal(delivered.id, event.id);
  assert.equal(state.status('s1').phase, 'delivered');
  assert.equal(state.deliver('s1'), undefined);
  assert.equal(state.hasUndelivered('s1'), false);
});

test('同一个会话再点一次会覆盖上一次（不积压）', () => {
  const { state, tick } = clocked();
  state.click('s1');
  tick(10);
  const second = state.click('s1');
  assert.equal(state.status('s1').eventId, second.id);
  assert.equal(state.snapshot().pending.length, 1);
});

test('事件 15 分钟后过期', () => {
  const { state, tick } = clocked();
  state.click('s1');
  tick(PENDING_TTL_MS - 1);
  assert.equal(state.hasUndelivered('s1'), true);
  tick(2);
  assert.equal(state.hasUndelivered('s1'), false);
  assert.equal(state.status('s1').phase, 'idle');
});

test('会话之间互不串台', () => {
  const { state } = clocked();
  state.click('s1');
  assert.equal(state.hasUndelivered('s2'), false);
  assert.equal(state.deliver('s2'), undefined);
  assert.equal(state.hasUndelivered('s1'), true);
});

test('dismiss 会清掉待处理事件，并且只报告一次变化', () => {
  const { state } = clocked();
  state.click('s1');
  assert.equal(state.dismiss('s1'), true);
  assert.equal(state.dismiss('s1'), false);
  assert.equal(state.hasUndelivered('s1'), false);
  assert.equal(state.isDismissed('s1'), true);
  assert.equal(state.undismiss('s1'), true);
  assert.equal(state.isDismissed('s1'), false);
});

test('开头上下文每个会话只注入一次', () => {
  const { state } = clocked();
  assert.equal(state.takeGreeting('s1'), true);
  assert.equal(state.takeGreeting('s1'), false);
  assert.equal(state.isGreeted('s1'), true);
  assert.equal(state.takeGreeting('s2'), true);
});

test('空 sessionId 归一到 unknown 而不是抛错', () => {
  const { state } = clocked();
  state.click('');
  assert.equal(state.status('unknown').phase, 'queued');
  assert.equal(state.hasUndelivered(''), true, 'click 与 deliver 必须用同一个键');
});
