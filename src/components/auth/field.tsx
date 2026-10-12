import type { InputHTMLAttributes } from 'react';

// Labelled input with an optional hint; 44 px touch target (rule 16).
export function Field({
  label,
  hint,
  id,
  ...input
}: { label: string; hint?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="min-h-11 rounded-md border border-border bg-surface px-3 text-text"
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ label, pending }: { label: string; pending?: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60"
    >
      {label}
    </button>
  );
}
