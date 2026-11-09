"use client";

import { useEffect, useState } from "react";
import {
  applyThemePreference,
  getActiveTheme,
  THEME_CHANGE_EVENT,
  type ActiveTheme,
} from "../theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<ActiveTheme>("light");

  useEffect(() => {
    try {
      const savedTheme = window.localStorage.getItem("saas-factory-theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        applyThemePreference(savedTheme);
        setTheme(savedTheme);
      } else {
        setTheme(getActiveTheme());
      }
    } catch {
      setTheme(getActiveTheme());
    }
    const syncTheme = () => setTheme(getActiveTheme());
    window.addEventListener(THEME_CHANGE_EVENT, syncTheme);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, syncTheme);
  }, []);

  function toggleTheme() {
    const nextTheme = getActiveTheme() === "light" ? "dark" : "light";
    applyThemePreference(nextTheme);
    setTheme(nextTheme);
  }

  return (
    <button
      aria-label={`Activer le thème ${theme === "light" ? "sombre" : "clair"}`}
      aria-pressed={theme === "dark"}
      className="ux-theme-toggle"
      onClick={toggleTheme}
      type="button"
    >
      {theme === "light" ? "Thème sombre" : "Thème clair"}
    </button>
  );
}
