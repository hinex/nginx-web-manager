import { useMatches, Link } from "react-router";
import { ChevronRight, Home } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

const routeLabels: Record<string, string> = {
  admin: "Home",
  hosts: "Proxy Hosts",
  new: "Add Host",
  edit: "Edit Host",
  configs: "Config Editor",
  templates: "Templates",
  ssl: "SSL Certificates",
  "access-lists": "Access Lists",
  "error-pages": "Error Pages",
  "default-page": "Default Page",
  dns: "DNS Management",
  logs: "Logs",
  terminal: "Terminal",
  "audit-log": "Audit Log",
  users: "Users",
  security: "Security",
  cluster: "Cluster",
  settings: "Settings",
  "change-password": "Change Password",
  setup: "Setup",
};

function Breadcrumbs() {
  const matches = useMatches();
  const crumbs = matches
    .filter((m) => m.pathname !== "/")
    .map((m) => {
      const segments = m.pathname.replace(/\/$/, "").split("/");
      const lastSegment = segments[segments.length - 1];
      const label = routeLabels[lastSegment] || lastSegment;
      return { path: m.pathname, label };
    })
    // Deduplicate consecutive identical paths (layout + page)
    .filter((crumb, i, arr) => i === 0 || crumb.path !== arr[i - 1].path);

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground mb-2">
      <Link
        to="/admin"
        className="flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
      {crumbs.slice(1).map((crumb, i) => (
        <span key={crumb.path} className="flex items-center gap-1.5">
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          {i === crumbs.length - 2 ? (
            <span className="text-foreground font-medium">{crumb.label}</span>
          ) : (
            <Link to={crumb.path} className="hover:text-foreground transition-colors">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  titleClassName,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  titleClassName?: string;
}) {
  return (
    <div className="animate-fade-in-up mb-8">
      <Breadcrumbs />
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className={cn("text-3xl font-bold tracking-tight", titleClassName)}>{title}</h1>
          {description && (
            <p className="text-muted-foreground text-sm mt-1">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
