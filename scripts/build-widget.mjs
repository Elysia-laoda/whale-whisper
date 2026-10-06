#!/usr/bin/env node
/**
 * build-widget.mjs
 * 把 @modelcontextprotocol/ext-apps 的浏览器 bundle（app-with-deps.js）
 * 离线内联进 widget.template.html，生成 widget.html。
 *
 * 处理方式：
 *   - ext-apps 的 app-with-deps.js 是一个以 `export {...};` 结尾的单文件 ESM bundle。
 *   - 我们剥离结尾的 export 语句，改为挂在 `globalThis.__SUPP_EXT__` 上，
 *     这样挂件页面无需任何 CDN / 网络请求即可离线运行（对国内网络友好）。
 *
 * 用法：node scripts/build-widget.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const pkgDir = path.join(root, 'mcp-server', 'node_modules', '@modelcontextprotocol', 'ext-apps');
const tplPath = path.join(root, 'mcp-server', 'widget', 'widget.template.html');
const outPath = path.join(root, 'mcp-server', 'widget', 'widget.html');

/** 找到 app-with-deps.js（兼容不同的小版本目录结构） */
function findBundle(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name === 'app-with-deps.js') return p;
    }
  }
  return null;
}

const bundlePath = findBundle(pkgDir);
if (!bundlePath) {
  console.error('[build] 未找到 app-with-deps.js，请先在 mcp-server/ 目录执行 npm install');
  process.exit(1);
}

let pkgVersion = 'unknown';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
} catch { /* ignore */ }

let bundle = fs.readFileSync(bundlePath, 'utf8');

// 1) 剥离结尾的 export {...};
const m = bundle.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/);
if (!m) {
  console.error('[build] 未在 bundle 中找到结尾的 export 语句，无法转换（上游结构可能变化）');
  process.exit(1);
}
const body = bundle.slice(0, m.index);

// 2) 解析导出名列表 -> globalThis.__SUPP_EXT__ 赋值
const entries = m[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((item) => {
    const mm = item.match(/^([A-Za-z0-9_$]+)\s+as\s+"?([A-Za-z0-9_$]+)"?$/);
    if (mm) return [mm[2], mm[1]];
    const plain = item.match(/^"([A-Za-z0-9_$]+)"$/);
    if (plain) return [plain[1], plain[1]];
    return [item, item];
  });

const assigns = entries
  .map(([alias, local]) =>
    `try { globalThis.__SUPP_EXT__[${JSON.stringify(alias)}] = ${local}; } catch (e) {}`)
  .join('\n');

const injected =
  '\n/* @modelcontextprotocol/ext-apps@' + pkgVersion + ' — 离线内联 bundle（export 转为 globalThis.__SUPP_EXT__） */\n' +
  'globalThis.__SUPP_EXT__ = globalThis.__SUPP_EXT__ || {};\n' +
  body +
  '\n;\n' + assigns + '\n';

// 3) 注入模板
const tpl = fs.readFileSync(tplPath, 'utf8');
if (!tpl.includes('/*__SUPP_EXT_BUNDLE__*/')) {
  console.error('[build] 模板中缺少 /*__SUPP_EXT_BUNDLE__*/ 占位符');
  process.exit(1);
}
const out = tpl.replace('/*__SUPP_EXT_BUNDLE__*/', () => injected); // 函数替换，避免 $ 转义问题
fs.writeFileSync(outPath, out);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('[build] bundle: ' + path.relative(root, bundlePath) + ' (' + kb(bundle.length) + ')');
console.log('[build] 输出:   ' + path.relative(root, outPath) + ' (' + kb(out.length) + ')');
console.log('[build] 完成 ✓  （>256KB 时宿主会改为运行时拉取资源，属正常降级路径）');
