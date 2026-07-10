import { useState, useMemo, useCallback, useEffect } from "react";
import type { Route } from "./+types/templates";
import { requireEditor } from "~/lib/auth/middleware";
import { useFetcher } from "react-router";
import {
  getBuiltinTemplates,
  renderTemplate,
  type Template,
  type TemplateVariable,
} from "~/lib/templates/parser";
import { db } from "~/lib/db/connection";
import { customTemplates } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser } from "~/lib/auth/session.server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  FileCode2,
  Search,
  Copy,
  Check,
  ArrowRight,
  Globe,
  Shield,
  RotateCcw,
  Layers,
  Plus,
  Trash2,
  Save,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";
import { emitTemplateInsert } from "~/lib/events/template-insert";

export function meta() {
  return [{ title: "Config Templates — Nginx Manager" }];
}

interface CustomTemplateRow {
  id: number;
  name: string;
  description: string | null;
  category: string;
  content: string;
  variables: Array<{ name: string; label: string; default: string }> | null;
  createdAt: Date;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireEditor(request);
  const builtinTemplates = getBuiltinTemplates();
  const customRows = db.select().from(customTemplates).all();

  return {
    templates: builtinTemplates.map((t) => ({
      meta: t.meta,
      body: t.body,
    })),
    customTemplates: customRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      content: row.content,
      variables: row.variables,
      createdAt: row.createdAt,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireEditor(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const user = await getSessionUser(request);

  if (intent === "create_template") {
    const name = formData.get("name") as string;
    const description = formData.get("description") as string;
    const category = formData.get("category") as string;
    const content = formData.get("content") as string;
    const variablesJson = formData.get("variables") as string;

    if (!name || !name.trim()) return { error: "Name is required" };
    if (!content || !content.trim()) return { error: "Content is required" };

    let variables: Array<{ name: string; label: string; default: string }> | null = null;
    if (variablesJson) {
      try {
        variables = JSON.parse(variablesJson);
      } catch {
        return { error: "Invalid variables format" };
      }
    }

    db.insert(customTemplates)
      .values({
        name: name.trim(),
        description: description?.trim() || null,
        category: category?.trim() || "custom",
        content: content,
        variables,
        userId: user?.userId ?? null,
        createdAt: new Date(),
      })
      .run();

    return { success: true, message: "Template saved successfully" };
  }

  if (intent === "delete_template") {
    const id = Number(formData.get("id"));
    if (!id) return { error: "Template ID is required" };

    db.delete(customTemplates).where(eq(customTemplates.id, id)).run();
    return { success: true, message: "Template deleted" };
  }

  return { error: "Unknown action" };
}

const categoryConfig: Record<string, { label: string; icon: typeof Globe; color: string }> = {
  proxy: { label: "Proxy", icon: Globe, color: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  web: { label: "Web", icon: Layers, color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" },
  security: { label: "Security", icon: Shield, color: "bg-orange-500/10 text-orange-600 border-orange-500/20" },
  redirect: { label: "Redirect", icon: RotateCcw, color: "bg-purple-500/10 text-purple-600 border-purple-500/20" },
  custom: { label: "Custom", icon: FileCode2, color: "bg-pink-500/10 text-pink-600 border-pink-500/20" },
};

function CategoryBadge({ category }: { category: string }) {
  const config = categoryConfig[category] ?? {
    label: category,
    icon: FileCode2,
    color: "bg-secondary text-secondary-foreground",
  };
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 text-xs font-medium", config.color)}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

interface DisplayTemplate {
  meta: {
    name: string;
    description: string;
    category: string;
    variables: TemplateVariable[];
  };
  body: string;
  isCustom: boolean;
  customId?: number;
}

export default function TemplatesPage({ loaderData }: Route.ComponentProps) {
  const { templates, customTemplates: customRows } = loaderData;
  const fetcher = useFetcher();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<DisplayTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string | number | boolean>>({});
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  // Save dialog state
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [saveCategory, setSaveCategory] = useState("custom");
  const [saveContent, setSaveContent] = useState("");
  const [saveVariables, setSaveVariables] = useState("");

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<DisplayTemplate | null>(null);

  // Combine built-in and custom templates into a unified list
  const allTemplates: DisplayTemplate[] = useMemo(() => {
    const builtin: DisplayTemplate[] = templates.map((t: Template) => ({
      meta: t.meta,
      body: t.body,
      isCustom: false,
    }));

    const custom: DisplayTemplate[] = customRows.map((row: CustomTemplateRow) => ({
      meta: {
        name: row.name,
        description: row.description || "",
        category: row.category,
        variables: (row.variables || []).map((v) => ({
          name: v.name,
          label: v.label,
          type: "string" as const,
          default: v.default,
        })),
      },
      body: row.content,
      isCustom: true,
      customId: row.id,
    }));

    return [...builtin, ...custom];
  }, [templates, customRows]);

  const categories = useMemo(() => {
    const cats = new Set(allTemplates.map((t) => t.meta.category));
    return Array.from(cats).sort();
  }, [allTemplates]);

  const filtered = useMemo(() => {
    return allTemplates.filter((t) => {
      const matchesSearch =
        !search ||
        t.meta.name.toLowerCase().includes(search.toLowerCase()) ||
        t.meta.description.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = !categoryFilter || t.meta.category === categoryFilter;
      return matchesSearch && matchesCategory;
    });
  }, [allTemplates, search, categoryFilter]);

  const openTemplateDialog = useCallback((template: DisplayTemplate) => {
    setSelectedTemplate(template);
    const defaults: Record<string, string | number | boolean> = {};
    for (const v of template.meta.variables) {
      if (v.default !== undefined) {
        defaults[v.name] = v.default;
      } else if (v.type === "boolean") {
        defaults[v.name] = false;
      } else if (v.type === "number") {
        defaults[v.name] = 0;
      } else {
        defaults[v.name] = "";
      }
    }
    setVariableValues(defaults);
    setShowPreview(false);
    setCopied(false);
  }, []);

  const closeDialog = useCallback(() => {
    setSelectedTemplate(null);
    setVariableValues({});
    setShowPreview(false);
    setCopied(false);
  }, []);

  const handleVariableChange = useCallback(
    (name: string, value: string | number | boolean) => {
      setVariableValues((prev) => ({ ...prev, [name]: value }));
    },
    []
  );

  const renderedOutput = useMemo(() => {
    if (!selectedTemplate) return "";
    try {
      return renderTemplate(selectedTemplate as Template, variableValues);
    } catch {
      return "Error rendering template";
    }
  }, [selectedTemplate, variableValues]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(renderedOutput);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }, [renderedOutput]);

  const handleInsertIntoEditor = useCallback(() => {
    emitTemplateInsert(renderedOutput);
    toast.success("Template queued. Open a config file to insert it.");
  }, [renderedOutput]);

  // Open save dialog, optionally pre-filling from a selected template
  const openSaveDialog = useCallback((prefillContent?: string) => {
    setShowSaveDialog(true);
    setSaveName("");
    setSaveDescription("");
    setSaveCategory("custom");
    setSaveContent(prefillContent || "");
    setSaveVariables("[]");
  }, []);

  const closeSaveDialog = useCallback(() => {
    setShowSaveDialog(false);
    setSaveName("");
    setSaveDescription("");
    setSaveCategory("custom");
    setSaveContent("");
    setSaveVariables("[]");
  }, []);

  const handleSaveTemplate = useCallback(() => {
    if (!saveName.trim()) {
      toast.error("Template name is required");
      return;
    }
    if (!saveContent.trim()) {
      toast.error("Template content is required");
      return;
    }

    const formData = new FormData();
    formData.set("intent", "create_template");
    formData.set("name", saveName);
    formData.set("description", saveDescription);
    formData.set("category", saveCategory);
    formData.set("content", saveContent);
    formData.set("variables", saveVariables);
    fetcher.submit(formData, { method: "post" });
    closeSaveDialog();
  }, [saveName, saveDescription, saveCategory, saveContent, saveVariables, fetcher, closeSaveDialog]);

  const handleDeleteTemplate = useCallback((template: DisplayTemplate) => {
    setDeleteTarget(template);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deleteTarget?.customId) {
      const formData = new FormData();
      formData.set("intent", "delete_template");
      formData.set("id", String(deleteTarget.customId));
      fetcher.submit(formData, { method: "post" });
    }
    setDeleteTarget(null);
  }, [deleteTarget, fetcher]);

  // Show toast on fetcher completion
  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      const data = fetcher.data as { success?: boolean; message?: string; error?: string };
      if (data.success) {
        toast.success(data.message || "Done");
      } else if (data.error) {
        toast.error(data.error);
      }
    }
  }, [fetcher.data, fetcher.state]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        title="Config Templates"
        description="Pre-built nginx configuration snippets"
        actions={
          <Button onClick={() => openSaveDialog()} className="gap-1.5 shrink-0 press-effect">
            <Plus className="h-4 w-4" /> Save Custom Template
          </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={categoryFilter === null ? "default" : "outline"}
            size="sm"
            onClick={() => setCategoryFilter(null)}
          >
            All
          </Button>
          {categories.map((cat) => (
            <Button
              key={cat}
              variant={categoryFilter === cat ? "default" : "outline"}
              size="sm"
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
            >
              {categoryConfig[cat]?.label ?? cat}
            </Button>
          ))}
        </div>
      </div>

      {/* Template Grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileCode2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg">No templates found</p>
          <p className="text-sm mt-1">Try adjusting your search or filter</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((template) => (
            <Card
              glass
              key={`${template.isCustom ? "custom" : "builtin"}-${template.customId ?? template.meta.name}`}
              className="group hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => openTemplateDialog(template)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{template.meta.name}</CardTitle>
                  <div className="flex gap-1.5 items-center shrink-0">
                    {template.isCustom && (
                      <Badge variant="secondary" className="text-xs">
                        Custom
                      </Badge>
                    )}
                    <CategoryBadge category={template.meta.category} />
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {template.meta.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {template.meta.variables.length} variable{template.meta.variables.length !== 1 ? "s" : ""}
                  </span>
                  <div className="flex gap-1">
                    {template.isCustom && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteTemplate(template);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        openTemplateDialog(template);
                      }}
                    >
                      Use Template <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Template Dialog */}
      <Dialog open={selectedTemplate !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedTemplate && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <DialogTitle>{selectedTemplate.meta.name}</DialogTitle>
                  {selectedTemplate.isCustom && (
                    <Badge variant="secondary" className="text-xs">
                      Custom
                    </Badge>
                  )}
                  <CategoryBadge category={selectedTemplate.meta.category} />
                </div>
                <DialogDescription>{selectedTemplate.meta.description}</DialogDescription>
              </DialogHeader>

              {!showPreview ? (
                /* Variable Form */
                <div className="space-y-4 py-2">
                  {selectedTemplate.meta.variables.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">
                      This template has no variables. Click preview to see the output.
                    </p>
                  )}
                  {selectedTemplate.meta.variables.map((v: TemplateVariable) => (
                    <VariableField
                      key={v.name}
                      variable={v}
                      value={variableValues[v.name]}
                      onChange={(val) => handleVariableChange(v.name, val)}
                    />
                  ))}
                </div>
              ) : (
                /* Preview */
                <div className="py-2">
                  <div className="rounded-md border bg-muted/50">
                    <pre className="p-4 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
                      {renderedOutput}
                    </pre>
                  </div>
                </div>
              )}

              <DialogFooter className="gap-2 sm:gap-0">
                {showPreview ? (
                  <>
                    <Button variant="outline" onClick={() => setShowPreview(false)}>
                      Back to Variables
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => openSaveDialog(renderedOutput)}
                      className="gap-1.5"
                    >
                      <Save className="h-4 w-4" /> Save as Template
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleInsertIntoEditor}
                      className="gap-1.5"
                    >
                      <FileCode2 className="h-4 w-4" /> Insert into Editor
                    </Button>
                    <Button onClick={handleCopy} className="gap-1.5">
                      {copied ? (
                        <>
                          <Check className="h-4 w-4" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" /> Copy to Clipboard
                        </>
                      )}
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setShowPreview(true)} className="gap-1.5">
                    Preview Config <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Save Custom Template Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={(open) => !open && closeSaveDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Save Custom Template</DialogTitle>
            <DialogDescription>
              Save a reusable nginx configuration template. You can optionally define variables
              using JSON format.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="save-name">Name</Label>
              <Input
                id="save-name"
                placeholder="My Custom Template"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="save-description">Description</Label>
              <Input
                id="save-description"
                placeholder="A brief description of what this template does"
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="save-category">Category</Label>
              <Input
                id="save-category"
                placeholder="custom"
                value={saveCategory}
                onChange={(e) => setSaveCategory(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use an existing category (proxy, web, security, redirect) or create a new one.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="save-content">Template Content</Label>
              <Textarea
                id="save-content"
                placeholder="server { ... }"
                value={saveContent}
                onChange={(e) => setSaveContent(e.target.value)}
                rows={12}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {"Paste your nginx config here. Use {{variable_name}} for variable placeholders."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="save-variables">Variables (JSON)</Label>
              <Textarea
                id="save-variables"
                placeholder={'[{"name": "domain", "label": "Domain Name", "default": "example.com"}]'}
                value={saveVariables}
                onChange={(e) => setSaveVariables(e.target.value)}
                rows={3}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Optional. JSON array of variable definitions with name, label, and default fields.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeSaveDialog}>
              Cancel
            </Button>
            <Button onClick={handleSaveTemplate} className="gap-1.5 press-effect">
              <Save className="h-4 w-4" /> Save Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.meta.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VariableField({
  variable,
  value,
  onChange,
}: {
  variable: TemplateVariable;
  value: string | number | boolean | undefined;
  onChange: (val: string | number | boolean) => void;
}) {
  if (variable.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label className="text-sm font-medium">{variable.label}</Label>
          <p className="text-xs text-muted-foreground mt-0.5">{variable.name}</p>
        </div>
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`var-${variable.name}`} className="text-sm font-medium">
        {variable.label}
      </Label>
      <Input
        id={`var-${variable.name}`}
        type={variable.type === "number" ? "number" : "text"}
        value={value !== undefined ? String(value) : ""}
        onChange={(e) => {
          if (variable.type === "number") {
            onChange(Number(e.target.value) || 0);
          } else {
            onChange(e.target.value);
          }
        }}
        placeholder={variable.default !== undefined ? String(variable.default) : ""}
      />
      <p className="text-xs text-muted-foreground">{variable.name}</p>
    </div>
  );
}
