#!/usr/bin/env node
/**
 * 端到端自测跑手：建临时档案 → 装驱动 + 装插件 → 跑一次 → 收集 [e2e] 结论。
 *
 *   node e2e/run.mjs --runtime D:/dshproject/_ref/dsh-runtime --home D:/dshproject/_e2ehome
 *   node e2e/run.mjs --runtime ... --home ... --keep     # 保留临时档案便于排查
 *   node e2e/run.mjs --runtime ... --home ... --api-key sk-...   # 跑真实模型（会真的花 token）
 *
 * 注意：清理临时档案时用的是 removeTree()——`fs.rmSync(recursive)` 在 Windows 上会
 * 穿透目录联接，而 `--link` 安装造出来的正是联接，直接 rmSync 会把插件源码删掉。
 */
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv, removeTree } from '../scripts/profile-io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const options = parseArgv(process.argv.slice(2));

const runtime = options.runtime ?? 'D:/dshproject/_ref/dsh-runtime';
const home = resolve(options.home ?? 'D:/dshproject/_e2ehome');
const profile = options.profile ?? 'whalee2e';
const bin = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const profileDir = join(home, 'profiles', profile);

function fail(message) {
  process.stderr.write('e2e: ' + message + '\n');
  process.exit(1);
}

if (!existsSync(bin)) fail('运行时入口不存在：' + bin + '（先跑 e2e/extract-runtime.mjs）');

// 1) 建临时档案（从 headless 模板）
removeTree(join(home, 'profiles', profile));
const init = spawnSync(process.execPath, [bin, '--from-default-profile', 'headless', '--profile', profile, '--dump-config'], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
});
if (init.status !== 0) fail('初始化档案失败：' + (init.stderr || init.stdout));

// 2) 驱动必须先注册（waterfall 里才是外层，能看到插件合并后的结果）
const driverDir = join(profileDir, 'node_modules', 'whale-e2e-driver');
mkdirSync(driverDir, { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'index.js']) {
  cpSync(join(here, 'whale-e2e-driver', file), join(driverDir, file));
}

// 3) 装本插件，并把驱动排在它前面
const install = spawnSync(process.execPath, [join(packageRoot, 'scripts/install.mjs'), '--home', home, '--profile', profile, '--link', '--json'], { encoding: 'utf8' });
if (install.status !== 0) fail('安装插件失败：' + (install.stderr || install.stdout));

const manifestPath = join(profileDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== 'dsh-whisper-whale' && name !== 'whale-e2e-driver');
manifest.dsh.profile.bundles.push('whale-e2e-driver', 'dsh-whisper-whale');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// 4) 跑
const env = { ...process.env, DSH_HOME: home, WHALE_E2E_DELAY_MS: '0' };
if (typeof options['api-key'] === 'string') env.DEEPSEEK_API_KEY = options['api-key'];

process.stdout.write('e2e: runtime=' + runtime + '\nhome=' + home + ' profile=' + profile + '\n\n');
let output = '';
try {
  const run = spawnSync(process.execPath, [bin, '--profile', profile, options.prompt ?? '随便说一句你好就行。'], {
    env,
    encoding: 'utf8',
    timeout: Number(options.timeout ?? 180) * 1000,
  });
  output = (run.stdout ?? '') + (run.stderr ?? '');
} finally {
  // 无论成败都要清干净；这里必须用 removeTree，否则会顺着 --link 的联接删掉源码
  if (!options.keep) removeTree(join(home, 'profiles', profile));
}

for (const line of output.split(/\r?\n/)) {
  if (line.includes('[e2e]') || line.includes('MISSING_CREDENTIAL')) process.stdout.write(line + '\n');
}

const checks = [
  ['click 成功派发', /\[e2e\] click -> \{"ok":true,"eventId":"w-/],
  ['会话开头上下文进入请求', /PASS 会话开头上下文已进入请求/],
  ['pre-step 投递', /PASS pre-step 收到事件提醒/],
  ['post-execute 投递', /PASS post-execute 注入了事件提醒/],
  ['post-execute 保留下游 context', /theirsKept=true/],
  ['turn-stopping 兜底投递', /派发之后 phase=delivered/],
];
process.stdout.write('\n');
let failed = 0;
for (const [label, pattern] of checks) {
  const ok = pattern.test(output);
  if (!ok) failed += 1;
  process.stdout.write((ok ? '  ✔ ' : '  ✖ ') + label + '\n');
}
process.stdout.write('\n' + (failed === 0 ? 'e2e: 全部通过' : `e2e: ${failed} 项未通过`) + '\n');
process.exitCode = failed === 0 ? 0 : 1;
