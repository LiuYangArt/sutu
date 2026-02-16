export type LocaleCode = string;

export interface LocaleMeta {
  code: LocaleCode;
  displayName: string;
  nativeName: string;
}

export interface LocaleFile {
  meta: LocaleMeta;
  messages: Record<string, string>;
}

export interface LocaleCatalogEntry {
  meta: LocaleMeta;
  messages: Record<string, string>;
  source: 'builtin' | 'external' | 'merged';
}

export type I18nParams = Record<string, string | number>;
