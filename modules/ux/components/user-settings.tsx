"use client";

import { useActionState, useEffect, useRef } from "react";
import type { AuthActionState, AuthFormAction, UserPreferences } from "../types";

const initialState: AuthActionState = { status: "idle", message: "" };

export function UserSettings({
  initialPreferences,
  saveAction,
}: {
  initialPreferences: UserPreferences;
  saveAction: AuthFormAction;
}) {
  const [state, formAction, pending] = useActionState(saveAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = initialPreferences.density;
    if (initialPreferences.theme === "system") {
      delete root.dataset.theme;
      try {
        window.localStorage.removeItem("saas-factory-theme");
      } catch {
      }
    } else {
      root.dataset.theme = initialPreferences.theme;
      try {
        window.localStorage.setItem("saas-factory-theme", initialPreferences.theme);
      } catch {
      }
    }
  }, [initialPreferences]);

  useEffect(() => {
    if (state.status !== "success" || !formRef.current) return;
    const values = new FormData(formRef.current);
    const theme = values.get("theme");
    const density = values.get("density");
    const root = document.documentElement;
    if (theme === "system") {
      delete root.dataset.theme;
      try {
        window.localStorage.removeItem("saas-factory-theme");
      } catch {
      }
    } else if (theme === "light" || theme === "dark") {
      root.dataset.theme = theme;
      try {
        window.localStorage.setItem("saas-factory-theme", theme);
      } catch {
      }
    }
    if (density === "comfortable" || density === "compact") {
      root.dataset.density = density;
    }
  }, [state]);

  return (
    <section aria-labelledby="settings-title" className="ux-settings-panel">
      <h1 id="settings-title">Paramètres du compte</h1>
      <p>Ces préférences sont chargées et enregistrées pour votre session locale.</p>
      {state.status !== "idle" ? (
        <p
          aria-atomic="true"
          aria-live="polite"
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
      <form action={formAction} aria-busy={pending} ref={formRef}>
        <fieldset disabled={pending}>
          <legend>Préférences d’affichage</legend>
          <label htmlFor="settings-theme">Thème</label>
          <select defaultValue={initialPreferences.theme} id="settings-theme" name="theme">
            <option value="system">Selon le système</option>
            <option value="light">Clair</option>
            <option value="dark">Sombre</option>
          </select>
          <label htmlFor="settings-density">Espacement</label>
          <select defaultValue={initialPreferences.density} id="settings-density" name="density">
            <option value="comfortable">Confortable</option>
            <option value="compact">Compact</option>
          </select>
          <button className="ux-button" type="submit">
            {pending ? "Enregistrement en cours…" : "Enregistrer les préférences"}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
