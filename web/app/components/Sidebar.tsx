import { NavLink, useNavigation } from "react-router";
import pkg from "../../package.json";
import {
  LayoutDashboard,
  Globe,
  Globe2,
  ShieldCheck,
  KeyRound,
  Lock,
  AlertTriangle,
  FileText,
  Code2,
  FileCode2,
  Terminal,
  SquareTerminal,
  ScrollText,
  Users,
  Network,
  Settings,
  Server,
  Menu,
  X,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useUIStore } from "~/store/ui";
import { useThemeStore } from "~/store/theme";
import { cn } from "~/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetClose,
} from "~/components/ui/sheet";
import { useState } from "react";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "Overview",
    items: [
      { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true },
    ],
  },
  {
    title: "Proxy",
    items: [
      { to: "/admin/hosts", label: "Hosts", icon: Globe },
    ],
  },
  {
    title: "Configuration",
    items: [
      { to: "/admin/configs", label: "Config Editor", icon: Code2 },
      { to: "/admin/templates", label: "Templates", icon: FileCode2 },
      { to: "/admin/ssl", label: "SSL Certificates", icon: ShieldCheck },
      { to: "/admin/access-lists", label: "Access Lists", icon: Lock },
      { to: "/admin/error-pages", label: "Error Pages", icon: AlertTriangle },
      { to: "/admin/default-page", label: "Default Page", icon: FileText },
      { to: "/admin/dns", label: "DNS", icon: Globe2 },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { to: "/admin/logs", label: "Logs", icon: Terminal },
      { to: "/admin/terminal", label: "Terminal", icon: SquareTerminal },
      { to: "/admin/audit-log", label: "Audit Log", icon: ScrollText },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/admin/users", label: "Users", icon: Users },
      { to: "/admin/security", label: "Security", icon: KeyRound },
      { to: "/admin/cluster", label: "Cluster", icon: Network },
      { to: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

function NavItemLink({
  item,
  collapsed,
  onClick,
}: {
  item: NavItem;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const Icon = item.icon;
  const navigation = useNavigation();

  // Optimistic highlight: while a navigation is in flight, light up the
  // destination item immediately instead of waiting for the loader.
  const pendingPath = navigation.location?.pathname;
  const isPendingTarget =
    pendingPath != null &&
    (item.end
      ? pendingPath === item.to
      : pendingPath === item.to || pendingPath.startsWith(item.to + "/"));

  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      prefetch="intent"
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150",
          (pendingPath ? isPendingTarget : isActive)
            ? "bg-gradient-to-r from-primary/90 to-primary/70 text-white shadow-sm shadow-primary/25"
            : "text-sidebar-foreground hover:bg-sidebar-accent/80 hover:translate-x-0.5 transition-all duration-150",
          collapsed && "justify-center px-0"
        )
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span
        className={cn(
          "whitespace-nowrap transition-opacity duration-200",
          collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
        )}
      >
        {item.label}
      </span>
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

function SidebarContent({
  collapsed,
  onNavClick,
}: {
  collapsed: boolean;
  onNavClick?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-1 px-3 py-2">
      {navSections.map((section) => (
        <div key={section.title} className="mb-1">
          {collapsed ? (
            <div className="my-2 border-t border-sidebar-border" />
          ) : (
            <h4 className="mb-1 mt-3 px-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-sidebar-muted-foreground/70 whitespace-nowrap overflow-hidden">
              {section.title}
            </h4>
          )}
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <NavItemLink
                key={item.to}
                item={item}
                collapsed={collapsed}
                onClick={onNavClick}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

const themeOrder = ["dark", "light", "system"] as const;
const themeIcons = { light: Sun, dark: Moon, system: Monitor } as const;
const themeLabels = { light: "Light", dark: "Dark", system: "System" } as const;

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const cycleTheme = () => {
    const currentIndex = themeOrder.indexOf(theme);
    const nextTheme = themeOrder[(currentIndex + 1) % themeOrder.length];
    setTheme(nextTheme);
  };

  const Icon = themeIcons[theme];

  const button = (
    <button
      type="button"
      onClick={cycleTheme}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-accent/80",
        collapsed && "justify-center px-0"
      )}
      aria-label={`Theme: ${themeLabels[theme]}. Click to cycle.`}
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span
        className={cn(
          "whitespace-nowrap transition-opacity duration-200",
          collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
        )}
      >
        {themeLabels[theme]}
      </span>
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          Theme: {themeLabels[theme]}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

function BrandSection({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center border-b border-sidebar-border px-4 py-4 h-14 overflow-hidden",
        collapsed ? "justify-center" : "gap-3"
      )}
    >
      <Server className="h-7 w-7 shrink-0 text-emerald-500" />
      <span
        className={cn(
          "text-lg font-bold text-sidebar-foreground whitespace-nowrap transition-opacity duration-200 gradient-text",
          collapsed ? "opacity-0 w-0" : "opacity-100"
        )}
      >
        Nginx Manager
      </span>
    </div>
  );
}

export function Sidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const collapsed = !sidebarOpen;

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "h-screen fixed left-0 top-0 flex flex-col bg-sidebar backdrop-blur-xl border-r border-sidebar-border transition-[width] duration-200 ease-in-out z-30",
          collapsed ? "w-16" : "w-64"
        )}
      >
        <BrandSection collapsed={collapsed} />
        <div className="flex-1 overflow-y-auto">
          <SidebarContent collapsed={collapsed} />
        </div>
        <div className="border-t border-sidebar-border px-3 py-2">
          <ThemeToggle collapsed={collapsed} />
          <VersionBadge collapsed={collapsed} />
        </div>
      </aside>
    </TooltipProvider>
  );
}

function VersionBadge({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "pt-1 pb-0.5 text-[10px] font-medium text-sidebar-muted-foreground/60 whitespace-nowrap overflow-hidden",
        collapsed ? "text-center" : "px-3"
      )}
      title={`Nginx Manager v${pkg.version}`}
    >
      v{pkg.version}
    </div>
  );
}

export function MobileSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md p-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sidebar-primary"
          aria-label="Open sidebar"
        >
          <Menu className="h-6 w-6" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 bg-sidebar p-0 border-sidebar-border [&>button:last-child]:hidden">
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between border-b border-sidebar-border px-4 h-14">
            <div className="flex items-center gap-3">
              <Server className="h-7 w-7 shrink-0 text-emerald-500" />
              <span className="text-lg font-bold text-sidebar-foreground">
                Nginx Manager
              </span>
            </div>
            <SheetClose asChild>
              <button
                type="button"
                className="rounded-md p-1 text-sidebar-muted-foreground hover:text-sidebar-foreground focus:outline-none"
                aria-label="Close sidebar"
              >
                <X className="h-5 w-5" />
              </button>
            </SheetClose>
          </div>
          <div className="flex-1 overflow-y-auto">
            <SidebarContent collapsed={false} onNavClick={() => setOpen(false)} />
          </div>
          <div className="border-t border-sidebar-border px-3 py-2">
            <ThemeToggle collapsed={false} />
            <VersionBadge collapsed={false} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
