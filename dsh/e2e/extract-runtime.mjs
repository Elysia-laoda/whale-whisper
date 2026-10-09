#!/usr/bin/env node
/**
 * 把安装版 app.asar 里的 DSH 运行时解出来，供 e2e 使用。
 *
 *   node e2e/extract-runtime.mjs --asar "D:/DSH/resources/app.asar" --out D:/dshproject/_ref/dsh-runtime
 *
 * asar 的布局：| u32=4 | u32=header 缓冲长度 | u32=header payload | u32=json 长度 | json | 文件数据 |
 * 所以数据段起点是 8 + (第 2 个 u32)。文件在 JSON 里的 offset 是相对该起点的。
 * （踩坑记录：一开始按「8 + json 长度」算起点，解出来的文件全部错位。）
 */
import { existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgv } from '../scripts/profile-io.mjs';

function readHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const headerBufferLength = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonLength);
  readSync(fd, json, 0, jsonLength, 16);
  return { fd, header: JSON.parse(json.toString('utf8')), dataOffset: 8 + headerBufferLength };
}

function collect(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? prefix + '/' + name : name;
    if (entry.files) collect(entry, path, out);
    else out.push({ path, size: entry.size, offset: entry.offset, unpacked: entry.unpacked });
  }
}

const options = parseArgv(process.argv.slice(2));
const asarPath = options.asar ?? 'D:/DSH/resources/app.asar';
const outDir = options.out ?? './_ref/dsh-runtime';
if (!existsSync(asarPath)) {
  process.stderr.write('找不到 asar：' + asarPath + '\n');
  process.exit(1);
}

const { fd, header, dataOffset } = readHeader(asarPath);
const all = [];
collect(header, '', all);
const targets = all.filter((f) => f.path === 'dsh' || f.path.startsWith('dsh/'));
let written = 0;
let bytes = 0;
let skipped = 0;
for (const file of targets) {
  if (file.unpacked) { skipped += 1; continue; }
  const dest = join(outDir, file.path.slice(4));
  mkdirSync(dirname(dest), { recursive: true });
  const buffer = Buffer.alloc(file.size);
  if (file.size > 0) readSync(fd, buffer, 0, file.size, dataOffset + Number(file.offset));
  writeFileSync(dest, buffer);
  written += 1;
  bytes += file.size;
}
closeSync(fd);

const unpackedDir = options['asar-unpacked'] ?? join(dirname(asarPath), 'app.asar.unpacked', 'dsh');
if (existsSync(unpackedDir)) cpSync(unpackedDir, outDir, { recursive: true });

process.stdout.write(`解出 ${written} 个文件（${(bytes / 1048576).toFixed(1)} MB），跳过 ${skipped} 个已 unpack 的原生模块\n`);
process.stdout.write('运行时目录：' + outDir + '\n');
process.stdout.write('入口：' + join(outDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js') + '\n');
