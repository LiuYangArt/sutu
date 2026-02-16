import { create } from 'zustand';
import { BaseDirectory, exists, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import type {
  I18nParams,
  LocaleCatalogEntry,
  LocaleCode,
  LocaleFile,
  LocaleMeta,
} from '@/i18n/types';

export const I18N_FALLBACK_LOCALE: LocaleCode = 'en-US';
const EXTERNAL_LOCALES_DIR = 'locales';
const EXTERNAL_LOCALES_EXT = '.json';

type LocaleCatalogMap = Record<LocaleCode, LocaleCatalogEntry>;

interface I18nState {
  catalogs: LocaleCatalogMap;
  availableLocales: LocaleMeta[];
  currentLocale: LocaleCode;
  initialized: boolean;
  initializeI18n: (preferredLocale: LocaleCode) => Promise<LocaleCode>;
  setLocale: (locale: LocaleCode) => LocaleCode;
  translate: (key: string, params?: I18nParams) => string;
}

const missingKeyWarnings = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocaleMeta(value: unknown): value is LocaleMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === 'string' &&
    value.code.trim().length > 0 &&
    typeof value.displayName === 'string' &&
    value.displayName.trim().length > 0 &&
    typeof value.nativeName === 'string' &&
    value.nativeName.trim().length > 0
  );
}

function isLocaleFile(value: unknown): value is LocaleFile {
  if (!isRecord(value)) return false;
  if (!isLocaleMeta(value.meta)) return false;
  if (!isRecord(value.messages)) return false;
  return Object.values(value.messages).every((item) => typeof item === 'string');
}

function interpolate(template: string, params?: I18nParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = params[key];
    return value === undefined ? `{{${key}}}` : String(value);
  });
}

function mergeLocaleFile(
  current: LocaleCatalogEntry | undefined,
  next: LocaleFile,
  source: 'builtin' | 'external'
): LocaleCatalogEntry {
  if (!current) {
    return {
      meta: next.meta,
      messages: { ...next.messages },
      source,
    };
  }

  return {
    meta: next.meta,
    messages: { ...current.messages, ...next.messages },
    source: 'merged',
  };
}

function buildCatalogs(
  builtinFiles: LocaleFile[],
  externalFiles: LocaleFile[]
): { catalogs: LocaleCatalogMap; availableLocales: LocaleMeta[] } {
  const catalogs: LocaleCatalogMap = {};

  for (const file of builtinFiles) {
    catalogs[file.meta.code] = mergeLocaleFile(catalogs[file.meta.code], file, 'builtin');
  }

  for (const file of externalFiles) {
    catalogs[file.meta.code] = mergeLocaleFile(catalogs[file.meta.code], file, 'external');
  }

  if (!catalogs[I18N_FALLBACK_LOCALE]) {
    catalogs[I18N_FALLBACK_LOCALE] = {
      meta: {
        code: I18N_FALLBACK_LOCALE,
        displayName: 'English',
        nativeName: 'English',
      },
      messages: {},
      source: 'builtin',
    };
  }

  const availableLocales = Object.values(catalogs)
    .map((entry) => entry.meta)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { catalogs, availableLocales };
}

function resolveLocale(preferredLocale: LocaleCode, catalogs: LocaleCatalogMap): LocaleCode {
  if (preferredLocale && catalogs[preferredLocale]) return preferredLocale;
  if (catalogs[I18N_FALLBACK_LOCALE]) return I18N_FALLBACK_LOCALE;
  const first = Object.keys(catalogs)[0];
  return first || I18N_FALLBACK_LOCALE;
}

function warnMissingKeyOnce(locale: LocaleCode, key: string): void {
  const mark = `${locale}::${key}`;
  if (missingKeyWarnings.has(mark)) return;
  missingKeyWarnings.add(mark);
  console.warn(`[i18n] Missing translation key "${key}" for locale "${locale}"`);
}

function readBuiltinLocaleFiles(): LocaleFile[] {
  const modules = import.meta.glob<LocaleFile>('../locales/*.json', {
    eager: true,
    import: 'default',
  });
  const values = Object.values(modules);
  const locales: LocaleFile[] = [];
  for (const value of values) {
    if (isLocaleFile(value)) {
      locales.push(value);
      continue;
    }
    console.warn('[i18n] Ignored invalid builtin locale file payload');
  }
  return locales;
}

async function readExternalLocaleFiles(): Promise<LocaleFile[]> {
  try {
    const dirExists = await exists(EXTERNAL_LOCALES_DIR, { baseDir: BaseDirectory.AppConfig });
    if (!dirExists) return [];
  } catch {
    return [];
  }

  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(EXTERNAL_LOCALES_DIR, { baseDir: BaseDirectory.AppConfig });
  } catch (error) {
    console.warn('[i18n] Failed to read external locales directory:', error);
    return [];
  }

  const localeFiles: LocaleFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name || !entry.name.toLowerCase().endsWith(EXTERNAL_LOCALES_EXT)) {
      continue;
    }

    const relativePath = `${EXTERNAL_LOCALES_DIR}/${entry.name}`;
    try {
      const raw = await readTextFile(relativePath, { baseDir: BaseDirectory.AppConfig });
      const parsed = JSON.parse(raw) as unknown;
      if (!isLocaleFile(parsed)) {
        console.warn(`[i18n] Ignored invalid external locale file: ${entry.name}`);
        continue;
      }
      localeFiles.push(parsed);
    } catch (error) {
      console.warn(`[i18n] Failed to parse external locale file "${entry.name}":`, error);
    }
  }
  return localeFiles;
}

const builtinLocaleFiles = readBuiltinLocaleFiles();
const builtinCatalogData = buildCatalogs(builtinLocaleFiles, []);

export const useI18nStore = create<I18nState>((set, get) => ({
  catalogs: builtinCatalogData.catalogs,
  availableLocales: builtinCatalogData.availableLocales,
  currentLocale: resolveLocale(I18N_FALLBACK_LOCALE, builtinCatalogData.catalogs),
  initialized: false,

  initializeI18n: async (preferredLocale) => {
    const externalFiles = await readExternalLocaleFiles();
    const merged = buildCatalogs(builtinLocaleFiles, externalFiles);
    const resolvedLocale = resolveLocale(preferredLocale, merged.catalogs);

    set({
      catalogs: merged.catalogs,
      availableLocales: merged.availableLocales,
      currentLocale: resolvedLocale,
      initialized: true,
    });

    return resolvedLocale;
  },

  setLocale: (locale) => {
    const state = get();
    const resolvedLocale = resolveLocale(locale, state.catalogs);
    set({ currentLocale: resolvedLocale });
    return resolvedLocale;
  },

  translate: (key, params) => {
    const state = get();
    const locale = state.currentLocale;
    const currentMessages = state.catalogs[locale]?.messages ?? {};
    const fallbackMessages = state.catalogs[I18N_FALLBACK_LOCALE]?.messages ?? {};
    const text = currentMessages[key] ?? fallbackMessages[key];

    if (!text) {
      warnMissingKeyOnce(locale, key);
      return key;
    }
    return interpolate(text, params);
  },
}));

export async function initializeI18n(preferredLocale: LocaleCode): Promise<LocaleCode> {
  return useI18nStore.getState().initializeI18n(preferredLocale);
}
