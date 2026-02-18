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
  File, Folder, FolderOpen, Code, Blocks, Save, History, RotateCcw, X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { toast } from "sonner";
import { onTemplateInsert } from "~/lib/events/template-insert";

const NGINX_DIR = process.env.NGINX_DIR || "/etc/nginx";

export function meta() {
  return [{ title: "Config Editor — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireEditor(request);
  const files = listConfigFiles(NGINX_DIR);
  return { files, baseDir: NGINX_DIR };
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
  const { files, baseDir } = useLoaderData<typeof loader>();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [editorMode, setEditorMode] = useState<"code" | "block">("code");
  const [loading, setLoading] = useState(false);
  const dirty = content !== originalContent;

  // Version history state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffChange[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ConfigVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

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

  const handleSave = useCallback(async () => {
    if (!selectedFile || !dirty) return;
    const res = await fetch("/api/config-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", filePath: selectedFile, content }),
    });
    const data = await res.json();
    if (data.valid) {
      toast.success("Saved and reloaded nginx");
      setOriginalContent(content);
      // Refresh versions if the history panel is open
      if (historyOpen) {
        fetchVersions(selectedFile);
      }
    } else {
      toast.error(`Config validation failed: ${data.error}`);
    }
  }, [selectedFile, content, dirty, historyOpen, fetchVersions]);

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
        toast.success("Version restored and nginx reloaded");
        // Reload the file content
        setContent(version.content);
        setOriginalContent(version.content);
        // Refresh versions list
        if (selectedFile) fetchVersions(selectedFile);
        setSelectedVersion(null);
        setDiff(null);
      } else if (data.restored && !data.valid) {
        toast.error(`Restored but validation failed: ${data.error}`);
        // Still reload content since the file was written
        setContent(version.content);
        setOriginalContent(version.content);
        if (selectedFile) fetchVersions(selectedFile);
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

  // Clear the insert ref when not in code editor mode (the view would be destroyed)
  useEffect(() => {
    if (editorMode !== "code") {
      insertAtCursorRef.current = null;
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

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* File tree sidebar */}
      <div className="w-64 shrink-0 border-r border-border overflow-y-auto bg-card">
        <div className="px-3 py-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
            Config Files
          </h3>
        </div>
        <FileTree
          files={files}
          baseDir={baseDir}
          selectedFile={selectedFile}
          onSelect={loadFile}
        />
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
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
                      <Code className="h-3.5 w-3.5" /> Code
                    </TabsTrigger>
                    <TabsTrigger value="block" className="text-xs gap-1 px-2">
                      <Blocks className="h-3.5 w-3.5" /> Blocks
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button
                  size="sm"
                  variant={historyOpen ? "default" : "outline"}
                  onClick={toggleHistory}
                >
                  <History className="h-3.5 w-3.5 mr-1" /> History
                </Button>
                <Button
                  size="sm"
                  variant={dirty ? "default" : "outline"}
                  onClick={handleSave}
                  disabled={!dirty}
                >
                  <Save className="h-3.5 w-3.5 mr-1" /> Save
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
