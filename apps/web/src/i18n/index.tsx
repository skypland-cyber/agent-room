// The office's two languages, and the one place that decides which is showing.
//
// Korean is the default and the fallback: a key missing from `en` is a compile
// error, a key missing from both returns the key itself, and nothing a screen
// renders depends on the browser's `navigator.language` — a Korean-first office
// must not flip to English because the boss opened the site from a work laptop.
//
// The choice is kept in `localStorage` and read once at module load. The store
// lives outside React so plain functions (formatDate, timeAgo, the API error
// mapper, window.confirm strings in event handlers) translate the same way the
// components do; `useT()` subscribes a component to changes of it.
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { ko } from './ko.js';
import { en } from './en.js';

export type Lang = 'ko' | 'en';
export type MessageKey = keyof typeof ko;
export type Messages = Record<MessageKey, string>;
export type Vars = Record<string, string | number>;

export const DEFAULT_LANGUAGE: Lang = 'ko';
export const STORAGE_KEY = 'agent-room.lang';

const DICTIONARIES: Record<Lang, Messages> = { ko, en };

/** One entry per language, in the order the toggle shows them. */
export const LANGUAGE_OPTIONS: Array<{ id: Lang; labelKey: MessageKey; name: string }> = [
  { id: 'ko', labelKey: 'lang.ko', name: '한국어' },
  { id: 'en', labelKey: 'lang.en', name: 'English' },
];

function isLang(value: unknown): value is Lang {
  return value === 'ko' || value === 'en';
}

function storedLanguage(): Lang {
  try {
    if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return isLang(saved) ? saved : DEFAULT_LANGUAGE;
  } catch {
    // Private mode, a blocked cookie jar or a prerender: keep the default.
    return DEFAULT_LANGUAGE;
  }
}

let currentLanguage: Lang = storedLanguage();
const listeners = new Set<() => void>();

function applyDocumentLanguage(lang: Lang): void {
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  } catch {
    // Server render or a DOM-less test: nothing to mark up.
  }
}

applyDocumentLanguage(currentLanguage);

export function getLanguage(): Lang {
  return currentLanguage;
}

export function setLanguage(lang: Lang): void {
  if (!isLang(lang) || lang === currentLanguage) return;
  currentLanguage = lang;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // A failed write only costs persistence, not the current view.
  }
  applyDocumentLanguage(lang);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Fill `{placeholders}`. An unknown placeholder is left visible, not blanked. */
export function format(key: MessageKey, vars?: Vars, lang: Lang = currentLanguage): string {
  const template = DICTIONARIES[lang][key] ?? ko[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

/** Translate outside React: event handlers, window.confirm, formatters. */
export function t(key: MessageKey, vars?: Vars): string {
  return format(key, vars, currentLanguage);
}

/** The current language, and a re-render whenever it changes. */
export function useLang(): Lang {
  // The store is the only source of truth, client or server: this app renders
  // its shell on the client (Vite prerender writes static HTML, not React), so
  // the "server" snapshot is simply the language in force right now.
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export function useT(): (key: MessageKey, vars?: Vars) => string {
  const lang = useLang();
  return useCallback((key: MessageKey, vars?: Vars) => format(key, vars, lang), [lang]);
}

export interface I18nValue {
  lang: Lang;
  setLanguage: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Wraps the app so a subtree re-renders on a language change. Components also
 * work without it (the store is module-level), which keeps a single panel
 * renderable in a test without ceremony.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  const value = useMemo<I18nValue>(() => ({
    lang,
    setLanguage,
    t: (key: MessageKey, vars?: Vars) => format(key, vars, lang),
  }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const lang = useLang();
  const context = useContext(I18nContext);
  const translate = useCallback((key: MessageKey, vars?: Vars) => format(key, vars, lang), [lang]);
  return context ?? { lang, setLanguage, t: translate };
}
