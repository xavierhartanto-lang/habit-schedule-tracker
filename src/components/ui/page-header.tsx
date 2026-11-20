import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-6 pt-2 sm:flex-row lg:pt-5 sm:items-end sm:justify-between">
      <div className="min-w-0 animate-fade-up">
        <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.03em] text-ink sm:text-[34px]">{title}</h1>
        {description && <p className="mt-1 text-[15px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
