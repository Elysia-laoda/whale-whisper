import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDismissIntent, pendingText, SESSION_TEXT, CLICK_SEQ, ASK_TOOL } from '../lib/copy.js';

test('识别「关掉挂件」的各种说法', () => {
  const yes = [
    '关掉挂件',
    '把挂件关掉吧',
    '不需要悬浮窗了',
    '别再开小鲸鱼了',
    '挂件不用了',
    '收掉挂件',
  ];
  for (const text of yes) assert.equal(isDismissIntent(text), true, text);
});

test('正常发言不会被误判成关掉挂件', () => {
  const no = [
    '帮我改一下挂件的颜色',
    '这个挂件是怎么实现的？',
    '继续',
    '关掉那个文件',
    '',
    null,
    undefined,
  ];
  for (const text of no) assert.equal(isDismissIntent(text), false, String(text));
});

test('注入文案要求立刻提问、带事件 id、只在下一个动作', () => {
  const text = pendingText('w-abc-123');
  assert.ok(text.includes('w-abc-123'), '必须带事件 id');
  assert.ok(text.includes(ASK_TOOL), '必须点名提问工具');
  assert.ok(text.includes('立刻'), '必须要求立刻提问');
  assert.ok(text.includes('有什么要补充的吗'), '必须有那句问法');
});

test('会话开头文案讲清机制且不主动提前收尾', () => {
  assert.ok(SESSION_TEXT.includes(ASK_TOOL));
  assert.ok(SESSION_TEXT.includes('关掉挂件'));
  assert.ok(SESSION_TEXT.includes('只处理一次'));
  assert.ok(CLICK_SEQ.length >= 3 && CLICK_SEQ[0].includes('已通知'));
});
