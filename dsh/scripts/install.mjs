#!/usr/bin/env node
/**
 * dsh-whisper-whale 一键安装。
 *
 *   node scripts/install.mjs                       # 装进 $DSH_PROFILE（默认 desktop）
 *   node scripts/install.mjs --profile web         # 装进指定档案
 *   node scripts/install.mjs --home D:\\dshhome    # 指定 DSH_HOME
 *   node scripts/install.mjs --link                # 软链而不是复制（改代码免重装）
 *   node scripts/install.mjs --dry-run             # 只说不做
 *   node scripts/install.mjs --json                # 输出机器可读结果
 *
 * 做两件事（都不碰会被重写的 cordis.yml）：
 *   1. 把包放进 <profile>/node_modules/dsh-whisper-whale；
 *   2. 把包名追加进 <profile>/package.json 的 dsh.profile.bundles，
 *      启动时会自动叠加本包的 cordis.patch.yml（插入 loader entry）。
 * 每个被改的文件先备份成 .bak-<时间戳>。装完需要重启 DSH 生效。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_NAME, addBundle, parseArgv, placePackage, readJson,
  resolveHome, resolveProfileDir, resolveProfileName, timestamp,
} from './profile-io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(here, '..');

async function main() {
  const options = parseArgv(process.argv.slice(2));
  const home = resolveHome(options);
  const profile = resolveProfileName(options);
  const profileDir = resolveProfileDir(options);
  const manifestPath = join(profileDir, 'package.json');
  const dryRun = options['dry-run'] === true;
  const asJson = options.json === true;

  const report = { home, profile, profileDir, sourceDir, dryRun, steps: [], ok: false, warnings: [] };

  if (!existsSync(profileDir)) {
    report.warnings.push(`档案目录不存在：${profileDir} —— 先用 \`dsh --from-default-profile web --profile ${profile}\` 建一个，或检查 --profile/--home`);
    return finish(report, asJson, 1);
  }
  if (!existsSync(manifestPath)) {
    report.warnings.push('档案里没有 package.json：' + manifestPath);
    return finish(report, asJson, 1);
  }

  // 先读一遍，确认它确实是个 DSH 档案，避免写错目录。
  const manifest = readJson(manifestPath);
  if (!manifest?.dsh) report.warnings.push('这个 package.json 里没有 dsh 段，可能不是 DSH 档案，仍按 --profile 指定的位置继续');

  if (dryRun) {
    report.steps.push({ action: 'place-package', target: join(profileDir, 'node_modules', PACKAGE_NAME), mode: options.link ? 'link' : 'copy' });
    report.steps.push({ action: 'add-bundle', manifest: manifestPath, bundle: PACKAGE_NAME });
    report.ok = true;
    return finish(report, asJson, 0);
  }

  const suffix = timestamp();
  const placed = placePackage(sourceDir, profileDir, { link: options.link === true });
  report.steps.push({ action: 'place-package', target: placed.target, mode: placed.mode });

  const bundleResult = addBundle(manifestPath, suffix);
  report.steps.push({
    action: 'add-bundle',
    manifest: manifestPath,
    changed: bundleResult.changed,
    backup: bundleResult.changed ? manifestPath + '.bak-' + suffix : null,
    bundles: bundleResult.bundles,
  });

  report.ok = true;
  return finish(report, asJson, 0);
}

function finish(report, asJson, code) {
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = code;
    return;
  }
  const lines = [];
  lines.push(`\n🐋 dsh-whisper-whale 安装${report.dryRun ? '（预演，未写入）' : ''}`);
  lines.push(`   DSH_HOME : ${report.home}`);
  lines.push(`   档案     : ${report.profile}`);
  lines.push(`   包位置   : ${report.profileDir}\\node_modules\\${PACKAGE_NAME}`);
  for (const step of report.steps) {
    if (step.action === 'place-package') lines.push(`   · 已${step.mode === 'link' ? '链接' : '复制'}包 → ${step.target}`);
    if (step.action === 'add-bundle') {
      lines.push(step.changed
        ? `   · 已追加到 dsh.profile.bundles，原文件备份为 ${step.backup}`
        : '   · dsh.profile.bundles 里已经有了，跳过');
    }
  }
  for (const warning of report.warnings) lines.push('   ⚠ ' + warning);
  if (report.ok && !report.dryRun) {
    lines.push('');
    lines.push('   下一步：完全退出并重开 DSH（插件在启动时装载）。');
    lines.push('   重开之后，对话窗口右下角会出现一只小鲸鱼；任务跑着的时候点它一下。');
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write('安装失败：' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
