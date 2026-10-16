import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { lintConfig, type ConfigWarning } from "~/lib/nginx/lint";

/**
 * Amber, non-blocking list of lint warnings. Never disables a save — it only
 * tells the operator about a likely mistake. `onJumpToLine` makes the line
 * numbers clickable where there is an editor to jump in.
 */
export function ConfigWarningList({
  warnings,
  onJumpToLine,
}: {
  warnings: ConfigWarning[];
  onJumpToLine?: (line: number) => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {warnings.length === 1 ? "Warning — you can still apply" : `${warnings.length} warnings — you can still apply`}
      </div>
      <ul className="space-y-1">
        {warnings.map((w, i) => (
          <li key={i}>
            {onJumpToLine ? (
              <button
                type="button"
                onClick={() => onJumpToLine(w.line)}
                className="font-mono underline-offset-2 hover:underline"
              >
                line {w.line}:
              </button>
            ) : (
              <span className="font-mono">line {w.line}:</span>
            )}{" "}
            {w.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lints a raw-nginx textarea's value and renders the result under it. */
export function RawNginxWarnings({ text }: { text: string }) {
  const warnings = useMemo(() => lintConfig(text), [text]);
  return warnings.length > 0 ? (
    <div className="mt-2">
      <ConfigWarningList warnings={warnings} />
    </div>
  ) : null;
}
