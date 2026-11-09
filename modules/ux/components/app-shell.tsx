import type { ReactNode } from "react";
import { MobileNavigation } from "./mobile-navigation";
import { ThemeToggle } from "./theme-toggle";
import { UX_ROUTES } from "../routes";

type AppShellProps = {
  children: ReactNode;
  productName: string;
};

export function AppShell({ children, productName }: AppShellProps) {
  return (
    <>
      <a className="ux-skip-link" href="#main-content">
        Aller au contenu principal
      </a>
      <header className="ux-header">
        <a className="ux-brand" href={UX_ROUTES.dashboard}>
          {productName}
        </a>
        <MobileNavigation />
        <ThemeToggle />
      </header>
      <main className="ux-main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
