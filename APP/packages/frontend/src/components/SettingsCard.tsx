import type { ReactNode } from "react";

export type SettingsStatusTone = "ok" | "warn" | "off" | "pending";

export interface SettingsStatus {
  readonly label: string;
  readonly tone: SettingsStatusTone;
}

export interface SettingsCardProps {
  readonly id: string;
  readonly index: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: ReactNode;
  readonly status?: SettingsStatus;
  readonly children: ReactNode;
}

/** One integration on the Ajustes page: what it is, whether it is ready, and its controls. */
export function SettingsCard({ id, index, eyebrow, title, description, status, children }: SettingsCardProps) {
  return (
    <section id={id} className="settings-card" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header className="settings-card-header">
        <div className="settings-card-heading">
          <p className="settings-card-eyebrow"><span aria-hidden="true">{index}</span>{eyebrow}</p>
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="settings-card-description">{description}</p>
        </div>
        {status !== undefined && <p className={`settings-status settings-status--${status.tone}`}><span>{status.label}</span></p>}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}
