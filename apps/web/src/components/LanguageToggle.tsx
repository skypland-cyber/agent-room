// The 한국어 / EN switch. One control, two places it appears (the office header
// and the room's file shelf), so it is a component rather than two copies.
import { LANGUAGE_OPTIONS, useI18n } from '../i18n/index.js';

export function LanguageToggle({ tone = 'light', className = '' }: { tone?: 'light' | 'dark'; className?: string }) {
  const { lang, setLanguage, t } = useI18n();
  const shell = tone === 'dark'
    ? 'border-white/15 bg-white/5'
    : 'border-border bg-surface-sunken';
  const active = tone === 'dark' ? 'bg-white text-ink' : 'bg-white text-ink shadow-sm';
  const idle = tone === 'dark' ? 'text-white/65 hover:text-white' : 'text-ink-soft hover:text-ink';
  return (
    <div
      role="group"
      aria-label={t('lang.switch')}
      title={t('lang.switch')}
      className={`inline-flex items-center gap-0.5 rounded-lg border p-0.5 ${shell} ${className}`}
    >
      {LANGUAGE_OPTIONS.map(option => (
        <button
          key={option.id}
          type="button"
          onClick={() => setLanguage(option.id)}
          aria-pressed={lang === option.id}
          lang={option.id}
          className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${lang === option.id ? active : idle}`}
        >
          {t(option.labelKey)}
        </button>
      ))}
    </div>
  );
}
