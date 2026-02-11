#!/usr/bin/env node
/**
 * 图标资源同步脚本：
 * 1. 以源图生成 Tauri 全套图标资源
 * 2. 同步前端使用的 public/icon.png
 */

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, extname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const iconsDir = join(rootDir, 'src-tauri', 'icons');
const defaultSourcePath = join(iconsDir, 'icon.png');
const publicIconPath = join(rootDir, 'public', 'icon.png');
const tauriCliEntry = join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const sourceArg = process.argv[2];
const sourcePath = sourceArg
  ? isAbsolute(sourceArg)
    ? sourceArg
    : resolve(process.cwd(), sourceArg)
  : defaultSourcePath;

if (!existsSync(sourcePath)) {
  fail(`❌ 源图不存在: ${sourcePath}`);
}

const ext = extname(sourcePath).toLowerCase();
if (!['.png', '.svg'].includes(ext)) {
  fail(`❌ 仅支持 PNG 或 SVG 作为源图: ${sourcePath}`);
}

log(`🎨 使用源图: ${sourcePath}`);
if (!existsSync(tauriCliEntry)) {
  fail(`❌ 未找到 Tauri CLI: ${tauriCliEntry}`);
}

log('⚙️  正在生成 Tauri 图标资源...');

const result = spawnSync(
  process.execPath,
  [tauriCliEntry, 'icon', sourcePath, '--output', iconsDir],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

if (result.error) {
  fail(`❌ 执行 tauri icon 失败: ${result.error.message}`);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const generatedMainIcon = join(iconsDir, 'icon.png');
if (!existsSync(generatedMainIcon)) {
  fail(`❌ 未找到生成结果: ${generatedMainIcon}`);
}

mkdirSync(dirname(publicIconPath), { recursive: true });
copyFileSync(generatedMainIcon, publicIconPath);
log(`✅ 已同步前端图标: ${publicIconPath}`);
log('🎉 图标资源更新完成');
