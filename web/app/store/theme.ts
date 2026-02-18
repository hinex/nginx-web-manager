import { create } from "zustand";

export type Theme = "light" | "dark" | "system";

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

function applyToDOM(resolved: "light" | "dark") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

interface ThemeState {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme:
    typeof window !== "undefined"
      ? (localStorage.getItem("theme") as Theme) || "system"
      : "light",
  resolvedTheme: resolveTheme(
    typeof window !== "undefined"
      ? (localStorage.getItem("theme") as Theme) || "system"
      : "light"
  ),
  setTheme: (theme: Theme) => {
    const resolved = resolveTheme(theme);
    set({ theme, resolvedTheme: resolved });
    if (typeof window !== "undefined") {
      localStorage.setItem("theme", theme);
      applyToDOM(resolved);

      // Persist to server (fire-and-forget, non-blocking)
      fetch("/api/user-theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme }),
      }).catch(() => {
        // Silently ignore server sync errors; localStorage is the primary cache
      });
    }
  },
}));

// On init, fetch theme from server as a non-blocking background sync.
// localStorage is used as the fast cache; the server value is only applied
// if localStorage has no theme set (i.e., new device / cleared storage).
if (typeof window !== "undefined") {
  const localTheme = localStorage.getItem("theme");

  fetch("/api/user-theme")
    .then((res) => {
      if (!res.ok) return null;
      return res.json();
    })
    .then((data) => {
      if (!data || !data.theme) return;
      const serverTheme = data.theme as Theme;

      // Only apply server theme if localStorage doesn't have one
      if (!localTheme) {
        const resolved = resolveTheme(serverTheme);
        useThemeStore.setState({
          theme: serverTheme,
          resolvedTheme: resolved,
        });
        localStorage.setItem("theme", serverTheme);
        applyToDOM(resolved);
      }
    })
    .catch(() => {
      // Server unreachable; continue with localStorage/default
    });
}

// Apply theme to DOM on hydration (inline script sets it before React,
// but hydration may reset the <html> element, removing the class)
if (typeof window !== "undefined") {
  const { resolvedTheme } = useThemeStore.getState();
  applyToDOM(resolvedTheme);
}

// Listen for OS color scheme changes to update "system" theme in real time
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const { theme } = useThemeStore.getState();
      if (theme === "system") {
        const resolved = resolveTheme("system");
        useThemeStore.setState({ resolvedTheme: resolved });
        applyToDOM(resolved);
      }
    });
}
