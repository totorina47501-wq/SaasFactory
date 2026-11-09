"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    try {
      const savedTheme = window.localStorage.getItem("saas-factory-theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        document.documentElement.dataset.theme = savedTheme;
        setTheme(savedTheme);
        return;
      }
    } catch {
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      return;
    }
    setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    try {
      window.localStorage.setItem("saas-factory-theme", nextTheme);
    } catch {
      // The current page theme still changes when storage is unavailable.
    }
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
