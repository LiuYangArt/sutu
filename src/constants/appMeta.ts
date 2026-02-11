export const APP_META = {
  displayName: 'Sutu',
  displayNameZh: '速涂',
  npmPackageName: 'sutu',
  identifier: 'com.sutu',
  configDirName: 'com.sutu',
  storagePrefix: 'sutu',
  oraNamespace: 'sutu',
  legacyOraNamespace: 'paintboard',
  logTarget: 'sutu',
} as const;

export const APP_DISPLAY_NAME = APP_META.displayName;
export const APP_DISPLAY_NAME_ZH = APP_META.displayNameZh;
export const APP_STORAGE_PREFIX = APP_META.storagePrefix;
export const APP_IDENTIFIER = APP_META.identifier;
export const APP_CONFIG_DIR_NAME = APP_META.configDirName;
export const APP_ORA_NAMESPACE = APP_META.oraNamespace;
export const APP_ORA_LEGACY_NAMESPACE = APP_META.legacyOraNamespace;

export function appHyphenStorageKey(suffix: string): string {
  return `${APP_STORAGE_PREFIX}-${suffix}`;
}

export function appDotStorageKey(suffix: string): string {
  return `${APP_STORAGE_PREFIX}.${suffix}`;
}
