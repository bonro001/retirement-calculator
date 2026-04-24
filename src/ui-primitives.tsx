import type { ReactNode } from 'react';

export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-lg shadow-amber-950/5 backdrop-blur">
      <div className="mb-5">
        <h2 className="font-serif text-3xl tracking-tight text-stone-900">{title}</h2>
        {subtitle ? (
          <p className="mt-2 max-w-[68ch] text-sm leading-6 text-stone-600">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] bg-stone-100/85 p-4">
      <p className="text-sm font-medium text-stone-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-stone-900">{value}</p>
    </div>
  );
}

export function InsightCard({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <article className="rounded-[28px] bg-stone-100/85 p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-blue-700">{eyebrow}</p>
      <h3 className="mt-3 text-2xl font-semibold leading-tight text-stone-900">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-stone-600">{body}</p>
    </article>
  );
}

export function TimelineCard({
  year,
  title,
  body,
}: {
  year: string;
  title: string;
  body: string;
}) {
  return (
    <article className="rounded-[28px] bg-stone-100/85 p-5">
      <p className="text-sm font-medium text-stone-500">{year}</p>
      <h3 className="mt-2 text-2xl font-semibold text-stone-900">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-stone-600">{body}</p>
    </article>
  );
}

export function Tag({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'stress' | 'response';
}) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-medium ${
        tone === 'stress'
          ? 'bg-cyan-100 text-cyan-900'
          : 'bg-blue-100 text-blue-900'
      }`}
    >
      {children}
    </span>
  );
}

export function RiskPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-stone-100 px-3 py-1 text-sm font-medium text-stone-700">
      {children}
    </span>
  );
}

export function WithdrawalStep({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[20px] bg-white px-4 py-3">
      <p className="font-semibold text-stone-900">{title}</p>
      <p className="mt-1 text-sm leading-6 text-stone-600">{body}</p>
    </div>
  );
}
