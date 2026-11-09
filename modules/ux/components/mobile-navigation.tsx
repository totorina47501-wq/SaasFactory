"use client";

import { useEffect, useRef, useState } from "react";
import { UX_ROUTES } from "../routes";

const links = [
  ["Tableau de bord", UX_ROUTES.dashboard],
  ["Paramètres", UX_ROUTES.settings],
] as const;

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <nav aria-label="Navigation principale" className="ux-desktop-nav">
        <ul>
          {links.map(([label, href]) => (
            <li key={href}>
              <a href={href}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <button
        aria-controls="ux-mobile-menu"
        aria-expanded={open}
        aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
        className="ux-menu-toggle"
        onClick={() => setOpen((value: boolean) => !value)}
        ref={buttonRef}
        type="button"
      >
        <span aria-hidden="true">{open ? "×" : "☰"}</span>
      </button>
      <nav
        aria-label="Navigation mobile"
        className="ux-mobile-nav"
        hidden={!open}
        id="ux-mobile-menu"
      >
        <ul>
          {links.map(([label, href]) => (
            <li key={href}>
              <a href={href} onClick={() => setOpen(false)}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
