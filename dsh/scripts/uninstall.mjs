#!/usr/bin/env node
/**
 * dsh-whisper-whale 一键卸载：`node scripts/uninstall.mjs [--profile desktop] [--home ...] [--dry-run]`
 *
 * 精确反向执行安装：从 dsh.profile.bundles 摘掉包名、从 dependencies 摘掉 link 依赖、
 * 删掉 node_modules 里的包目录，最后跑一次 pnpm install 让 lockfile 与 node_modules 复位。
 * 不碰用户的 cordis.patch.yml（安装时也没写过它）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACKAGE_NAME, parseArgv, removeBundle, removeDependency, removePackage, readJson,
  resolveHome, resolveProfileDir, resolveProfileName, runPnpmInstall, timestamp,
} from './profile-io.mjs';

async function main() {
  const options = parseArgv(process.argv.slice(2));
  const home = resolveHome(options);
  const profile = resolveProfileName(options);
  const profileDir = resolveProfileDir(options);
  const manifestPath = join(profileDir, 'package.json');
  const dryRun = options['dry-run'] === true;
  const asJson = options.json === true;

  const report = { home, profile, profileDir, dryRun, steps: [], ok: false, warnings: [] };

  if (!existsSync(profileDir)) {
    report.warnings.push('档案目录不存在：' + profileDir);
    return finish(report, asJson, 1);
  }

  if (dryRun) {
    report.steps.push({ action: 'remove-bundle', manifest: manifestPath });
    report.steps.push({ action: 'remove-dependency', manifest: manifestPath });
    report.steps.push({ action: 'remove-package', target: join(profileDir, 'node_modules', PACKAGE_NAME) });
    report.steps.push({ action: 'pnpm-install', profileDir });
    report.ok = true;
    return finish(report, asJson, 0);
  }

  const suffix = timestamp();
  const bundleResult = removeBundle(manifestPath, suffix);
  report.steps.push({ action: 'remove-bundle', changed: bundleResult.changed, backup: bundleResult.changed ? manifestPath + '.bak-' + suffix : null });

  const depResult = removeDependency(manifestPath, suffix);
  report.steps.push({ action: 'remove-dependency', changed: depResult.changed, backup: depResult.changed ? manifestPath + '.bak-' + suffix : null });

  const removed = removePackage(profileDir);
  report.steps.push({ action: 'remove-package', removed });

  if (options['no-pnpm'] !== true && depResult.changed) {
    const pnpmResult = runPnpmInstall(profileDir);
    report.steps.push({ action: 'pnpm-install', ok: pnpmResult.ok });
    if (!pnpmResult.ok) report.warnings.push('pnpm install 没跑成功，请手动在档案目录执行一次 pnpm install');
  }

  report.ok = true;
  return finish(report, asJson, 0);
}

function finish(report, asJson, code) {
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = code;
    return;
  }
  const lines = ['\n🐋 dsh-whisper-whale 卸载' + (report.dryRun ? '（预演，未写入）' : '')];
  for (const step of report.steps) {
    if (step.action === 'remove-bundle') lines.push(step.changed ? `   · 已从 dsh.profile.bundles 摘掉（备份 ${step.backup}）` : '   · bundles 里本来就没有');
    if (step.action === 'remove-dependency') lines.push(step.changed ? `   · 已从 dependencies 摘掉（备份 ${step.backup}）` : '   · dependencies 里本来就没有');
    if (step.action === 'remove-package') lines.push(step.removed ? '   · 已删除 node_modules 里的包目录' : '   · node_modules 里本来就没有');
    if (step.action === 'pnpm-install') lines.push(step.ok ? '   · pnpm install 完成，lockfile 已同步' : '   · pnpm install 失败');
  }
  for (const warning of report.warnings) lines.push('   ⚠ ' + warning);
  if (report.ok && !report.dryRun) lines.push('\n   重启 DSH 之后小鲸鱼就消失了。\n');
  else lines.push('');
  process.stdout.write(lines.join('\n'));
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write('卸载失败：' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
