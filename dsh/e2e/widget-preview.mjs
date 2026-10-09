#!/usr/bin/env node
/**
 * 把**真实的浏览器半**渲染成 PNG，用来肉眼检查挂件的视觉。
 *
 *   node e2e/widget-preview.mjs                 # 深色主题
 *   node e2e/widget-preview.mjs --theme light   # 浅色主题
 *   node e2e/widget-preview.mjs --out D:/tmp/w.png --chrome <chrome.exe>
 *
 * 做法：用 jsdom 加载 lib/client.js（和 dsh-client-modules 一样先注册工厂再 apply），
 * 跑出真实 DOM + 真实注入的 CSS，再交给 headless Chrome 截图。
 *
 * 为什么要这么麻烦：`npm test` 只能验结构（元素在不在、文案对不对），看不到
 * 布局。这个工具上线第一天就抓到两个结构性测试永远抓不到的 bug：
 *   1. 气泡是 56px 宽容器里的绝对定位元素，只写 right:64px 会把可用宽度算成负数，
 *      收缩成「一个字一列」的竖条 —— 必须 width:max-content；
 *   2. 主题探测只看 document.body 的背景，DSH 的底色在别处时永远判成深色。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArgv } from '../scripts/profile-io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const options = parseArgv(process.argv.slice(2));
const theme = options.theme === 'light' ? 'light' : 'dark';
const out = resolve(options.out ?? join(here, 'out', `widget-${theme}.png`));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const chrome = options.chrome ?? CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  process.stderr.write('找不到 Chrome/Edge，用 --chrome <path> 指定\n');
  process.exit(1);
}

const require = createRequire(join(packageRoot, 'package.json'));
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  process.stderr.write('缺少 jsdom（devDependency）：先在包目录跑 npm install\n');
  process.exit(1);
}

const SOURCE = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
const bg = theme === 'light' ? '#f4f6fb' : '#171b24';
const fg = theme === 'light' ? '#101828' : '#e7ebf3';

/** 用真实的 client.js 跑出一个场景，返回它的 window。 */
function scene({ targets, click }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:19387/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.document.body.style.background = bg;
  window.document.body.style.color = fg;
  window.fetch = (url) => {
    const p = String(url).split('?')[0];
    if (p === '/whisper-whale/targets') return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, targets }) });
    if (p === '/whisper-whale/click') return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, eventId: 'w-1', target: targets[0] ?? {}, targets }) });
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, status: { phase: 'queued' } }) });
  };
  let registration = null;
  window.__ModuleLoader__ = { load: (d) => { registration = d; } };
  window.eval(SOURCE);
  registration.factory().apply({ effect: () => {} });
  if (click) {
    const btn = window.document.querySelector('.dshww-btn');
    for (const type of ['pointerdown', 'pointerup']) {
      btn.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 }));
    }
  }
  return window;
}

const idle = scene({ targets: [{ id: 's-1', title: '写文档' }], click: false });
const clicked = scene({ targets: [{ id: 's-1', title: '写文档' }], click: true });
const picker = scene({ targets: [{ id: 's-a', title: '重构登录模块', cwd: 'D:\\a' }, { id: 's-b', title: '写周报', cwd: 'D:\\b' }], click: true });
await new Promise((r) => setTimeout(r, 150));

function block(window, caption, title) {
  const doc = window.document;
  const style = doc.querySelector('[data-dshww="style"]');
  const body = doc.body.cloneNode(true);
  body.querySelectorAll('[data-dshww="style"]').forEach((n) => n.remove());
  return `<figure><figcaption>${title}</figcaption>
    <div class="scene">${style ? '<style>' + style.textContent + '</style>' : ''}${body.innerHTML}</div>
    <p>${caption}</p></figure>`;
}

// 中间 HTML 放临时目录：产物目录里只该有图片
const htmlPath = join(tmpdir(), 'dsh-whisper-whale-preview.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;padding:18px;background:${bg};color:${fg};
       font:13px/1.6 "Segoe UI",system-ui,sans-serif;display:flex;gap:18px;align-items:flex-start}
  figure{margin:0;display:flex;flex-direction:column;gap:8px}
  figcaption{font-size:12px;opacity:.55;letter-spacing:.04em}
  p{margin:0;font-size:12px;opacity:.5}
  .scene{position:relative;transform:translateZ(0);width:420px;height:300px;border-radius:16px;overflow:hidden;
         border:1px solid ${theme === 'light' ? 'rgba(15,23,42,.10)' : 'rgba(255,255,255,.09)'}}
</style>
${block(idle, '只有鲸鱼本体', '待机')}
${block(clicked, '气泡（点一下之后）', '已通知')}
${block(picker, '清单 + 数字角标', '多个对话在跑')}
`);

const run = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'dsh-whisper-whale-preview'),
  '--virtual-time-budget=1500', '--screenshot=' + out, '--window-size=1340,420',
  'file:///' + htmlPath.replace(/\\/g, '/'),
], { encoding: 'utf8' });
if (!existsSync(out)) {
  process.stderr.write('截图失败：\n' + (run.stderr || '') + (run.stdout || ''));
  process.exit(1);
}
process.stdout.write('已渲染 ' + theme + ' 主题 → ' + out + '\n（看一眼再下结论：没读图就不算做过视觉验证）\n');
