"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AdminJob = {
  id: string;
  type: string;
  status: string;
  createdAt: number;
};

type AdminDashboard = {
  status: "ready";
  quotas: {
    usageReported: false;
    features: readonly {
      featureId: string;
      allowed: boolean;
      limits: Readonly<Record<string, number>>;
    }[];
  };
  jobs: {
    counts: Readonly<Record<string, number>>;
    recent: readonly AdminJob[];
  };
  notifications: {
    scope: "current-member";
    count: number;
  };
};

type DashboardState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; dashboard: AdminDashboard };

const JOB_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: "En attente",
  running: "En cours",
  succeeded: "Terminé",
  failed: "En échec",
  cancelled: "Annulé",
});

export function AdminDashboardView({
  loadDashboard,
}: {
  loadDashboard: () => Promise<AdminDashboard>;
}) {
  const [state, setState] = useState<DashboardState>({ status: "loading" });
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    setState({ status: "loading" });
    try {
      const dashboard = await loadDashboard();
      if (requestId.current === currentRequestId) setState({ status: "ready", dashboard });
    } catch {
      if (requestId.current === currentRequestId) setState({ status: "error" });
    }
  }, [loadDashboard]);

  useEffect(() => {
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh]);

  return (
    <section
      aria-busy={state.status === "loading"}
      aria-labelledby="admin-dashboard-title"
      className="ux-dashboard"
    >
      <header className="ux-page-heading">
        <h1 id="admin-dashboard-title">Administration</h1>
        <p>État local de votre organisation, de ses quotas et de ses tâches.</p>
      </header>
      {state.status === "loading" ? (
        <p aria-live="polite" role="status">Chargement du tableau de bord…</p>
      ) : null}
      {state.status === "error" ? (
        <div role="alert">
          <p>Le tableau de bord est indisponible. Réessayez.</p>
          <button className="ux-button" onClick={() => void refresh()} type="button">
            Réessayer
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <>
          <section aria-labelledby="admin-quotas-title">
            <h2 id="admin-quotas-title">Quotas et fonctionnalités</h2>
            <p>Les limites sont affichées ; la consommation n’est pas disponible.</p>
            <ul className="ux-metric-grid">
              {state.dashboard.quotas.features.map(feature => (
                <li className="ux-card" key={feature.featureId}>
                  <h3>{feature.featureId}</h3>
                  <p>{feature.allowed ? "Disponible" : "Non disponible"}</p>
                  {Object.entries(feature.limits).length > 0 ? (
                    <ul>
                      {Object.entries(feature.limits).map(([quotaId, limit]) => (
                        <li key={quotaId}>{quotaId} : {limit}</li>
                      ))}
                    </ul>
                  ) : <p>Aucune limite déclarée.</p>}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="admin-jobs-title">
            <h2 id="admin-jobs-title">Tâches</h2>
            <ul aria-label="État des tâches" className="ux-metric-grid">
              {Object.entries(state.dashboard.jobs.counts).map(([status, count]) => (
                <li className="ux-card" key={status}>
                  <h3>{JOB_STATUS_LABELS[status] ?? status}</h3>
                  <p>{count}</p>
                </li>
              ))}
            </ul>
            {state.dashboard.jobs.recent.length === 0 ? (
              <p className="ux-empty-state">Aucune tâche récente.</p>
            ) : (
              <table>
                <caption>Jusqu’aux 50 tâches les plus récentes</caption>
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">État</th>
                    <th scope="col">Créée le</th>
                  </tr>
                </thead>
                <tbody>
                  {state.dashboard.jobs.recent.map(job => (
                    <tr key={job.id}>
                      <td>{job.type}</td>
                      <td>{JOB_STATUS_LABELS[job.status] ?? job.status}</td>
                      <td>{new Date(job.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section aria-labelledby="admin-notifications-title">
            <h2 id="admin-notifications-title">Notifications</h2>
            <p>Vos notifications : {state.dashboard.notifications.count}</p>
          </section>
        </>
      ) : null}
    </section>
  );
}
