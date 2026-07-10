import { Outlet, redirect, Link, useFetcher } from "react-router";
import type { Route } from "./+types/layout";
import { getSessionUser } from "~/lib/auth/session.server";
import { Sidebar, MobileSidebar } from "~/components/Sidebar";
import { useUIStore } from "~/store/ui";
import { TooltipProvider } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  PanelLeftClose,
  PanelLeft,
  User,
  KeyRound,
  LogOut,
} from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  if (!user) throw redirect("/login");
  return { user };
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const logoutFetcher = useFetcher();

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen overflow-hidden bg-background">
        <div className="hidden md:block">
          <Sidebar />
        </div>

        <div
          className={`flex flex-1 flex-col overflow-hidden transition-[margin-left] duration-200 ease-in-out ${
            sidebarOpen ? "md:ml-64" : "md:ml-16"
          }`}
        >
          <header className="backdrop-blur-xl bg-background/80 border-b border-border/50 h-14 flex items-center justify-between px-4 sticky top-0 z-20">
            <div className="flex items-center">
              <div className="md:hidden">
                <MobileSidebar />
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                className="hidden md:flex"
              >
                {sidebarOpen ? (
                  <PanelLeftClose className="h-5 w-5" />
                ) : (
                  <PanelLeft className="h-5 w-5" />
                )}
              </Button>
            </div>

            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="gap-2">
                    {loaderData.user.email}
                    <User className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link to="/admin/change-password" className="gap-2">
                      <KeyRound className="h-4 w-4" />
                      Change Password
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      logoutFetcher.submit(null, {
                        method: "post",
                        action: "/logout",
                      })
                    }
                  >
                    <LogOut className="h-4 w-4" />
                    Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto p-4 md:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
