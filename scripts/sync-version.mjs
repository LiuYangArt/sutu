#!/usr/bin/env node
/**
 * 版本同步脚本
 * 将 package.json 中的版本号同步到 tauri.conf.json 和 Cargo.toml
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));

console.log(`📦 同步版本号: ${version}`);

// 同步到 tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
const oldTauriVersion = tauriConf.version;
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`   ✅ tauri.conf.json: ${oldTauriVersion} → ${version}`);

// 同步到 Cargo.toml
const cargoPath = join(rootDir, 'src-tauri', 'Cargo.toml');
const cargoContent = readFileSync(cargoPath, 'utf-8');
const oldCargoVersion = cargoContent.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';
const newCargoContent = cargoContent.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
writeFileSync(cargoPath, newCargoContent);
console.log(`   ✅ Cargo.toml: ${oldCargoVersion} → ${version}`);

console.log('\n🎉 版本同步完成！');
