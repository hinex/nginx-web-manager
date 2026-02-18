import { useState, useCallback } from "react";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Plus, Trash2, ChevronDown, ChevronUp, Zap, Loader2 } from "lucide-react";
import { defaultLocation, type LocationFormData } from "./HostForm";

interface LocationsTabProps {
  locations: LocationFormData[];
  setLocations: (locations: LocationFormData[]) => void;
  accessLists?: Array<{ id: number; name: string }>;
}

export function LocationsTab({ locations, setLocations, accessLists = [] }: LocationsTabProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(
    locations.length === 1 ? 0 : null
  );

  const addLocation = () => {
    setLocations([...locations, { ...defaultLocation }]);
    setExpandedIndex(locations.length);
  };

  const removeLocation = (index: number) => {
    setLocations(locations.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) {
      setExpandedIndex(expandedIndex - 1);
    }
  };

  const updateLocation = (index: number, partial: Partial<LocationFormData>) => {
    const updated = [...locations];
    updated[index] = { ...updated[index], ...partial };
    setLocations(updated);
  };

  const addUpstream = (locIndex: number) => {
    const loc = locations[locIndex];
    updateLocation(locIndex, {
      upstreams: [...loc.upstreams, { server: "", port: 80, weight: 1 }],
    });
  };

  const removeUpstream = (locIndex: number, upstreamIndex: number) => {
    const loc = locations[locIndex];
    updateLocation(locIndex, {
      upstreams: loc.upstreams.filter((_, i) => i !== upstreamIndex),
    });
  };

  const updateUpstream = (
    locIndex: number,
    upstreamIndex: number,
    field: string,
    value: string | number
  ) => {
    const loc = locations[locIndex];
    const upstreams = [...loc.upstreams];
    upstreams[upstreamIndex] = { ...upstreams[upstreamIndex], [field]: value };
    updateLocation(locIndex, { upstreams });
  };

  const addHeader = (locIndex: number) => {
    const loc = locations[locIndex];
    updateLocation(locIndex, {
      headers: { ...loc.headers, "": "" },
    });
  };

  const removeHeader = (locIndex: number, key: string) => {
    const loc = locations[locIndex];
    const headers = { ...loc.headers };
    delete headers[key];
    updateLocation(locIndex, { headers });
  };

  const updateHeader = (locIndex: number, oldKey: string, newKey: string, newValue: string) => {
    const loc = locations[locIndex];
    const entries = Object.entries(loc.headers);
    const newHeaders: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k === oldKey) {
        newHeaders[newKey] = newValue;
      } else {
        newHeaders[k] = v;
      }
    }
    updateLocation(locIndex, { headers: newHeaders });
  };

  const [testResults, setTestResults] = useState<
    Record<string, { status: "up" | "down"; responseMs: number; error?: string; loading?: boolean }>
  >({});

  const testUpstream = useCallback(async (locIndex: number, upIndex: number, server: string, port: number) => {
    const key = `${locIndex}-${upIndex}`;
    setTestResults((prev) => ({ ...prev, [key]: { status: "up", responseMs: 0, loading: true } }));

    try {
      const res = await fetch("/api/test-upstream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server, port }),
      });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [key]: data }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [key]: { status: "down", responseMs: 0, error: "Request failed" },
      }));
    }

    setTimeout(() => {
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 5000);
  }, []);

  const getSummary = (loc: LocationFormData) => {
    switch (loc.type) {
      case "proxy": {
        const count = loc.upstreams.length;
        if (count === 0) return "No upstreams";
        if (count === 1) return `\u2192 ${loc.upstreams[0].server}:${loc.upstreams[0].port}`;
        return `\u2192 ${count} upstreams (${loc.balanceMethod})`;
      }
      case "static":
        return loc.staticDir ? `Static: ${loc.staticDir}` : "No directory set";
      case "file":
        return loc.staticDir ? `File: ${loc.staticDir}` : "No file path set";
      case "redirect":
        return loc.forwardDomain
          ? `\u2192 ${loc.forwardScheme}://${loc.forwardDomain}${loc.forwardPath}`
          : "No target set";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <Label>Locations</Label>
        <Button variant="outline" size="sm" type="button" onClick={addLocation}>
          <Plus className="mr-2 h-4 w-4" />
          Add Location
        </Button>
      </div>

      {locations.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          No locations configured. Add a location to define routing behavior.
        </div>
      ) : (
        <div className="space-y-3">
          {locations.map((location, locIndex) => (
            <div key={locIndex} className="rounded-md border">
              {/* Collapsed header */}
              <div
                className="flex items-center justify-between px-4 py-3 bg-muted/50 cursor-pointer"
                onClick={() =>
                  setExpandedIndex(expandedIndex === locIndex ? null : locIndex)
                }
              >
                <div className="flex items-center gap-3 text-sm min-w-0">
                  <span className="font-mono font-medium shrink-0">
                    {location.path || "/"}
                  </span>
                  <span className="text-muted-foreground shrink-0">{location.matchType}</span>
                  <span className="capitalize shrink-0">{location.type}</span>
                  <span className="text-muted-foreground truncate">{getSummary(location)}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeLocation(locIndex);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {expandedIndex === locIndex ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>

              {/* Expanded content */}
              {expandedIndex === locIndex && (
                <div className="p-4 space-y-4 border-t">
                  {/* Row 1: Path + Match Type + Type */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label className="text-xs mb-1">Path</Label>
                      <Input
                        type="text"
                        value={location.path}
                        onChange={(e) => updateLocation(locIndex, { path: e.target.value })}
                        placeholder="/"
                      />
                    </div>
                    <div>
                      <Label className="text-xs mb-1">Match Type</Label>
                      <select
                        value={location.matchType}
                        onChange={(e) => updateLocation(locIndex, { matchType: e.target.value as any })}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="prefix">Prefix</option>
                        <option value="exact">Exact</option>
                        <option value="regex">Regex</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs mb-1">Type</Label>
                      <select
                        value={location.type}
                        onChange={(e) => updateLocation(locIndex, { type: e.target.value as any })}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="proxy">Proxy</option>
                        <option value="static">Static</option>
                        <option value="file">File</option>
                        <option value="redirect">Redirect</option>
                      </select>
                    </div>
                  </div>

                  {/* Type-specific section: Proxy */}
                  {location.type === "proxy" && (
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs mb-1">Load Balancing Method</Label>
                        <select
                          value={location.balanceMethod}
                          onChange={(e) => updateLocation(locIndex, { balanceMethod: e.target.value })}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <option value="round_robin">Round Robin</option>
                          <option value="weighted">Weighted</option>
                          <option value="least_conn">Least Connections</option>
                          <option value="ip_hash">IP Hash</option>
                          <option value="random">Random</option>
                        </select>
                      </div>

                      <div className="flex justify-between items-center">
                        <Label className="text-xs">Upstreams</Label>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => addUpstream(locIndex)}
                        >
                          <Plus className="mr-2 h-3 w-3" />
                          Add Upstream
                        </Button>
                      </div>

                      {location.upstreams.length > 0 && (
                        <div className="space-y-2">
                          {location.upstreams.map((upstream, upIndex) => {
                            const testKey = `${locIndex}-${upIndex}`;
                            const result = testResults[testKey];
                            return (
                              <div key={upIndex}>
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="text"
                                    value={upstream.server}
                                    onChange={(e) => updateUpstream(locIndex, upIndex, "server", e.target.value)}
                                    placeholder="Server"
                                    className="text-xs flex-1"
                                  />
                                  <Input
                                    type="number"
                                    value={upstream.port}
                                    onChange={(e) => updateUpstream(locIndex, upIndex, "port", Number(e.target.value))}
                                    placeholder="Port"
                                    className="text-xs w-24"
                                  />
                                  <Input
                                    type="number"
                                    value={upstream.weight}
                                    onChange={(e) => updateUpstream(locIndex, upIndex, "weight", Number(e.target.value))}
                                    placeholder="Weight"
                                    className="text-xs w-20"
                                    min={1}
                                  />
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    disabled={!upstream.server || !upstream.port || !!result?.loading}
                                    onClick={() => testUpstream(locIndex, upIndex, upstream.server, upstream.port)}
                                  >
                                    {result?.loading ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Zap className="h-3 w-3" />
                                    )}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    onClick={() => removeUpstream(locIndex, upIndex)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                                {result && !result.loading && (
                                  <p className={`text-xs mt-1 ml-1 ${result.status === "up" ? "text-green-500" : "text-red-500"}`}>
                                    {result.status === "up"
                                      ? `up \u00B7 ${result.responseMs}ms`
                                      : `down \u00B7 ${result.error}`}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div>
                        <Label className="text-xs mb-1">Forward Path</Label>
                        <Input
                          type="text"
                          value={location.forwardPath}
                          onChange={(e) => updateLocation(locIndex, { forwardPath: e.target.value })}
                          placeholder="/ (no rewrite)"
                          className="text-xs"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Rewrites the location path prefix when proxying (e.g. path "/api" + forward path "/api-test" → /api/users becomes /api-test/users)
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Type-specific section: Static */}
                  {location.type === "static" && (
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs mb-1">Static Directory Path</Label>
                        <Input
                          type="text"
                          value={location.staticDir}
                          onChange={(e) => updateLocation(locIndex, { staticDir: e.target.value })}
                          placeholder="/var/www/html"
                        />
                      </div>
                      <div>
                        <Label className="text-xs mb-1">Cache Expires</Label>
                        <Input
                          type="text"
                          value={location.cacheExpires}
                          onChange={(e) => updateLocation(locIndex, { cacheExpires: e.target.value })}
                          placeholder="30d, 1h, 3600s"
                        />
                      </div>
                    </div>
                  )}

                  {/* Type-specific section: File */}
                  {location.type === "file" && (
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs mb-1">File Path</Label>
                        <Input
                          type="text"
                          value={location.staticDir}
                          onChange={(e) => updateLocation(locIndex, { staticDir: e.target.value })}
                          placeholder="/var/www/sitemap.xml"
                        />
                      </div>
                      <div>
                        <Label className="text-xs mb-1">Cache Expires</Label>
                        <Input
                          type="text"
                          value={location.cacheExpires}
                          onChange={(e) => updateLocation(locIndex, { cacheExpires: e.target.value })}
                          placeholder="30d, 1h, 3600s"
                        />
                      </div>
                    </div>
                  )}

                  {/* Type-specific section: Redirect */}
                  {location.type === "redirect" && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs mb-1">Scheme</Label>
                          <select
                            value={location.forwardScheme}
                            onChange={(e) => updateLocation(locIndex, { forwardScheme: e.target.value })}
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <option value="http">http</option>
                            <option value="https">https</option>
                          </select>
                        </div>
                        <div>
                          <Label className="text-xs mb-1">Status Code</Label>
                          <select
                            value={location.statusCode}
                            onChange={(e) => updateLocation(locIndex, { statusCode: Number(e.target.value) })}
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <option value="301">301 (Permanent)</option>
                            <option value="302">302 (Temporary)</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs mb-1">Forward Domain</Label>
                        <Input
                          type="text"
                          value={location.forwardDomain}
                          onChange={(e) => updateLocation(locIndex, { forwardDomain: e.target.value })}
                          placeholder="example.com"
                        />
                      </div>
                      <div>
                        <Label className="text-xs mb-1">Forward Path</Label>
                        <Input
                          type="text"
                          value={location.forwardPath}
                          onChange={(e) => updateLocation(locIndex, { forwardPath: e.target.value })}
                          placeholder="/"
                        />
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id={`preservePath-${locIndex}`}
                          checked={location.preservePath}
                          onCheckedChange={(checked) =>
                            updateLocation(locIndex, { preservePath: checked === true })
                          }
                        />
                        <Label htmlFor={`preservePath-${locIndex}`} className="font-normal text-xs">
                          Preserve Path
                        </Label>
                      </div>
                    </div>
                  )}

                  {/* Headers section */}
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <Label className="text-xs">Response Headers</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => addHeader(locIndex)}
                      >
                        <Plus className="mr-2 h-3 w-3" />
                        Add Header
                      </Button>
                    </div>
                    {Object.entries(location.headers).length > 0 && (
                      <div className="space-y-2">
                        {Object.entries(location.headers).map(([key, value], hIdx) => (
                          <div key={hIdx} className="flex gap-2 items-center">
                            <Input
                              type="text"
                              value={key}
                              onChange={(e) => updateHeader(locIndex, key, e.target.value, value)}
                              placeholder="Header name"
                              className="text-xs flex-1"
                            />
                            <Input
                              type="text"
                              value={value}
                              onChange={(e) => updateHeader(locIndex, key, key, e.target.value)}
                              placeholder="Header value"
                              className="text-xs flex-1"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              onClick={() => removeHeader(locIndex, key)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Access List */}
                  {accessLists.length > 0 && (
                    <div>
                      <Label className="text-xs mb-1">Access List</Label>
                      <select
                        value={location.accessListId ?? ""}
                        onChange={(e) =>
                          updateLocation(locIndex, {
                            accessListId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="">None</option>
                        {accessLists.map((al) => (
                          <option key={al.id} value={al.id}>
                            {al.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
