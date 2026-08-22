import { useState, useCallback } from "react";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Plus, Trash2, Zap, Loader2 } from "lucide-react";
import type { StreamPortFormData } from "./HostForm";

interface AdvancedTabProps {
  webhookUrl: string;
  setWebhookUrl: (url: string) => void;
  advancedNginx: string;
  setAdvancedNginx: (nginx: string) => void;
  customPrelude: string;
  setCustomPrelude: (prelude: string) => void;
  clientMaxBodySize: string;
  setClientMaxBodySize: (size: string) => void;
  streamPorts: StreamPortFormData[];
  setStreamPorts: (ports: StreamPortFormData[]) => void;
}

export function AdvancedTab({
  webhookUrl,
  setWebhookUrl,
  advancedNginx,
  setAdvancedNginx,
  customPrelude,
  setCustomPrelude,
  clientMaxBodySize,
  setClientMaxBodySize,
  streamPorts,
  setStreamPorts,
}: AdvancedTabProps) {
  const addStreamPort = () => {
    setStreamPorts([
      ...streamPorts,
      { port: null, protocol: "tcp", upstreams: [], balanceMethod: "round_robin" },
    ]);
  };

  const removeStreamPort = (index: number) => {
    setStreamPorts(streamPorts.filter((_, i) => i !== index));
  };

  const updateStreamPort = (index: number, partial: Partial<StreamPortFormData>) => {
    const updated = [...streamPorts];
    updated[index] = { ...updated[index], ...partial };
    setStreamPorts(updated);
  };

  const addStreamUpstream = (spIndex: number) => {
    const sp = streamPorts[spIndex];
    updateStreamPort(spIndex, {
      upstreams: [...sp.upstreams, { server: "", port: 80, weight: 1 }],
    });
  };

  const removeStreamUpstream = (spIndex: number, upIndex: number) => {
    const sp = streamPorts[spIndex];
    updateStreamPort(spIndex, {
      upstreams: sp.upstreams.filter((_, i) => i !== upIndex),
    });
  };

  const updateStreamUpstream = (
    spIndex: number,
    upIndex: number,
    field: string,
    value: string | number
  ) => {
    const sp = streamPorts[spIndex];
    const upstreams = [...sp.upstreams];
    upstreams[upIndex] = { ...upstreams[upIndex], [field]: value };
    updateStreamPort(spIndex, { upstreams });
  };

  const [testResults, setTestResults] = useState<
    Record<string, { status: "up" | "down"; responseMs: number; error?: string; loading?: boolean }>
  >({});

  const testUpstream = useCallback(async (spIndex: number, upIndex: number, server: string, port: number) => {
    const key = `${spIndex}-${upIndex}`;
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

  return (
    <div className="space-y-4">
      {/* Stream Ports */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <Label>Stream Ports (TCP/UDP)</Label>
          <Button variant="outline" size="sm" type="button" onClick={addStreamPort}>
            <Plus className="mr-2 h-4 w-4" />
            Add Stream Port
          </Button>
        </div>

        {streamPorts.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No stream ports configured. Stream ports forward raw TCP/UDP traffic.
          </div>
        ) : (
          <div className="space-y-3">
            {streamPorts.map((sp, spIndex) => (
              <div key={spIndex} className="rounded-md border p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Stream Port {spIndex + 1}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => removeStreamPort(spIndex)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs mb-1">Port</Label>
                    <Input
                      type="number"
                      value={sp.port ?? ""}
                      onChange={(e) =>
                        updateStreamPort(spIndex, {
                          port: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      min={1}
                      max={65535}
                      placeholder="3306"
                    />
                  </div>
                  <div>
                    <Label className="text-xs mb-1">Protocol</Label>
                    <select
                      value={sp.protocol}
                      onChange={(e) =>
                        updateStreamPort(spIndex, { protocol: e.target.value as "tcp" | "udp" })
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs mb-1">Balance Method</Label>
                    <select
                      value={sp.balanceMethod}
                      onChange={(e) =>
                        updateStreamPort(spIndex, { balanceMethod: e.target.value })
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="round_robin">Round Robin</option>
                      <option value="weighted">Weighted</option>
                      <option value="least_conn">Least Connections</option>
                      <option value="ip_hash">IP Hash</option>
                      <option value="random">Random</option>
                    </select>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <Label className="text-xs">Upstreams</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={() => addStreamUpstream(spIndex)}
                    >
                      <Plus className="mr-2 h-3 w-3" />
                      Add Upstream
                    </Button>
                  </div>
                  {sp.upstreams.length > 0 && (
                    <div className="space-y-2">
                      {sp.upstreams.map((upstream, upIndex) => {
                        const testKey = `${spIndex}-${upIndex}`;
                        const result = testResults[testKey];
                        return (
                          <div key={upIndex}>
                            <div className="flex items-center gap-2">
                              <Input
                                type="text"
                                value={upstream.server}
                                onChange={(e) =>
                                  updateStreamUpstream(spIndex, upIndex, "server", e.target.value)
                                }
                                placeholder="Server"
                                className="text-xs flex-1"
                              />
                              <Input
                                type="number"
                                value={upstream.port}
                                onChange={(e) =>
                                  updateStreamUpstream(spIndex, upIndex, "port", Number(e.target.value))
                                }
                                placeholder="Port"
                                className="text-xs w-24"
                              />
                              <Input
                                type="number"
                                value={upstream.weight}
                                onChange={(e) =>
                                  updateStreamUpstream(spIndex, upIndex, "weight", Number(e.target.value))
                                }
                                placeholder="Weight"
                                className="text-xs w-20"
                                min={1}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                type="button"
                                disabled={!upstream.server || !upstream.port || !!result?.loading}
                                onClick={() => testUpstream(spIndex, upIndex, upstream.server, upstream.port)}
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
                                onClick={() => removeStreamUpstream(spIndex, upIndex)}
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      <div>
        <Label className="mb-1">Client Max Body Size</Label>
        <Input
          type="text"
          value={clientMaxBodySize}
          onChange={(e) => setClientMaxBodySize(e.target.value)}
          name="clientMaxBodySize"
          placeholder="1m"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Maximum allowed size of the client request body (e.g., 1m, 10m, 100m)
        </p>
      </div>

      <div>
        <Label className="mb-1">Webhook URL</Label>
        <Input
          type="text"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://example.com/webhook"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Optional webhook to notify when configuration changes
        </p>
      </div>

      <div>
        <Label className="mb-1">Advanced Nginx Directives</Label>
        <Textarea
          value={advancedNginx}
          onChange={(e) => setAdvancedNginx(e.target.value)}
          rows={12}
          placeholder={"proxy_buffer_size 128k;\nproxy_buffers 4 256k;"}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Optional advanced configuration for custom Nginx directives
        </p>
      </div>

      <div>
        <Label className="mb-1">Custom prelude (before the server block)</Label>
        <Textarea
          value={customPrelude}
          onChange={(e) => setCustomPrelude(e.target.value)}
          rows={8}
          placeholder={"map $http_upgrade $connection_upgrade {\n    default upgrade;\n    '' close;\n}"}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Raw nginx emitted before this host&apos;s <code>server {"{}"}</code> block, for
          directives that cannot live inside it (<code>map</code>, <code>upstream</code>,{" "}
          <code>geo</code>). Filled in automatically when a hand edit to the config file puts
          unrecognised content there.
        </p>
      </div>
    </div>
  );
}
