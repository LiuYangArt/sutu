#!/usr/bin/env node
/**
 * 应用命名同步脚本
 * 将 app.meta.json 作为单一来源，同步到各配置文件与常量文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const appMetaPath = join(rootDir, 'app.meta.json');
const packageJsonPath = join(rootDir, 'package.json');
const tauriConfPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
const capabilitiesPath = join(rootDir, 'src-tauri', 'capabilities', 'default.json');
const generatedCapabilitiesPath = join(rootDir, 'src-tauri', 'gen', 'schemas', 'capabilities.json');
const frontendMetaPath = join(rootDir, 'src', 'constants', 'appMeta.ts');
const rustMetaPath = join(rootDir, 'src-tauri', 'src', 'app_meta.rs');

const appMeta = JSON.parse(readFileSync(appMetaPath, 'utf-8'));

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function replaceTomlStringValueInSection(content, section, key, value) {
  const sectionRegex = new RegExp(`(\\[${section}\\][\\s\\S]*?)(?=\\n\\[|$)`);
  return content.replace(sectionRegex, (block) => {
    const keyRegex = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, 'm');
    if (keyRegex.test(block)) {
      return block.replace(keyRegex, `${key} = "${value}"`);
    }
    const trimmed = block.trimEnd();
    return `${trimmed}\n${key} = "${value}"\n`;
  });
}

function escapeRustString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

log(`📛 同步应用命名: ${appMeta.displayName} (${appMeta.displayNameZh})`);

// package.json
{
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  pkg.name = appMeta.npmPackageName;
  writeJson(packageJsonPath, pkg);
  log(`   ✅ package.json name -> ${appMeta.npmPackageName}`);
}

// tauri.conf.json
{
  const tauri = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
  tauri.productName = appMeta.displayName;
  tauri.identifier = appMeta.identifier;
  if (tauri.app?.windows && Array.isArray(tauri.app.windows)) {
    tauri.app.windows = tauri.app.windows.map((win) => ({
      ...win,
      title: appMeta.displayName,
    }));
  }
  writeJson(tauriConfPath, tauri);
  log(`   ✅ tauri.conf.json productName/identifier/title`);
}

// capabilities/default.json
{
  const caps = JSON.parse(readFileSync(capabilitiesPath, 'utf-8'));
  caps.description = `Default capabilities for ${appMeta.displayName}`;
  writeJson(capabilitiesPath, caps);
  log(`   ✅ capabilities/default.json description`);
}

// gen/schemas/capabilities.json
{
  if (existsSync(generatedCapabilitiesPath)) {
    const generated = JSON.parse(readFileSync(generatedCapabilitiesPath, 'utf-8'));
    if (generated.default && typeof generated.default === 'object') {
      generated.default.description = `Default capabilities for ${appMeta.displayName}`;
    }
    writeJson(generatedCapabilitiesPath, generated);
    log(`   ✅ gen/schemas/capabilities.json description`);
  } else {
    log(`   ↷ skip gen/schemas/capabilities.json (file not found)`);
  }
}

// Cargo.toml
{
  let cargo = readFileSync(cargoTomlPath, 'utf-8');
  cargo = replaceTomlStringValueInSection(cargo, 'package', 'name', appMeta.rustPackageName);
  cargo = replaceTomlStringValueInSection(cargo, 'lib', 'name', appMeta.rustLibName);
  cargo = cargo.replace(/^authors\s*=\s*\[[^\]]*\]/m, `authors = ["${appMeta.teamName}"]`);
  writeFileSync(cargoTomlPath, cargo);
  log(`   ✅ Cargo.toml package/lib/authors`);
}

// 前端常量
{
  mkdirSync(dirname(frontendMetaPath), { recursive: true });
  const ts = `export const APP_META = {
  displayName: ${JSON.stringify(appMeta.displayName)},
  displayNameZh: ${JSON.stringify(appMeta.displayNameZh)},
  npmPackageName: ${JSON.stringify(appMeta.npmPackageName)},
  identifier: ${JSON.stringify(appMeta.identifier)},
  configDirName: ${JSON.stringify(appMeta.configDirName)},
  storagePrefix: ${JSON.stringify(appMeta.storagePrefix)},
  oraNamespace: ${JSON.stringify(appMeta.oraNamespace)},
  legacyOraNamespace: ${JSON.stringify(appMeta.legacyOraNamespace)},
  logTarget: ${JSON.stringify(appMeta.logTarget)},
} as const;

export const APP_DISPLAY_NAME = APP_META.displayName;
export const APP_DISPLAY_NAME_ZH = APP_META.displayNameZh;
export const APP_STORAGE_PREFIX = APP_META.storagePrefix;
export const APP_IDENTIFIER = APP_META.identifier;
export const APP_CONFIG_DIR_NAME = APP_META.configDirName;
export const APP_ORA_NAMESPACE = APP_META.oraNamespace;
export const APP_ORA_LEGACY_NAMESPACE = APP_META.legacyOraNamespace;

export function appHyphenStorageKey(suffix: string): string {
  return \`\${APP_STORAGE_PREFIX}-\${suffix}\`;
}

export function appDotStorageKey(suffix: string): string {
  return \`\${APP_STORAGE_PREFIX}.\${suffix}\`;
}
`;
  writeFileSync(frontendMetaPath, ts);
  log(`   ✅ src/constants/appMeta.ts generated`);
}

// Rust 常量
{
  mkdirSync(dirname(rustMetaPath), { recursive: true });
  const rs = `pub const APP_DISPLAY_NAME: &str = "${escapeRustString(appMeta.displayName)}";
pub const APP_DISPLAY_NAME_ZH: &str = "${escapeRustString(appMeta.displayNameZh)}";
pub const APP_IDENTIFIER: &str = "${escapeRustString(appMeta.identifier)}";
pub const APP_CONFIG_DIR_NAME: &str = "${escapeRustString(appMeta.configDirName)}";
pub const APP_STORAGE_PREFIX: &str = "${escapeRustString(appMeta.storagePrefix)}";
pub const APP_ORA_NAMESPACE: &str = "${escapeRustString(appMeta.oraNamespace)}";
pub const APP_ORA_LEGACY_NAMESPACE: &str = "${escapeRustString(appMeta.legacyOraNamespace)}";
pub const APP_LOG_TARGET: &str = "${escapeRustString(appMeta.logTarget)}";
`;
  writeFileSync(rustMetaPath, rs);
  log(`   ✅ src-tauri/src/app_meta.rs generated`);
}

// index.html title
{
  const indexPath = join(rootDir, 'index.html');
  const before = readFileSync(indexPath, 'utf-8');
  const after = before.replace(/<title>[^<]*<\/title>/, `<title>${appMeta.displayName}</title>`);
  if (after !== before) {
    writeFileSync(indexPath, after);
  }
  log(`   ✅ index.html title`);
}

log('🎉 应用命名同步完成');
