import type { I18nParams } from './types';
import { useI18nStore } from '@/stores/i18n';

export function useI18n() {
  const currentLocale = useI18nStore((state) => state.currentLocale);
  const availableLocales = useI18nStore((state) => state.availableLocales);
  const translate = useI18nStore((state) => state.translate);

  return {
    currentLocale,
    availableLocales,
    t: translate,
  };
}

export function t(key: string, params?: I18nParams): string {
  return useI18nStore.getState().translate(key, params);
}
