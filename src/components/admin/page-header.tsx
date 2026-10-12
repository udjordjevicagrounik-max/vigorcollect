// Screen heading with the gold underline (design tokens) and a first-time explanation.
export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold text-brand-green">{title}</h1>
      <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
      <p className="mt-3 max-w-prose text-text-muted">{description}</p>
    </header>
  );
}
