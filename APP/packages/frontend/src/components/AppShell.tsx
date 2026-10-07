import type { ReactNode } from "react";
import flower from "../assets/folk-flower.svg";
import folkStrip from "../assets/folk-strip.svg";
import mountainCollage from "../assets/mountain-collage.svg";
import homeMountain from "../assets/home-mountain-engraving.svg";
import { AsciiStitchBorder } from "./AsciiStitchBorder";

export interface AppShellProps {
  readonly children: ReactNode;
  readonly quiet?: boolean;
  readonly home?: boolean;
  readonly create?: boolean;
  readonly showNewInvestigationLink?: boolean;
}

export function AppShell({ children, quiet = false, home = false, create = false, showNewInvestigationLink = true }: AppShellProps) {
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
      <div className="ornament-layer" aria-hidden="true">
        <span className="heritage-sun" />
        {quiet ? (
          <div className="workspace-edge-embroidery"><AsciiStitchBorder variant="floral" /></div>
        ) : home || create ? (
          <>
            <div className={create ? "create-edge-embroidery" : "home-edge-embroidery"}><AsciiStitchBorder variant="floral" /></div>
            <img className={create ? "create-mountain" : "home-mountain"} src={homeMountain} alt="" />
          </>
        ) : (
          <>
            <img className="folk-strip" src={folkStrip} alt="" />
            <img className="mountain-collage" src={mountainCollage} alt="" />
          </>
        )}
        <img className="corner-flower" src={flower} alt="" />
      </div>
      <div className="shell-content">
        {!home && <header className="site-header">
          <a className="brand" href="#/" aria-label="InvestIA, inicio">
            <img src={flower} alt="" className="brand-flower" />
            <span className="brand-name">Invest<span>IA</span></span>
          </a>
          <span className="header-rule" aria-hidden="true" />
          <a className="home-link" href="#/">
            <span aria-hidden="true">←</span>
            <span>{create ? "Volver" : "Inicio"}</span>
          </a>
          {showNewInvestigationLink && (
            <a className="new-investigation-link" href="#/nueva">Nueva investigación <span aria-hidden="true">↗</span></a>
          )}
        </header>}
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
        {!home && !create && <footer className="site-footer">
          <span>INVESTIA · CUADERNO DE EVIDENCIA</span>
          <span>DATOS PÚBLICOS · DECISIONES EXPLÍCITAS</span>
        </footer>}
      </div>
    </div>
  );
}
