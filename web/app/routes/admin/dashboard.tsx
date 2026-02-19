import { useState, useEffect, useRef } from "react";
import type { Route } from "./+types/dashboard";
import { db } from "~/lib/db/connection";
import { hosts, hostGroups, healthChecks, auditLog, users } from "~/lib/db/schema";
import { sql, desc } from "drizzle-orm";
import { Card, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  Globe,
  Power,
  PowerOff,
  FolderOpen,
  Server,
  CircleCheck,
  CircleX,
  Activity,
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
  Wifi,
  Gauge,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { SystemStats } from "~/lib/system/stats";
import { PageHeader } from "~/components/PageHeader";
import { AnimatedCounter } from "~/components/AnimatedCounter";
import {
  AreaChart,
  Area,
  RadialBarChart,
  RadialBar,
  ResponsiveContainer,
  Tooltip,
  Cell,
  PolarAngleAxis,
} from "recharts";

export function meta() {
  return [{ title: "Dashboard — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  const allHosts = db.select().from(hosts).all();
  const groupCount = db.select({ count: sql<number>`count(*)` }).from(hostGroups).get();

  const totalHosts = allHosts.length;
  const enabledHosts = allHosts.filter((h) => h.enabled).length;
  const disabledHosts = totalHosts - enabledHosts;

  // Health checks: latest per upstream
  const latestHealth = db
    .select()
    .from(healthChecks)
    .orderBy(desc(healthChecks.checkedAt))
    .limit(500)
    .all();

  const latestByUpstream = new Map<
    string,
    { hostId: number | null; hostType: string; upstream: string; status: string; responseMs: number | null; checkedAt: Date | null }
  >();
  for (const check of latestHealth) {
    const key = `${check.hostType}-${check.hostId}-${check.upstream}`;
    if (!latestByUpstream.has(key)) {
      latestByUpstream.set(key, {
        hostId: check.hostId,
        hostType: check.hostType,
        upstream: check.upstream,
        status: check.status,
        responseMs: check.responseMs,
        checkedAt: check.checkedAt,
      });
    }
  }

  const allChecks = [...latestByUpstream.values()];
  const upCount = allChecks.filter((c) => c.status === "up").length;
  const downCount = allChecks.filter((c) => c.status === "down").length;
  const downUpstreams = allChecks.filter((c) => c.status === "down");

  // Build hostId -> domains map for display
  const hostDomains = new Map<number, string[]>();
  for (const h of allHosts) {
    hostDomains.set(h.id, (h.domains as string[]) ?? []);
  }

  // Recent audit activity
  const recentAudit = db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(10)
    .all();

  // User map for audit display
  const allUsers = db.select({ id: users.id, email: users.email }).from(users).all();
  const userMap = new Map(allUsers.map((u) => [u.id, u.email]));

  return {
    totalHosts,
    enabledHosts,
    disabledHosts,
    groups: groupCount?.count ?? 0,
    totalUpstreams: allChecks.length,
    upstreamsUp: upCount,
    upstreamsDown: downCount,
    downUpstreams: downUpstreams.map((d) => ({
      ...d,
      domains: d.hostId ? hostDomains.get(d.hostId) ?? [] : [],
      checkedAt: d.checkedAt?.toISOString() ?? null,
    })),
    recentAudit: recentAudit.map((a) => ({
      id: a.id,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      userEmail: a.userId ? userMap.get(a.userId) ?? null : null,
      createdAt: a.createdAt?.toISOString() ?? null,
    })),
  };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const d = loaderData;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="System overview and health monitoring"
        titleClassName="gradient-text"
      />

      {/* System Stats (live) */}
      <SystemStatsSection />

      {/* Host stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-stagger">
        <HostStatCard
          label="Total Hosts"
          value={d.totalHosts}
          icon={<Globe className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-blue"
        />
        <HostStatCard
          label="Enabled"
          value={d.enabledHosts}
          icon={<Power className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-green"
        />
        <HostStatCard
          label="Disabled"
          value={d.disabledHosts}
          icon={<PowerOff className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-red"
        />
        <HostStatCard
          label="Groups"
          value={d.groups}
          icon={<FolderOpen className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-purple"
        />
      </div>

      {/* Upstream stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 animate-stagger">
        <HostStatCard
          label="Total Upstreams"
          value={d.totalUpstreams}
          icon={<Server className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-blue"
        />
        <HostStatCard
          label="Upstreams Up"
          value={d.upstreamsUp}
          icon={<CircleCheck className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-green"
        />
        <HostStatCard
          label="Upstreams Down"
          value={d.upstreamsDown}
          icon={<CircleX className="h-5 w-5 text-white" />}
          iconGradient="icon-gradient-red"
        />
      </div>

      {/* Unhealthy Upstreams */}
      <Card glass>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <CircleX className="h-5 w-5 text-destructive" />
            <h2 className="text-lg font-medium">Unhealthy Upstreams</h2>
          </div>
          {d.downUpstreams.length === 0 ? (
            <div className="flex items-center gap-3 text-sm py-6 justify-center">
              <CircleCheck className="h-6 w-6 text-emerald-500" />
              <span className="text-muted-foreground font-medium">All upstreams are healthy</span>
            </div>
          ) : (
            <div className="space-y-2">
              {d.downUpstreams.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-lg border border-destructive/20 bg-destructive/5 border-l-4 border-l-destructive"
                >
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span
                      className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"
                      style={{ animation: "pulse-dot 2s ease-in-out infinite" }}
                    />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                  <div className="flex flex-wrap gap-1 min-w-0">
                    {item.domains.slice(0, 2).map((domain, di) => (
                      <Badge key={di} variant="secondary" className="text-xs">
                        {domain}
                      </Badge>
                    ))}
                    {item.domains.length > 2 && (
                      <Badge variant="outline" className="text-xs">
                        +{item.domains.length - 2}
                      </Badge>
                    )}
                    {item.domains.length === 0 && (
                      <span className="text-muted-foreground text-xs">
                        Host #{item.hostId ?? "?"}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-sm text-foreground">{item.upstream}</span>
                  {item.responseMs != null && (
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {item.responseMs}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card glass>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-medium">Recent Activity</h2>
          </div>
          {d.recentAudit.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No recent activity.</p>
          ) : (
            <div className="relative pl-8">
              <div className="timeline-line" />
              <div className="space-y-4">
                {d.recentAudit.map((entry) => (
                  <div
                    key={entry.id}
                    className="relative flex items-start gap-3"
                  >
                    <div
                      className={cn(
                        "absolute left-[-21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-background",
                        actionDotColor(entry.action)
                      )}
                    />
                    <div className="flex flex-1 items-center gap-2 sm:gap-3 text-sm min-w-0 flex-wrap">
                      <ActionBadge action={entry.action} />
                      <span className="text-muted-foreground">{entry.entity}</span>
                      {entry.entityId && (
                        <span className="text-muted-foreground">#{entry.entityId}</span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">
                        {entry.userEmail && (
                          <span className="mr-2">{entry.userEmail}</span>
                        )}
                        {entry.createdAt ? formatRelativeTime(entry.createdAt) : "-"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

function formatRate(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function actionDotColor(action: string): string {
  switch (action) {
    case "create": return "bg-blue-500";
    case "update": return "bg-amber-500";
    case "delete": return "bg-red-500";
    case "login": return "bg-emerald-500";
    case "logout": return "bg-gray-400";
    case "reload": return "bg-purple-500";
    default: return "bg-gray-400";
  }
}

interface StatsHistoryEntry {
  cpu: number;
  memory: number;
  timestamp: number;
}

const MAX_HISTORY = 60;

function MiniRadialChart({ value, color, size = 60 }: { value: number; color: string; size?: number }) {
  const data = [{ value: Math.min(100, Math.max(0, value)), fill: color }];
  return (
    <ResponsiveContainer width={size} height={size}>
      <RadialBarChart
        cx="50%"
        cy="50%"
        innerRadius="70%"
        outerRadius="100%"
        barSize={6}
        data={data}
        startAngle={90}
        endAngle={-270}
      >
        <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
        <RadialBar
          background={{ fill: "oklch(0.5 0.01 260 / 0.15)" }}
          dataKey="value"
          angleAxisId={0}
          cornerRadius={10}
        />
      </RadialBarChart>
    </ResponsiveContainer>
  );
}

function MiniAreaChart({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const chartData = data.map((v, i) => ({ idx: i, value: v }));
  const gradientId = `area-grad-${color.replace("#", "")}`;
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Tooltip
          contentStyle={{ fontSize: 12, padding: "2px 8px", borderRadius: 6 }}
          formatter={(val: number) => [`${val.toFixed(1)}%`, ""]}
          labelFormatter={() => ""}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SystemStatsSection() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState(false);
  const [history, setHistory] = useState<StatsHistoryEntry[]>([]);
  const historyRef = useRef<StatsHistoryEntry[]>([]);

  useEffect(() => {
    let active = true;

    async function fetchStats() {
      try {
        const res = await fetch("/api/system-stats");
        if (!res.ok) throw new Error("Failed to fetch");
        const data: SystemStats = await res.json();
        if (active) {
          setStats(data);
          setError(false);

          const cpuPct = data.cpu.usage;
          const memPct = data.memory.total > 0 ? (data.memory.used / data.memory.total) * 100 : 0;
          const entry: StatsHistoryEntry = { cpu: cpuPct, memory: memPct, timestamp: Date.now() };
          const next = [...historyRef.current, entry];
          if (next.length > MAX_HISTORY) next.shift();
          historyRef.current = next;
          setHistory(next);
        }
      } catch {
        if (active) setError(true);
      }
    }

    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  if (!stats && !error) {
    return (
      <Card glass>
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">Loading system stats...</p>
        </CardContent>
      </Card>
    );
  }

  if (error && !stats) {
    return (
      <Card glass>
        <CardContent className="p-4">
          <p className="text-sm text-destructive">Unable to load system stats.</p>
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  const cpuPct = stats.cpu.usage;
  const memPct = stats.memory.total > 0 ? (stats.memory.used / stats.memory.total) * 100 : 0;
  const diskPct = stats.disk.total > 0 ? (stats.disk.used / stats.disk.total) * 100 : 0;

  const cpuHistory = history.map((h) => h.cpu);
  const memHistory = history.map((h) => h.memory);

  function chartColor(pct: number): string {
    if (pct > 90) return "#ef4444"; // red-500
    if (pct > 70) return "#f59e0b"; // amber-500
    return "#10b981"; // emerald-500
  }

  return (
    <div className="space-y-4">
      {/* Main stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-stagger">
        {/* CPU */}
        <Card glass>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="h-9 w-9 rounded-lg icon-gradient-blue flex items-center justify-center">
                <Cpu className="h-4.5 w-4.5 text-white" />
              </div>
              <MiniRadialChart value={cpuPct} color={chartColor(cpuPct)} />
            </div>
            <p className="text-sm text-muted-foreground">CPU</p>
            <p className="text-2xl font-bold">
              <AnimatedCounter value={cpuPct} decimals={1} suffix="%" />
            </p>
            {cpuHistory.length >= 2 && (
              <MiniAreaChart data={cpuHistory} color={chartColor(cpuPct)} />
            )}
            <p className="text-xs text-muted-foreground mt-1">{stats.cpu.cores} cores</p>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card glass>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="h-9 w-9 rounded-lg icon-gradient-green flex items-center justify-center">
                <MemoryStick className="h-4.5 w-4.5 text-white" />
              </div>
              <MiniRadialChart value={memPct} color={chartColor(memPct)} />
            </div>
            <p className="text-sm text-muted-foreground">Memory</p>
            <p className="text-2xl font-bold">
              <AnimatedCounter value={memPct} decimals={1} suffix="%" />
            </p>
            {memHistory.length >= 2 && (
              <MiniAreaChart data={memHistory} color={chartColor(memPct)} />
            )}
            <p className="text-xs text-muted-foreground mt-1">
              {formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}
            </p>
          </CardContent>
        </Card>

        {/* Disk */}
        <Card glass>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="h-9 w-9 rounded-lg icon-gradient-amber flex items-center justify-center">
                <HardDrive className="h-4.5 w-4.5 text-white" />
              </div>
              <MiniRadialChart value={diskPct} color={chartColor(diskPct)} />
            </div>
            <p className="text-sm text-muted-foreground">Disk</p>
            <p className="text-2xl font-bold">
              <AnimatedCounter value={diskPct} decimals={1} suffix="%" />
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {formatBytes(stats.disk.used)} / {formatBytes(stats.disk.total)}
            </p>
          </CardContent>
        </Card>

        {/* Uptime */}
        <Card glass>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="h-9 w-9 rounded-lg icon-gradient-purple flex items-center justify-center">
                <Clock className="h-4.5 w-4.5 text-white" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">Uptime</p>
            <p className="text-2xl font-bold">{formatUptime(stats.uptime)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Load: {stats.load.map((l) => l.toFixed(2)).join(", ")}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Nginx & Network row */}
      {(stats.nginx || stats.network) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {stats.nginx && (
            <Card glass>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Nginx Status</p>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Active</span>
                    <span className="font-mono font-medium">{stats.nginx.active}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Requests</span>
                    <span className="font-mono font-medium">{stats.nginx.requests.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Reading</span>
                    <span className="font-mono font-medium">{stats.nginx.reading}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Writing</span>
                    <span className="font-mono font-medium">{stats.nginx.writing}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Waiting</span>
                    <span className="font-mono font-medium">{stats.nginx.waiting}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Handled</span>
                    <span className="font-mono font-medium">{stats.nginx.handled.toLocaleString()}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {stats.network && (
            <Card glass>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Wifi className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Network Throughput</p>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground mb-1">Inbound</p>
                    <p className="text-lg font-bold font-mono">{formatRate(stats.network.bytesIn)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Outbound</p>
                    <p className="text-lg font-bold font-mono">{formatRate(stats.network.bytesOut)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function HostStatCard({
  label,
  value,
  icon,
  iconGradient,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  iconGradient: string;
}) {
  return (
    <Card glass>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center", iconGradient)}>
            {icon}
          </div>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
        <p className="text-3xl font-bold">
          <AnimatedCounter value={value} />
        </p>
      </CardContent>
    </Card>
  );
}

function ActionBadge({ action }: { action: string }) {
  const colors: Record<string, string> = {
    create: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    update: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    delete: "bg-red-500/15 text-red-700 dark:text-red-400",
    login: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    logout: "bg-gray-500/15 text-gray-700 dark:text-gray-400",
    reload: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize shrink-0",
        colors[action] ?? "bg-gray-500/15 text-gray-700 dark:text-gray-400"
      )}
    >
      {action}
    </span>
  );
}
