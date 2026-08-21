import { useState, useEffect, useCallback, useRef } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/configs";
import { requireEditor } from "~/lib/auth/middleware";
import { listConfigFiles } from "~/lib/nginx/parser";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "~/components/ui/alert-dialog";
import {
  File, Folder, FolderOpen, Code, Blocks, Save, History, RotateCcw, X, Menu,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { toast } from "sonner";
import { onTemplateInsert } from "~/lib/events/template-insert";
import { ApplyDialog } from "~/components/config-editor/ApplyDialog";
// `isGeneratedSystemFile` is a value import, not `import type` — but it's only
// ever called from `loader`, below, which React Router splits into the
// server-only chunk. Calling it from the component body instead would drag
// `~/lib/services/configs`'s side-effectful imports (bun:sqlite via
// `~/lib/db/connection`, `fs`) into the client bundle — the same hazard
// documented for the parser barrel in the model-highlight work.
import { isGeneratedSystemFile, type ConfigEditPreview } from "~/lib/services/configs";
import type { Refusal } from "~/lib/nginx/reverse/classify";

const NGINX_DIR = process.env.NGINX_DIR || "/data/nginx";

export function meta() {
  return [{ title: "Config Editor — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireEditor(request);
  const files = listConfigFiles(NGINX_DIR);
  // Computed here (server-only) rather than in the component, so the check
  // — and everything `~/lib/services/configs` pulls in to make it — never
  // reaches the client bundle. See the import comment above.
  const generatedFiles = files.filter((f) => isGeneratedSystemFile(f));
  return { files, baseDir: NGINX_DIR, generatedFiles };
}

// ── Types ────────────────────────────────────────────────

interface ConfigVersion {
  id: number;
  filePath: string;
  content: string;
  changeType: string;
  userId: number | null;
  userEmail: string | null;
  message: string | null;
  createdAt: string | number;
}

interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

// ── Helpers ──────────────────────────────────────────────

function formatRelativeTime(dateValue: string | number): string {
  const date = typeof dateValue === "string" ? new Date(dateValue) : new Date(dateValue);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days !== 1 ? "s" : ""} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months !== 1 ? "s" : ""} ago`;
}

const CHANGE_TYPE_LABELS: Record<string, string> = {
  manual_edit: "edit",
  form_save: "form",
  template_apply: "template",
  restore: "restore",
  import: "import",
};

export default function ConfigsPage() {
  const { files, baseDir, generatedFiles } = useLoaderData<typeof loader>();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [editorMode, setEditorMode] = useState<"code" | "block">("code");
  const [loading, setLoading] = useState(false);
  const dirty = content !== originalContent;
  // Generated system files (admin.conf, status.conf, default.conf) stay
  // fully editable — this only drives the ApplyDialog's warning banner.
  const generatedWarning = selectedFile !== null && generatedFiles.includes(selectedFile);

  // Version history state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffChange[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ConfigVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Reverse-sync confirmation dialog state (config editor → host model)
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [preview, setPreview] = useState<ConfigEditPreview | null>(null);

  // Fetch version history for the current file
  const fetchVersions = useCallback(async (filePath: string) => {
    setVersionsLoading(true);
    try {
      const res = await fetch("/api/config-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "versions", filePath }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setVersions(data.versions ?? []);
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (filePath: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/config-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", filePath }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setContent(data.content);
      setOriginalContent(data.content);
      setSelectedFile(filePath);
    } finally {
      setLoading(false);
    }
  }, []);

  // Writes the current buffer via the "write" action (routed through
  // applyConfigEdit on the server, which reverse-syncs into the host model
  // for a managed host-<id>.conf and falls back to a plain live write
  // otherwise). Shared by the plain-save path and the ApplyDialog's Apply
  // button, so both go through the exact same request shape.
  const writeConfigFile = useCallback(async (): Promise<
    { ok: true } | { ok: false; refusals?: Refusal[] }
  > => {
    if (!selectedFile) return { ok: false };
    const res = await fetch("/api/config-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", filePath: selectedFile, content }),
    });
    if (res.status === 422) {
      const data = await res.json();
      return { ok: false, refusals: (data.refusals ?? []) as Refusal[] };
    }
    const data = await res.json();
    if (!data.valid) {
      toast.error(`Config validation failed, changes reverted: ${data.error}`);
      return { ok: false };
    }
    if (!data.reloaded) {
      toast.warning("Saved and validated, but nginx reload failed — run `nginx -s reload` on the host");
    } else {
      toast.success("Saved and reloaded nginx");
    }
    // Text normalisation is part of the contract: after a save the file is
    // regenerated from the model, so re-read it from disk rather than
    // trusting the buffer we sent — for a managed host file the canonical
    // text differs from what was typed, and the user must see that.
    const readRes = await fetch("/api/config-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", filePath: selectedFile }),
    });
    const readData = await readRes.json();
    const canonical = typeof readData.content === "string" ? readData.content : content;
    setContent(canonical);
    setOriginalContent(canonical);
    if (historyOpen) fetchVersions(selectedFile);
    return { ok: true };
  }, [selectedFile, content, historyOpen, fetchVersions]);

  // Save is never silent: it always previews the classification first. A
  // managed host-<id>.conf shows the ApplyDialog so the user confirms what
  // was understood before anything is written; a file with nothing to
  // classify (hostId === null) has no diff to show, so it saves directly.
  const handleSave = useCallback(async () => {
    if (!selectedFile || !dirty) return;
    const res = await fetch("/api/config-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preview", filePath: selectedFile, content }),
    });
    if (res.status === 422) {
      // e.g. the host has an unpublished draft — refuse before the file ever
      // reaches the ApplyDialog's "apply" path.
      const data = await res.json();
      setPreview({ hostId: null, edits: [], refusals: (data.refusals ?? []) as Refusal[] });
      setApplyDialogOpen(true);
      return;
    }
    const data: ConfigEditPreview = await res.json();
    if (data.hostId === null) {
      await writeConfigFile();
      return;
    }
    setPreview(data);
    setApplyDialogOpen(true);
  }, [selectedFile, content, dirty, writeConfigFile]);

  const handleApplyConfirm = useCallback(async () => {
    const result = await writeConfigFile();
    if (result.ok) {
      setApplyDialogOpen(false);
      setPreview(null);
      return;
    }
    if (result.refusals) {
      // The write itself refused the regenerated config (e.g. a business-rule
      // refusal the preview already surfaced, or a `nginx -t` failure on the
      // regenerated file) — re-render the same dialog in refusal mode rather
      // than closing it as if the save had gone through.
      setPreview((prev) => ({ hostId: prev?.hostId ?? null, edits: [], refusals: result.refusals! }));
    }
  }, [writeConfigFile]);

  const handleCancelApply = useCallback(() => {
    setApplyDialogOpen(false);
    setPreview(null);
  }, []);

  const handleChange = useCallback((text: string) => {
    setContent(text);
  }, []);

  // Close history panel and clear data when file changes
  useEffect(() => {
    setHistoryOpen(false);
    setVersions([]);
    setSelectedVersion(null);
    setDiff(null);
  }, [selectedFile]);

  // Toggle history panel
  const toggleHistory = useCallback(() => {
    if (!historyOpen && selectedFile) {
      fetchVersions(selectedFile);
    }
    if (historyOpen) {
      setSelectedVersion(null);
      setDiff(null);
    }
    setHistoryOpen((v) => !v);
  }, [historyOpen, selectedFile, fetchVersions]);

  // Fetch diff for a selected version vs current file
  const fetchDiff = useCallback(async (versionId: number) => {
    if (!selectedFile) return;
    setSelectedVersion(versionId);
    setDiffLoading(true);
    try {
      const res = await fetch("/api/config-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "diff", versionIdA: versionId, filePath: selectedFile }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setDiff(data.diff ?? null);
    } finally {
      setDiffLoading(false);
    }
  }, [selectedFile]);

  // Restore a version
  const handleRestore = useCallback(async (version: ConfigVersion) => {
    setRestoring(true);
    try {
      const res = await fetch("/api/config-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", versionId: version.id }),
      });
      const data = await res.json();
      if (data.restored && data.valid) {
        if (!data.reloaded) {
          toast.warning("Restored and validated, but nginx reload failed — run `nginx -s reload` on the host");
        } else {
          toast.success("Version restored and nginx reloaded");
        }
        // Reload the file content
        setContent(version.content);
        setOriginalContent(version.content);
        // Refresh versions list
        if (selectedFile) fetchVersions(selectedFile);
        setSelectedVersion(null);
        setDiff(null);
      } else if (data.restored === false && data.valid === false) {
        toast.error(`Restore validation failed, changes reverted: ${data.error}`);
      } else {
        toast.error(data.error || "Restore failed");
      }
    } finally {
      setRestoring(false);
      setRestoreTarget(null);
    }
  }, [selectedFile, fetchVersions]);

  // Ref for the CodeEditor insertAtCursor function, used by template insert events
  const insertAtCursorRef = useRef<((text: string) => void) | null>(null);

  const handleRegisterInsert = useCallback((fn: (text: string) => void) => {
    insertAtCursorRef.current = fn;
  }, []);

  // Ref for the CodeEditor jump-to-line function, used by ApplyDialog refusal rows
  const jumpToLineRef = useRef<((line: number) => void) | null>(null);

  const handleRegisterJumpToLine = useCallback((fn: (line: number) => void) => {
    jumpToLineRef.current = fn;
  }, []);

  const handleJumpToLine = useCallback((line: number) => {
    jumpToLineRef.current?.(line);
  }, []);

  // Clear the insert/jump refs when not in code editor mode (the view would be destroyed)
  useEffect(() => {
    if (editorMode !== "code") {
      insertAtCursorRef.current = null;
      jumpToLineRef.current = null;
    }
  }, [editorMode]);

  // Listen for template insert events from the Templates page
  useEffect(() => {
    const unsubscribe = onTemplateInsert((text: string) => {
      if (insertAtCursorRef.current && selectedFile) {
        insertAtCursorRef.current(text);
        toast.success("Template inserted into editor");
      } else if (!selectedFile) {
        // No file is open; append text as new content
        setContent(text);
        toast.success("Template loaded into editor. Select a file to save it.");
      } else {
        // Editor not ready yet; fall back to appending to content
        setContent((prev) => prev + text);
        toast.success("Template appended to editor content");
      }
    });
    return unsubscribe;
  }, [selectedFile]);

  // Lazy-load editor components to avoid SSR issues with CodeMirror
  const [CodeEditor, setCodeEditor] = useState<React.ComponentType<any> | null>(null);
  const [BlockEditor, setBlockEditor] = useState<React.ComponentType<any> | null>(null);

  useEffect(() => {
    import("~/components/config-editor/CodeEditor").then((mod) => {
      setCodeEditor(() => mod.CodeEditor);
    });
    import("~/components/config-editor/BlockEditor").then((mod) => {
      setBlockEditor(() => mod.BlockEditor);
    });
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auto-close sidebar on mobile after file selection
  const handleFileSelect = useCallback((filePath: string) => {
    loadFile(filePath);
    setSidebarOpen(false);
  }, [loadFile]);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] relative">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* File tree sidebar */}
      <div className={cn(
        "w-64 shrink-0 border-r border-border overflow-y-auto bg-card z-30",
        "fixed inset-y-0 left-0 top-14 transition-transform duration-200 md:static md:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="px-3 py-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
            Config Files
          </h3>
        </div>
        <FileTree
          files={files}
          baseDir={baseDir}
          selectedFile={selectedFile}
          onSelect={handleFileSelect}
        />
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="md:hidden p-1 rounded hover:bg-muted/50 text-muted-foreground shrink-0"
                >
                  <Menu className="h-4 w-4" />
                </button>
                <span className="text-sm font-mono text-muted-foreground truncate">
                  {selectedFile.replace(baseDir + "/", "")}
                </span>
                {dirty && (
                  <span className="text-xs text-orange-400 shrink-0">(unsaved)</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Tabs value={editorMode} onValueChange={(v) => setEditorMode(v as "code" | "block")}>
                  <TabsList className="h-8">
                    <TabsTrigger value="code" className="text-xs gap-1 px-2">
                      <Code className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Code</span>
                    </TabsTrigger>
                    <TabsTrigger value="block" className="text-xs gap-1 px-2">
                      <Blocks className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Blocks</span>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button
                  size="sm"
                  variant={historyOpen ? "default" : "outline"}
                  onClick={toggleHistory}
                >
                  <History className="h-3.5 w-3.5 sm:mr-1" />
                  <span className="hidden sm:inline">History</span>
                </Button>
                <Button
                  size="sm"
                  variant={dirty ? "default" : "outline"}
                  onClick={handleSave}
                  disabled={!dirty}
                >
                  <Save className="h-3.5 w-3.5 sm:mr-1" />
                  <span className="hidden sm:inline">Save</span>
                </Button>
              </div>
            </div>

            {/* Editor + History panel */}
            <div className="flex-1 flex min-h-0">
              {/* Editor content */}
              <div className="flex-1 overflow-auto min-w-0">
                {loading ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    Loading...
                  </div>
                ) : editorMode === "code" && CodeEditor ? (
                  <CodeEditor
                    value={content}
                    onChange={handleChange}
                    onSave={() => handleSave()}
                    onRegisterInsert={handleRegisterInsert}
                    onRegisterJumpToLine={handleRegisterJumpToLine}
                    className="h-full"
                  />
                ) : editorMode === "block" && BlockEditor ? (
                  <BlockEditor
                    value={content}
                    onChange={handleChange}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    Loading editor...
                  </div>
                )}
              </div>

              {/* Version history sidebar */}
              {historyOpen && (
                <VersionHistoryPanel
                  versions={versions}
                  versionsLoading={versionsLoading}
                  selectedVersion={selectedVersion}
                  diff={diff}
                  diffLoading={diffLoading}
                  onSelectVersion={fetchDiff}
                  onRestore={setRestoreTarget}
                  onClose={() => {
                    setHistoryOpen(false);
                    setSelectedVersion(null);
                    setDiff(null);
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Code className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-lg">Select a config file to edit</p>
              <p className="text-sm mt-1">Choose a file from the sidebar to start editing</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 md:hidden"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu className="h-4 w-4 mr-1.5" /> Open File Browser
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Restore confirmation dialog */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              This will save the current file content as a new version, then overwrite
              the file with the selected version. Nginx config will be validated and reloaded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restoring}
              onClick={() => restoreTarget && handleRestore(restoreTarget)}
            >
              {restoring ? "Restoring..." : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation diff dialog: every accepted config-file edit goes through
          this before anything is written. */}
      <ApplyDialog
        open={applyDialogOpen}
        preview={preview}
        generatedWarning={generatedWarning}
        onApply={handleApplyConfirm}
        onCancel={handleCancelApply}
        onJumpToLine={handleJumpToLine}
      />
    </div>
  );
}

// ── Version History Panel ────────────────────────────────

function VersionHistoryPanel({
  versions,
  versionsLoading,
  selectedVersion,
  diff,
  diffLoading,
  onSelectVersion,
  onRestore,
  onClose,
}: {
  versions: ConfigVersion[];
  versionsLoading: boolean;
  selectedVersion: number | null;
  diff: DiffChange[] | null;
  diffLoading: boolean;
  onSelectVersion: (id: number) => void;
  onRestore: (version: ConfigVersion) => void;
  onClose: () => void;
}) {
  return (
    <div className="w-[280px] shrink-0 border-l border-border bg-card flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
          Version History
        </h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted/50 text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Version list + diff area */}
      <div className="flex-1 flex flex-col min-h-0">
        {versionsLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            Loading versions...
          </div>
        ) : versions.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            No version history
          </div>
        ) : (
          <>
            {/* Version list */}
            <div className={cn(
              "overflow-y-auto",
              diff || diffLoading ? "max-h-[40%] shrink-0" : "flex-1",
            )}>
              {versions.map((version) => (
                <button
                  key={version.id}
                  onClick={() => onSelectVersion(version.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 border-b border-border/50 hover:bg-muted/50 transition-colors",
                    selectedVersion === version.id && "bg-muted/70",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(version.createdAt)}
                    </span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {CHANGE_TYPE_LABELS[version.changeType] || version.changeType}
                    </Badge>
                  </div>
                  {version.userEmail && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{version.userEmail}</p>
                  )}
                  {version.message && (
                    <p className="text-xs text-foreground mt-0.5 truncate">{version.message}</p>
                  )}
                </button>
              ))}
            </div>

            {/* Diff display */}
            {(diff || diffLoading) && selectedVersion && (
              <div className="flex-1 flex flex-col min-h-0 border-t border-border">
                <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
                  <span className="text-xs font-medium text-muted-foreground">
                    Diff vs current
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs px-2"
                    onClick={() => {
                      const v = versions.find((v) => v.id === selectedVersion);
                      if (v) onRestore(v);
                    }}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" /> Restore
                  </Button>
                </div>
                <div className="flex-1 overflow-auto px-1 pb-2">
                  {diffLoading ? (
                    <div className="flex items-center justify-center py-4 text-muted-foreground text-xs">
                      Loading diff...
                    </div>
                  ) : diff ? (
                    <DiffView changes={diff} />
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Diff View ────────────────────────────────────────────

function DiffView({ changes }: { changes: DiffChange[] }) {
  if (changes.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-4">
        No differences
      </div>
    );
  }

  // Check if all changes are unchanged (no added/removed)
  const hasChanges = changes.some((c) => c.added || c.removed);
  if (!hasChanges) {
    return (
      <div className="text-xs text-muted-foreground text-center py-4">
        No differences
      </div>
    );
  }

  return (
    <pre className="text-[11px] leading-[1.4] font-mono">
      {changes.map((change, i) => {
        const lines = change.value.replace(/\n$/, "").split("\n");
        return lines.map((line, j) => (
          <div
            key={`${i}-${j}`}
            className={cn(
              "px-2 whitespace-pre-wrap break-all",
              change.added && "bg-green-500/15 text-green-300",
              change.removed && "bg-red-500/15 text-red-300",
            )}
          >
            <span className="select-none text-muted-foreground/50 inline-block w-4 mr-1">
              {change.added ? "+" : change.removed ? "-" : " "}
            </span>
            {line}
          </div>
        ));
      })}
    </pre>
  );
}

// ── File Tree Components ────────────────────────────────

function FileTree({
  files,
  baseDir,
  selectedFile,
  onSelect,
}: {
  files: string[];
  baseDir: string;
  selectedFile: string | null;
  onSelect: (path: string) => void;
}) {
  // Group files by directory
  const tree = new Map<string, string[]>();
  for (const file of files) {
    const relative = file.replace(baseDir + "/", "");
    const dir = relative.includes("/") ? relative.split("/").slice(0, -1).join("/") : "";
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir)!.push(file);
  }

  return (
    <div className="text-sm px-2 pb-2">
      {Array.from(tree.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, dirFiles]) => (
          <FileTreeDir
            key={dir || "__root"}
            dir={dir}
            files={dirFiles}
            baseDir={baseDir}
            selectedFile={selectedFile}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function FileTreeDir({
  dir,
  files,
  baseDir,
  selectedFile,
  onSelect,
}: {
  dir: string;
  files: string[];
  baseDir: string;
  selectedFile: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      {dir && (
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-2 py-1 w-full hover:bg-muted/50 rounded text-muted-foreground"
        >
          {open ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
          <span className="truncate">{dir}/</span>
        </button>
      )}
      {open &&
        files.sort().map((file) => {
          const name = file.split("/").pop()!;
          return (
            <button
              key={file}
              onClick={() => onSelect(file)}
              className={cn(
                "flex items-center gap-1.5 py-1 w-full rounded text-sm",
                dir ? "pl-7 pr-2" : "px-2",
                selectedFile === file
                  ? "bg-primary/10 text-primary font-medium"
                  : "hover:bg-muted/50 text-foreground"
              )}
            >
              <File className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{name}</span>
            </button>
          );
        })}
    </div>
  );
}
