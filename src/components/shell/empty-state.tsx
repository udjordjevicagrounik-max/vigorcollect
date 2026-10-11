import Link from 'next/link';

// Rule 29: an empty state explains the feature AND offers the next step.
export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
}: {
  title: string;
  description: string;
  actionLabel: string;
  actionHref: string;
}) {
  return (
    <section
      aria-labelledby="empty-state-title"
      className="rounded-lg border border-border bg-surface p-8 text-center"
    >
      <h1 id="empty-state-title" className="text-xl font-semibold text-brand-green">
        {title}
      </h1>
      <span aria-hidden="true" className="mx-auto mt-2 block h-[3px] w-12 bg-brand-gold" />
      <p className="mx-auto mt-4 max-w-prose text-text-muted">{description}</p>
      <Link
        href={actionHref}
        className="mt-6 inline-flex min-h-11 items-center rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
      >
        {actionLabel}
      </Link>
    </section>
  );
}
