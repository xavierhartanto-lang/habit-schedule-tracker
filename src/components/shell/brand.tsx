import { APP_NAME } from "@/lib/config/app";
import Link from "next/link";

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg px-1 py-1">
      <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-ink text-bg">
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 10.5c1.5-3 3-4.5 5-4.5s3.5 1.5 5 4.5" />
          <circle cx="8" cy="6" r="0.6" fill="currentColor" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">{APP_NAME}</span>
    </Link>
  );
}
