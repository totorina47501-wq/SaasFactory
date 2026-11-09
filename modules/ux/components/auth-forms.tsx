"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import { UX_ROUTES } from "../routes";
import type { AuthActionState, AuthFormAction } from "../types";

const initialState: AuthActionState = { status: "idle", message: "" };

function Feedback({ state }: { state: AuthActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className={`ux-form-feedback ux-form-feedback-${state.status}`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  return (
    <button className="ux-button" type="submit">
      <span className="ux-pending-label" aria-live="polite">
        {pendingLabel}
      </span>
      <span className="ux-submit-label">{label}</span>
    </button>
  );
}

function FormFrame({
  children,
  description,
  title,
  action,
  state,
  pending,
  submitLabel,
  pendingLabel,
}: {
  children: ReactNode;
  description: string;
  title: string;
  action: (formData: FormData) => void;
  state: AuthActionState;
  pending: boolean;
  submitLabel: string;
  pendingLabel: string;
}) {
  return (
    <section aria-labelledby="auth-title" className="ux-auth-panel">
      <h1 id="auth-title">{title}</h1>
      <p>{description}</p>
      <Feedback state={state} />
      <form action={action} aria-busy={pending}>
        <fieldset disabled={pending}>
          <legend className="ux-visually-hidden">{title}</legend>
          {children}
          <SubmitButton label={submitLabel} pendingLabel={pending ? pendingLabel : ""} />
        </fieldset>
      </form>
    </section>
  );
}

export function LoginForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <FormFrame
      action={formAction}
      description="Connectez-vous avec votre compte local."
      pending={pending}
      pendingLabel="Connexion en cours…"
      state={state}
      submitLabel="Se connecter"
      title="Connexion"
    >
      <label htmlFor="login-email">Adresse e-mail</label>
      <input autoComplete="email" id="login-email" name="email" required type="email" />
      <label htmlFor="login-password">Mot de passe</label>
      <input
        autoComplete="current-password"
        id="login-password"
        name="password"
        required
        type="password"
      />
      <a href={UX_ROUTES.resetPassword}>Mot de passe oublié ?</a>
    </FormFrame>
  );
}

export function SignupForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <FormFrame
      action={formAction}
      description="Créez un compte sur cette installation."
      pending={pending}
      pendingLabel="Création du compte…"
      state={state}
      submitLabel="Créer un compte"
      title="Inscription"
    >
      <label htmlFor="signup-email">Adresse e-mail</label>
      <input autoComplete="email" id="signup-email" name="email" required type="email" />
      <label htmlFor="signup-password">Mot de passe (12 caractères minimum)</label>
      <input
        autoComplete="new-password"
        id="signup-password"
        minLength={12}
        name="password"
        required
        type="password"
      />
      <a href={UX_ROUTES.login}>Déjà inscrit·e ? Se connecter</a>
    </FormFrame>
  );
}

export function PasswordResetRequestForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <FormFrame
      action={formAction}
      description="Si un compte correspond, les instructions seront transmises au canal local configuré."
      pending={pending}
      pendingLabel="Demande en cours…"
      state={state}
      submitLabel="Demander la réinitialisation"
      title="Réinitialiser le mot de passe"
    >
      <label htmlFor="reset-email">Adresse e-mail</label>
      <input autoComplete="email" id="reset-email" name="email" required type="email" />
      <a href={UX_ROUTES.login}>Retour à la connexion</a>
    </FormFrame>
  );
}

export function PasswordResetCompleteForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <FormFrame
      action={formAction}
      description="Saisissez le jeton reçu par le canal local et choisissez un nouveau mot de passe."
      pending={pending}
      pendingLabel="Mise à jour en cours…"
      state={state}
      submitLabel="Enregistrer le mot de passe"
      title="Choisir un nouveau mot de passe"
    >
      <label htmlFor="reset-token">Jeton de réinitialisation</label>
      <input autoComplete="one-time-code" id="reset-token" name="token" required />
      <label htmlFor="reset-new-password">Nouveau mot de passe (12 caractères minimum)</label>
      <input
        autoComplete="new-password"
        id="reset-new-password"
        minLength={12}
        name="newPassword"
        required
        type="password"
      />
    </FormFrame>
  );
}

export function LogoutForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <div className="ux-logout">
      <Feedback state={state} />
      <form action={formAction} aria-busy={pending}>
        <button className="ux-button ux-button-secondary" disabled={pending} type="submit">
          {pending ? "Déconnexion en cours…" : "Se déconnecter"}
        </button>
      </form>
    </div>
  );
}
