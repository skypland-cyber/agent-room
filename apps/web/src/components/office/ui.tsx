// Small shared pieces for the office screens. Kept deliberately plain: the
// office is a management console, so the visual language is the room app's
// cards and chips rather than a second design system.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getLanguage, t, useLang, type Lang } from '../../i18n/index.js';
import { errorText } from '../../i18n/errors.js';

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & Record<string, unknown>) {
  return (
    <section {...rest} className={`rounded-2xl border border-border bg-white p-5 shadow-card ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs leading-relaxed text-ink-soft">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost' | 'danger' | 'quiet';
  disabled?: boolean;
  className?: string;
  title?: string;
};

export function Button({ children, onClick, type = 'button', variant = 'primary', disabled, className = '', title }: ButtonProps) {
  const tone = {
    primary: 'bg-ink text-white hover:bg-ink/90 border-ink',
    ghost: 'bg-white text-ink-muted hover:text-ink border-border',
    quiet: 'bg-surface-sunken text-ink-muted hover:text-ink border-transparent',
    danger: 'bg-rose-50 text-rose-700 hover:bg-rose-100 border-rose-200',
  }[variant];
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${tone} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/15';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} min-h-[84px] resize-y ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const styles = {
    neutral: 'bg-surface-sunken text-ink-muted ring-border',
    good: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    warn: 'bg-amber-50 text-amber-800 ring-amber-200',
    bad: 'bg-rose-50 text-rose-700 ring-rose-200',
    info: 'bg-accent-tint text-accent-deep ring-accent-tint-border',
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${styles}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border bg-surface-soft px-4 py-6 text-center text-xs leading-relaxed text-ink-soft">{children}</p>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">
      {error}
    </p>
  );
}

export function timeAgo(at: number | undefined, now = Date.now()): string {
  if (!at) return t('time.never');
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return t('time.justNow');
  if (diff < 60 * minute) return t('time.minutesAgo', { count: Math.floor(diff / minute) });
  if (diff < 24 * 60 * minute) return t('time.hoursAgo', { count: Math.floor(diff / (60 * minute)) });
  return t('time.daysAgo', { count: Math.floor(diff / (24 * 60 * minute)) });
}

export function formatDate(at: number | undefined, lang: Lang = getLanguage()): string {
  if (!at) return '—';
  return new Date(at).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Run an office action with busy/error bookkeeping, then hand the caller a
 * reload hook. Every panel needs the same three states, and repeating them is
 * how one panel ends up silently swallowing a failed write.
 */
export function useOfficeAction(onDone?: () => void | Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  // The cause is kept, not its sentence: switching to EN re-reads a visible
  // error instead of leaving the old language on screen.
  const [cause, setCause] = useState<unknown>(null);
  const lang = useLang();
  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setCause(null);
    try {
      await action();
      await onDone?.();
      return true;
    } catch (failure) {
      setCause(failure);
      return false;
    } finally {
      setBusy(null);
    }
  }, [onDone]);
  const error = useMemo(() => errorText(cause), [cause, lang]);
  return { busy, error, setError: setCause, run };
}

/** Poll while the tab is visible; a hidden tab must not spend Redis commands. */
export function useVisibleInterval(callback: () => void, everyMs: number, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') saved.current();
    };
    const id = window.setInterval(tick, everyMs);
    const onVisible = () => { if (document.visibilityState === 'visible') saved.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs, enabled]);
}
