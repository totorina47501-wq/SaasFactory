export type ThemePreference = "system" | "light" | "dark";
export type ActiveTheme = Exclude<ThemePreference, "system">;

const THEME_CHANGE_EVENT = "saas-factory-theme-change";

export function getActiveTheme(): ActiveTheme {
  const selected = document.documentElement.dataset.theme;
  if (selected === "light" || selected === "dark") return selected;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemePreference(theme: ThemePreference): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
    try {
      window.localStorage.removeItem("saas-factory-theme");
    } catch {
    }
  } else {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("saas-factory-theme", theme);
    } catch {
    }
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

export { THEME_CHANGE_EVENT };
