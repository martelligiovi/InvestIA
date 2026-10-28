import type { ReactNode } from "react";
import flower from "../assets/folk-flower.svg";
import { AsciiArt } from "./AsciiArt";

export interface AppShellProps {
  readonly children: ReactNode;
  readonly quiet?: boolean;
  readonly home?: boolean;
  readonly create?: boolean;
  readonly showNewInvestigationLink?: boolean;
  readonly showSettingsLink?: boolean;
}

export function AppShell({ children, quiet = false, home = false, create = false, showNewInvestigationLink = true, showSettingsLink = true }: AppShellProps) {
  return (
    <div className={`application-shell${quiet ? " application-shell--quiet" : ""}${home ? " application-shell--home" : ""}${create ? " application-shell--create" : ""}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Saltar al contenido
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <a className="brand" href="#/" aria-label="InvestIA, inicio">
            <img src={flower} alt="" className="brand-flower" />
            <span className="brand-name">Invest<span>IA</span></span>
          </a>
          <nav className="site-nav" aria-label="Navegación principal">
            {!home && (
              <a className="home-link" href="#/">
                <span aria-hidden="true">←</span>
                <span>{create ? "Volver" : "Inicio"}</span>
              </a>
            )}
            {showSettingsLink && <a className="settings-link" href="#/ajustes">Ajustes de IA</a>}
            {showNewInvestigationLink && (
              <a className="new-investigation-link" href="#/nueva">Nueva investigación <span aria-hidden="true">↗</span></a>
            )}
          </nav>
        </div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {children}
      </main>
      {!quiet && (
        <footer className="site-footer">
          <AsciiArt motif="band" className="site-footer-band" />
          <div className="site-footer-inner">
            <span>INVESTIA · CUADERNO DE EVIDENCIA</span>
            <span>DATOS PÚBLICOS · DECISIONES EXPLÍCITAS</span>
          </div>
        </footer>
      )}
    </div>
  );
}
