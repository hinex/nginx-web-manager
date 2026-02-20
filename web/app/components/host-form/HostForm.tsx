import { useState, useEffect } from "react";
import { Form, useActionData, useFetcher, useNavigation } from "react-router";
import { toast } from "sonner";
import { LocationsTab } from "./LocationsTab";
import { SslTab } from "./SslTab";
import { AdvancedTab } from "./AdvancedTab";
import { AuthTab } from "./AuthTab";
import { GroupCombobox } from "./GroupCombobox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { X, Plus, Loader2 } from "lucide-react";
import { LABEL_COLORS, type LabelItem } from "~/components/LabelsModal";

export interface LocationFormData {
  path: string;
  matchType: "prefix" | "exact" | "regex";
  type: "proxy" | "static" | "redirect" | "file";
  upstreams: Array<{ server: string; port: number; weight: number; protocol: "http" | "https" | "grpc" | "grpcs" | "fastcgi" }>;
  balanceMethod: string;
  staticDir: string;
  cacheExpires: string;
  forwardScheme: string;
  forwardDomain: string;
  forwardPath: string;
  preservePath: boolean;
  statusCode: number;
  headers: Record<string, string>;
  accessListId: number | null;
  basicAuth?: { enabled: boolean; users: Array<{ username: string; password: string }> } | { enabled: false } | null;
}

export interface StreamPortFormData {
  port: number | null;
  protocol: "tcp" | "udp";
  upstreams: Array<{ server: string; port: number; weight: number }>;
  balanceMethod: string;
}

export interface HostFormData {
  domains: string[];
  groupId: number | null;
  enabled: boolean;
  labelIds: number[];

  // SSL
  sslType: string;
  sslCertPath: string;
  sslKeyPath: string;
  sslForceHttps: boolean;
  hsts: boolean;
  http2: boolean;
  compression: boolean;
  redirectWww: boolean;

  // Locations (all routing)
  locations: LocationFormData[];

  // Stream ports (optional TCP/UDP)
  streamPorts: StreamPortFormData[];

  // Common
  webhookUrl: string;
  advancedNginx: string;
  clientMaxBodySize: string;
  basicAuth: { enabled: boolean; users: Array<{ username: string; password: string }> } | null;
}

export const defaultLocation: LocationFormData = {
  path: "/",
  matchType: "prefix",
  type: "proxy",
  upstreams: [],
  balanceMethod: "round_robin",
  staticDir: "",
  cacheExpires: "",
  forwardScheme: "https",
  forwardDomain: "",
  forwardPath: "/",
  preservePath: true,
  statusCode: 301,
  headers: {},
  accessListId: null,
};

interface HostFormProps {
  initialData?: Partial<HostFormData>;
  publishedData?: Partial<HostFormData>;
  hasDraft?: boolean;
  groups: Array<{ id: number; name: string }>;
  labels: LabelItem[];
  accessLists?: Array<{ id: number; name: string }>;
  submitLabel: string;
}

const defaultFormData: HostFormData = {
  domains: [],
  groupId: null,
  enabled: true,
  labelIds: [],

  sslType: "none",
  sslCertPath: "",
  sslKeyPath: "",
  sslForceHttps: false,
  hsts: true,
  http2: true,
  compression: true,
  redirectWww: false,

  locations: [{ ...defaultLocation }],
  streamPorts: [],

  webhookUrl: "",
  advancedNginx: "",
  clientMaxBodySize: "",
  basicAuth: null,
};

export function HostForm({
  initialData,
  publishedData,
  hasDraft = false,
  groups,
  labels,
  accessLists = [],
  submitLabel,
}: HostFormProps) {
  const actionData = useActionData<{ error?: string; drafted?: boolean; discarded?: boolean }>();
  const groupFetcher = useFetcher<{ groupId?: number; error?: string }>();
  const labelFetcher = useFetcher<{ labelId?: number; labelName?: string; labelColor?: string; error?: string }>();

  // Local groups list that can be augmented by inline creation
  const [localGroups, setLocalGroups] = useState(groups);
  const [localLabels, setLocalLabels] = useState(labels);
  const [newLabelName, setNewLabelName] = useState("");

  useEffect(() => {
    setLocalGroups(groups);
  }, [groups]);

  useEffect(() => {
    setLocalLabels(labels);
  }, [labels]);

  // Handle group creation response
  useEffect(() => {
    if (groupFetcher.data && "groupId" in groupFetcher.data && groupFetcher.data.groupId) {
      const newId = groupFetcher.data.groupId;
      // Add to local groups if not already present
      setLocalGroups((prev) => {
        if (prev.some((g) => g.id === newId)) return prev;
        return [...prev, { id: newId, name: (groupFetcher.formData?.get("name") as string) || "New Group" }];
      });
      setFormData((prev) => ({ ...prev, groupId: newId }));
    }
  }, [groupFetcher.data]);

  // Handle label creation response
  useEffect(() => {
    if (labelFetcher.data && "labelId" in labelFetcher.data && labelFetcher.data.labelId) {
      const { labelId, labelName, labelColor } = labelFetcher.data;
      setLocalLabels((prev) => {
        if (prev.some((l) => l.id === labelId)) return prev;
        return [...prev, { id: labelId!, name: labelName!, color: labelColor! }];
      });
      // Auto-select the new label
      setFormData((prev) => ({
        ...prev,
        labelIds: prev.labelIds.includes(labelId!) ? prev.labelIds : [...prev.labelIds, labelId!],
      }));
    }
  }, [labelFetcher.data]);

  const [nginxError, setNginxError] = useState<string | null>(null);

  useEffect(() => {
    if (actionData?.error) {
      if (actionData.error.startsWith("Nginx config validation failed")) {
        setNginxError(actionData.error);
      } else {
        toast.error(actionData.error);
      }
    } else {
      setNginxError(null);
    }
    if (actionData && "drafted" in actionData) {
      toast.success("Draft saved.");
    }
    if (actionData && "discarded" in actionData) {
      toast.success("Draft discarded.");
    }
  }, [actionData]);

  const [activeTab, setActiveTab] = useState("general");
  const [formData, setFormData] = useState<HostFormData>({
    ...defaultFormData,
    ...initialData,
  });
  const [domainInput, setDomainInput] = useState("");

  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [draftView, setDraftView] = useState<"draft" | "published">(hasDraft ? "draft" : "draft");

  useEffect(() => {
    if (draftView === "published" && publishedData) {
      setFormData({ ...defaultFormData, ...publishedData });
    } else if (draftView === "draft") {
      setFormData({ ...defaultFormData, ...initialData });
    }
  }, [draftView]);

  const update = (partial: Partial<HostFormData>) =>
    setFormData((prev) => ({ ...prev, ...partial }));

  const handleAddDomain = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDomainFromInput();
    }
  };

  const addDomainFromInput = () => {
    const value = domainInput.trim();
    if (value && !formData.domains.includes(value)) {
      update({ domains: [...formData.domains, value] });
      setDomainInput("");
    }
  };

  const removeDomain = (index: number) => {
    update({ domains: formData.domains.filter((_, i) => i !== index) });
  };

  const handleCreateGroup = (name: string) => {
    groupFetcher.submit(
      { intent: "createGroup", name },
      { method: "post" }
    );
  };

  const toggleLabel = (labelId: number) => {
    update({
      labelIds: formData.labelIds.includes(labelId)
        ? formData.labelIds.filter((id) => id !== labelId)
        : [...formData.labelIds, labelId],
    });
  };

  const showSsl = formData.domains.length > 0;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intentValue = submitter?.value;
    const isDraftSave = intentValue === "saveDraft";

    // Auto-add pending domain input if non-empty
    const pendingDomain = domainInput.trim();
    if (pendingDomain && !formData.domains.includes(pendingDomain)) {
      formData.domains = [...formData.domains, pendingDomain];
      setDomainInput("");
    }

    // Skip validation for draft saves
    if (!isDraftSave) {
      // Must have at least one location or stream port
      if (formData.locations.length === 0 && formData.streamPorts.length === 0) {
        e.preventDefault();
        toast.error("At least one location or stream port is required");
        setActiveTab("locations");
        return;
      }

      // Domains required if host has HTTP locations
      const hasHttpLocations = formData.locations.length > 0;
      if (hasHttpLocations && formData.domains.length === 0) {
        e.preventDefault();
        toast.error("At least one domain is required for HTTP locations");
        setActiveTab("general");
        return;
      }

      // Validate no duplicate location paths
      const locationKeys = formData.locations.map((l) => {
        const prefix = l.matchType === "exact" ? "= " : l.matchType === "regex" ? "~ " : "";
        return `${prefix}${l.path}`;
      });
      const seenPaths = new Set<string>();
      for (const key of locationKeys) {
        if (seenPaths.has(key)) {
          e.preventDefault();
          toast.error(`Duplicate location "${key}". Each location path + match type must be unique.`);
          setActiveTab("locations");
          return;
        }
        seenPaths.add(key);
      }

      // Validate each location
      for (const loc of formData.locations) {
        if (loc.type === "proxy" && (!loc.upstreams || loc.upstreams.length === 0)) {
          e.preventDefault();
          toast.error(`Proxy location "${loc.path}" needs at least one upstream`);
          setActiveTab("locations");
          return;
        }
        if (loc.type === "static" && !loc.staticDir?.trim()) {
          e.preventDefault();
          toast.error(`Static location "${loc.path}" needs a directory path`);
          setActiveTab("locations");
          return;
        }
        if (loc.type === "redirect" && !loc.forwardDomain?.trim()) {
          e.preventDefault();
          toast.error(`Redirect location "${loc.path}" needs a forward domain`);
          setActiveTab("locations");
          return;
        }
        if (loc.type === "file" && !loc.staticDir?.trim()) {
          e.preventDefault();
          toast.error(`File location "${loc.path}" needs a file path`);
          setActiveTab("locations");
          return;
        }
      }

      // Validate stream ports
      for (const sp of formData.streamPorts) {
        if (!sp.port || sp.port < 1 || sp.port > 65535) {
          e.preventDefault();
          toast.error("Stream port must be between 1 and 65535");
          setActiveTab("advanced");
          return;
        }
        if (!sp.upstreams || sp.upstreams.length === 0) {
          e.preventDefault();
          toast.error(`Stream port ${sp.port} needs at least one upstream`);
          setActiveTab("advanced");
          return;
        }
      }

      if (formData.sslType === "custom") {
        if (!formData.sslCertPath || !formData.sslKeyPath) {
          e.preventDefault();
          toast.error("Please provide both certificate and key paths for custom SSL");
          setActiveTab("ssl");
          return;
        }
      }
    }

    // Write final formData (including any pending domain) to the hidden input
    const hiddenInput = e.currentTarget.querySelector<HTMLInputElement>('input[name="formData"]');
    if (hiddenInput) {
      hiddenInput.value = JSON.stringify(formData);
    }
  };

  const tabs: Array<{ value: string; label: string }> = [
    { value: "general", label: "General" },
    { value: "locations", label: "Locations" },
    { value: "auth", label: "Auth" },
  ];
  if (showSsl) tabs.push({ value: "ssl", label: "SSL" });
  tabs.push({ value: "advanced", label: "Advanced" });

  // Reset tab if current tab is no longer visible
  useEffect(() => {
    if (!tabs.find((t) => t.value === activeTab)) {
      setActiveTab("general");
    }
  }, [formData.domains.length]);

  return (
    <Form method="post" onSubmit={handleSubmit}>
      <input type="hidden" name="formData" value={JSON.stringify(formData)} />

      <Card>
        {/* Draft / Published toggle — only show on edit (when publishedData exists) */}
        {publishedData && (
          <div className="border-b border-border px-6 py-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDraftView("draft")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                draftView === "draft"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Draft
            </button>
            <button
              type="button"
              onClick={() => setDraftView("published")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                draftView === "published"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Published
            </button>
            {hasDraft && (
              <Badge variant="outline" className="ml-2 text-orange-600 border-orange-300">
                Modified
              </Badge>
            )}
          </div>
        )}

        {/* nginx error display */}
        {nginxError && (
          <div className="mx-6 mt-6 rounded-md border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-medium text-destructive mb-2">Nginx Configuration Error</p>
            <pre className="text-xs text-destructive/90 whitespace-pre-wrap font-mono overflow-x-auto">{nginxError.replace("Nginx config validation failed: ", "")}</pre>
          </div>
        )}

        {/* Form content — wrapped with opacity when published view */}
        <div className={cn(draftView === "published" && publishedData && "pointer-events-none opacity-60")}>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="border-b border-border px-4">
              <TabsList className="bg-transparent">
                {tabs.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <CardContent className="p-6">
              {/* General Tab */}
              <TabsContent value="general" className="mt-0">
                <div className="space-y-4">
                  {/* Domains */}
                  <div>
                    <Label className="mb-1">Domains</Label>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {formData.domains.map((domain, index) => (
                        <Badge key={index} variant="secondary" className="gap-1">
                          {domain}
                          <button type="button" onClick={() => removeDomain(index)}>
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        value={domainInput}
                        onChange={(e) => setDomainInput(e.target.value)}
                        onKeyDown={handleAddDomain}
                        placeholder="example.com"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={addDomainFromInput}
                        disabled={!domainInput.trim()}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Group */}
                  <div>
                    <Label className="mb-1">Group</Label>
                    <GroupCombobox
                      groups={localGroups}
                      value={formData.groupId}
                      onChange={(groupId) => update({ groupId })}
                      onCreateGroup={handleCreateGroup}
                    />
                  </div>

                  {/* Labels */}
                  <div>
                    <Label className="mb-1">Labels</Label>
                    <div className="flex flex-wrap gap-2">
                      {localLabels.map((label) => {
                        const colorDef = LABEL_COLORS.find((c) => c.value === label.color);
                        const isSelected = formData.labelIds.includes(label.id);
                        return (
                          <button
                            key={label.id}
                            type="button"
                            onClick={() => toggleLabel(label.id)}
                            className={cn(
                              "px-2 py-1 rounded text-xs font-medium border-2 transition-colors",
                              colorDef?.bg,
                              isSelected ? "border-foreground" : "border-transparent opacity-60"
                            )}
                          >
                            {label.name}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex gap-2 mt-2">
                      <Input
                        type="text"
                        value={newLabelName}
                        onChange={(e) => setNewLabelName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (newLabelName.trim()) {
                              labelFetcher.submit(
                                { intent: "createLabel", name: newLabelName.trim(), color: "green" },
                                { method: "post" }
                              );
                              setNewLabelName("");
                            }
                          }
                        }}
                        placeholder="New label name..."
                        className="flex-1 h-8 text-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={!newLabelName.trim()}
                        onClick={() => {
                          labelFetcher.submit(
                            { intent: "createLabel", name: newLabelName.trim(), color: "green" },
                            { method: "post" }
                          );
                          setNewLabelName("");
                        }}
                      >
                        <Plus className="mr-1 h-3 w-3" />
                        Add
                      </Button>
                    </div>
                  </div>

                  {/* Enabled */}
                  <div className="flex items-center gap-3">
                    <Switch checked={formData.enabled} onCheckedChange={(enabled) => update({ enabled })} />
                    <Label>Enabled</Label>
                  </div>

                  {/* Compression */}
                  <div className="flex items-center gap-3">
                    <Switch checked={formData.compression} onCheckedChange={(compression) => update({ compression })} />
                    <Label>Response Compression (gzip + brotli)</Label>
                  </div>
                </div>
              </TabsContent>

              {/* Locations Tab */}
              <TabsContent value="locations" className="mt-0">
                <LocationsTab
                  locations={formData.locations}
                  setLocations={(locations) => update({ locations })}
                  accessLists={accessLists}
                />
              </TabsContent>

              {/* Auth Tab */}
              <TabsContent value="auth" className="mt-0">
                <AuthTab
                  basicAuth={formData.basicAuth}
                  setBasicAuth={(basicAuth) => update({ basicAuth })}
                />
              </TabsContent>

              {/* SSL Tab */}
              {showSsl && (
                <TabsContent value="ssl" className="mt-0">
                  <SslTab
                    sslType={formData.sslType}
                    setSslType={(sslType) => update({ sslType })}
                    sslCertPath={formData.sslCertPath}
                    setSslCertPath={(sslCertPath) => update({ sslCertPath })}
                    sslKeyPath={formData.sslKeyPath}
                    setSslKeyPath={(sslKeyPath) => update({ sslKeyPath })}
                    sslForceHttps={formData.sslForceHttps}
                    setSslForceHttps={(sslForceHttps) => update({ sslForceHttps })}
                    http2={formData.http2}
                    setHttp2={(http2) => update({ http2 })}
                    hsts={formData.hsts}
                    setHsts={(hsts) => update({ hsts })}
                    redirectWww={formData.redirectWww}
                    setRedirectWww={(redirectWww) => update({ redirectWww })}
                  />
                </TabsContent>
              )}

              {/* Advanced Tab */}
              <TabsContent value="advanced" className="mt-0">
                <AdvancedTab
                  webhookUrl={formData.webhookUrl}
                  setWebhookUrl={(webhookUrl) => update({ webhookUrl })}
                  advancedNginx={formData.advancedNginx}
                  setAdvancedNginx={(advancedNginx) => update({ advancedNginx })}
                  clientMaxBodySize={formData.clientMaxBodySize}
                  setClientMaxBodySize={(clientMaxBodySize) => update({ clientMaxBodySize })}
                  streamPorts={formData.streamPorts}
                  setStreamPorts={(streamPorts) => update({ streamPorts })}
                />
              </TabsContent>
            </CardContent>
          </Tabs>
        </div>

        {/* Action buttons */}
        <div className="border-t border-border px-6 py-4 flex justify-end gap-3">
          <Button variant="outline" type="button" onClick={() => window.history.back()}>
            Cancel
          </Button>
          {hasDraft && draftView === "draft" && (
            <Button
              variant="outline"
              type="submit"
              name="intent"
              value="discardDraft"
              disabled={isSubmitting}
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
            >
              Discard Draft
            </Button>
          )}
          {!(draftView === "published" && publishedData) && (
            <>
              <Button
                variant="outline"
                type="submit"
                name="intent"
                value="saveDraft"
                disabled={isSubmitting}
              >
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save Draft
              </Button>
              <Button
                type="submit"
                name="intent"
                value="publish"
                disabled={isSubmitting}
              >
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {submitLabel}
              </Button>
            </>
          )}
        </div>
      </Card>
    </Form>
  );
}
