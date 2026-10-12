import type { ReactNode } from 'react';

// Card for the sign-in screens: title with the gold underline (design tokens), then content.
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="auth-card-title"
      className="mx-auto w-full max-w-md rounded-lg border border-border bg-surface p-6 md:p-8"
    >
      <h1 id="auth-card-title" className="text-xl font-semibold text-brand-green">
        {title}
      </h1>
      <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
      {description ? <p className="mt-4 text-text-muted">{description}</p> : null}
      <div className="mt-6 flex flex-col gap-4">{children}</div>
    </section>
  );
}
