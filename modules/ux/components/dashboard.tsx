export type DashboardMetric = {
  id: string;
  label: string;
  value: string;
  description?: string;
};

type DashboardProps = {
  title: string;
  description: string;
  metrics: readonly DashboardMetric[];
};

export function Dashboard({ title, description, metrics }: DashboardProps) {
  return (
    <section aria-labelledby="dashboard-title" className="ux-dashboard">
      <header className="ux-page-heading">
        <h1 id="dashboard-title">{title}</h1>
        <p>{description}</p>
      </header>
      {metrics.length === 0 ? (
        <p className="ux-empty-state">Aucune donnée à afficher pour le moment.</p>
      ) : (
        <ul aria-label="Indicateurs" className="ux-metric-grid">
          {metrics.map(metric => (
            <li className="ux-card" key={metric.id}>
              <h2>{metric.label}</h2>
              <p className="ux-metric-value">{metric.value}</p>
              {metric.description ? <p>{metric.description}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
