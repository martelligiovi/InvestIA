import type { ReactNode } from "react";

export const SETTINGS_INTEGRATIONS = {
  ai: { id: "ajustes-ia", index: "01", eyebrow: "NVIDIA Build", title: "Inteligencia artificial" },
  google: { id: "ajustes-google", index: "02", eyebrow: "Google", title: "Google (GHunt)" },
  facecheck: { id: "ajustes-facecheck", index: "03", eyebrow: "Rostros", title: "FaceCheck.id" },
  decodo: { id: "ajustes-decodo", index: "04", eyebrow: "Scraping", title: "Decodo" },
} as const;

export interface SettingsCardStatus {
  readonly label: string;
  readonly tone: "ok" | "warn" | "off" | "pending";
}

interface SettingsCardProps {
  readonly id: string;
  readonly index: "01" | "02" | "03" | "04";
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly status?: SettingsCardStatus;
  readonly children: ReactNode;
}

export function SettingsCard({ id, index, eyebrow, title, description, status, children }: SettingsCardProps) {
  return (
    <section id={id} className="settings-card" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header className="settings-card-header">
        <div className="settings-card-heading">
          <p className="eyebrow"><span className="settings-number" aria-hidden="true">{index}</span>{eyebrow}</p>
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="settings-card-description">{description}</p>
        </div>
        {status !== undefined && (
          <span className={`settings-status settings-status--${status.tone}`} aria-live="polite">
            <span className="settings-status-label" title={status.label}>{status.label}</span>
          </span>
        )}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

export function SettingsFooter({ secondary, primary }: { readonly secondary?: ReactNode; readonly primary?: ReactNode }) {
  return (
    <footer className="settings-card-footer">
      {secondary !== undefined && <div className="settings-footer-secondary">{secondary}</div>}
      {primary !== undefined && <div className="settings-footer-primary">{primary}</div>}
    </footer>
  );
}
