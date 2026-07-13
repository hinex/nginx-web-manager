import { cn } from "~/lib/utils";

function Sk({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

const ROW_WIDTHS = [
  ["w-40", "w-24", "w-16", "w-20"],
  ["w-56", "w-20", "w-24", "w-20"],
  ["w-32", "w-28", "w-16", "w-20"],
  ["w-48", "w-16", "w-20", "w-20"],
  ["w-36", "w-24", "w-24", "w-20"],
  ["w-52", "w-20", "w-16", "w-20"],
  ["w-44", "w-28", "w-20", "w-20"],
  ["w-28", "w-16", "w-24", "w-20"],
];

/**
 * Generic page placeholder rendered instantly during route transitions,
 * so navigation feels immediate while the next page's loader is running.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      {/* Page header: title + subtitle + actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Sk className="h-8 w-48" />
          <Sk className="h-4 w-72 max-w-full" />
        </div>
        <div className="hidden sm:flex gap-2">
          <Sk className="h-9 w-24" />
          <Sk className="h-9 w-28" />
        </div>
      </div>

      {/* Toolbar / search */}
      <Sk className="h-9 w-full max-w-sm" />

      {/* Table card */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-6 border-b border-border bg-muted/40 px-4 py-3">
          <Sk className="h-4 w-32" />
          <Sk className="hidden h-4 w-24 sm:block" />
          <Sk className="hidden h-4 w-20 md:block" />
          <Sk className="ml-auto h-4 w-16" />
        </div>
        {ROW_WIDTHS.map((widths, i) => (
          <div
            key={i}
            className="flex items-center gap-6 border-b border-border/60 px-4 py-3.5 last:border-b-0"
          >
            <Sk className={cn("h-4", widths[0])} />
            <Sk className={cn("hidden h-4 sm:block", widths[1])} />
            <Sk className={cn("hidden h-4 md:block", widths[2])} />
            <Sk className={cn("ml-auto h-8", widths[3])} />
          </div>
        ))}
      </div>
    </div>
  );
}
