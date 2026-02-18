import { useEffect } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { Toaster } from "sonner";
import { useThemeStore } from "~/store/theme";
import "./app.css";

function ThemedToaster() {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  return <Toaster theme={resolvedTheme} richColors position="top-right" />;
}

function ThemeSync() {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);
  return null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var d=document.documentElement,t=localStorage.getItem('theme')||'system';if(t==='system'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){d.classList.add('dark');d.style.colorScheme='dark';d.style.backgroundColor='oklch(0.16 0.005 250)';}else{d.style.colorScheme='light';}})();`,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
        <ThemeSync />
        <ThemedToaster />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}
