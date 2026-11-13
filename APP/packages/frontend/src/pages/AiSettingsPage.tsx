import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AI_MAX_TOKENS_RANGE, type AiReasoningEffort, type AiReportSettings } from "@investia/core";
import { InvestigationApiClient, type AiModelList, type AiSettingsView } from "../api/client";
import { GhuntSettings } from "../components/GhuntSettings";
import { FacecheckSettings } from "../components/FacecheckSettings";
import { SettingsCard, type SettingsStatus } from "../components/SettingsCard";

const NVIDIA_MODELS_URL = "https://build.nvidia.com/models";

const REASONING_LABELS: Readonly<Record<AiReasoningEffort, string>> = {
  default: "Predeterminado del modelo",
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
};

/** Numeric fields stay as typed text until saving, so partial edits are not coerced. */
interface SettingsDraft {
  readonly model: string;
  readonly reasoningEffort: AiReasoningEffort;
  readonly temperature: string;
  readonly topP: string;
  readonly maxTokens: string;
}

type DraftField = "temperature" | "topP" | "maxTokens";
type FieldErrors = Partial<Record<DraftField, string>>;

function toDraft(settings: AiReportSettings): SettingsDraft {
  return {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    temperature: String(settings.temperature),
    topP: String(settings.topP),
    maxTokens: String(settings.maxTokens),
  };
}

function parseDraft(draft: SettingsDraft): { readonly settings?: AiReportSettings; readonly errors: FieldErrors } {
  const errors: FieldErrors = {};
  const temperature = draft.temperature.trim() === "" ? Number.NaN : Number(draft.temperature);
  const topP = draft.topP.trim() === "" ? Number.NaN : Number(draft.topP);
  const maxTokens = draft.maxTokens.trim() === "" ? Number.NaN : Number(draft.maxTokens);
  if (!(temperature >= 0 && temperature <= 2)) errors.temperature = "Usá un valor entre 0 y 2.";
  if (!(topP > 0 && topP <= 1)) errors.topP = "Usá un valor mayor que 0 y hasta 1.";
  if (!Number.isInteger(maxTokens) || maxTokens < AI_MAX_TOKENS_RANGE.min || maxTokens > AI_MAX_TOKENS_RANGE.max) {
    errors.maxTokens = `Usá un número entero entre ${AI_MAX_TOKENS_RANGE.min} y ${AI_MAX_TOKENS_RANGE.max}.`;
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { settings: { model: draft.model, reasoningEffort: draft.reasoningEffort, temperature, topP, maxTokens }, errors };
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Ocurrió un error inesperado.";
}

const SECTIONS = [
  { id: "ai-settings", label: "Informe con IA" },
  { id: "ghunt-settings", label: "Google (GHunt)" },
  { id: "facecheck-settings", label: "FaceCheck.id" },
] as const;

/** Moves to a section without touching the hash, which the router owns. */
function goToSection(id: string) {
  const section = document.getElementById(id);
  section?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  section?.focus({ preventScroll: true });
}

export function AiSettingsPage() {
  return (
    <div className="settings-page">
      <header className="page-intro settings-intro">
        <p className="kicker">Configuración</p>
        <h1 id="settings-title" className="document-title">Ajustes</h1>
        <p className="document-lead">Conectá las herramientas que usa InvestIA: el modelo que redacta los informes, la cuenta de Google para GHunt y la búsqueda facial de FaceCheck.</p>
      </header>
      <div className="settings-layout">
        <nav className="settings-index" aria-label="Secciones de ajustes">
          <ol>
            {SECTIONS.map((section, index) => (
              <li key={section.id}>
                <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <button type="button" onClick={() => goToSection(section.id)}>{section.label}</button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="settings-sections">
          <AiSettingsContent />
          <GhuntSettings />
          <FacecheckSettings />
        </div>
      </div>
    </div>
  );
}

const AI_DESCRIPTION = "Redacta informes narrativos e hipotéticos a partir de los datos del expediente, con un modelo de NVIDIA Build.";

function AiSettingsContent() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [models, setModels] = useState<AiModelList | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);

  const loadSettings = useCallback(async (isActive: () => boolean = () => true) => {
    setLoadError("");
    try {
      const loaded = await api.getAiSettings();
      if (!isActive()) return;
      setView(loaded);
      setDraft(toDraft(loaded.settings));
    } catch (error) {
      if (isActive()) setLoadError(`No se pudieron cargar los ajustes de IA: ${messageFor(error)}`);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void loadSettings(() => active);
    void api.listAiModels().then(
      (list) => { if (active) setModels(list); },
      (error: unknown) => { if (active) setModelsError(`No se pudo obtener la lista de modelos: ${messageFor(error)}`); },
    );
    return () => { active = false; };
  }, [api, loadSettings]);

  useEffect(() => {
    if (window.location.hash.includes("?seccion=ghunt")) {
      document.getElementById("ghunt-settings")?.scrollIntoView?.({ block: "start" });
    }
  }, [view, loadError]);

  function updateDraft(change: Partial<SettingsDraft>) {
    setDraft((current) => current === null ? current : { ...current, ...change });
    setFieldErrors((errors) => {
      const next = { ...errors };
      for (const key of Object.keys(change)) delete next[key as DraftField];
      return next;
    });
    setFormError("");
    setNotice("");
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null || pending) return;
    const parsed = parseDraft(draft);
    setFieldErrors(parsed.errors);
    if (parsed.settings === undefined) {
      setNotice("");
      setFormError("Revisá los parámetros marcados antes de guardar.");
      return;
    }
    const typedKey = apiKey.trim();
    setPending(true);
    setFormError("");
    setNotice("");
    try {
      const saved = await api.saveAiSettings({ ...(typedKey === "" ? {} : { apiKey: typedKey }), settings: parsed.settings });
      setView(saved);
      setDraft(toDraft(saved.settings));
      setApiKey("");
      setNotice("Ajustes guardados.");
    } catch (error) {
      setFormError(`No se pudieron guardar los ajustes: ${messageFor(error)}`);
    } finally {
      setPending(false);
    }
  }

  async function handleRemoveKey() {
    if (pending) return;
    setPending(true);
    setFormError("");
    setNotice("");
    try {
      setView(await api.removeAiApiKey());
      setNotice("API key quitada.");
    } catch (error) {
      setFormError(`No se pudo quitar la API key: ${messageFor(error)}`);
    } finally {
      setPending(false);
    }
  }

  function restoreDefaults() {
    if (view === null) return;
    setDraft(toDraft(view.defaults));
    setFieldErrors({});
    setFormError("");
    setNotice("Se cargaron los valores por defecto. Guardá para aplicarlos.");
  }

  if (view === null || draft === null) {
    return (
      <SettingsCard id="ai-settings" index="01" eyebrow="NVIDIA Build" title="Informe con IA" description={AI_DESCRIPTION}
        status={loadError === "" ? { label: "Cargando…", tone: "pending" } : { label: "Sin datos", tone: "off" }}>
        {loadError === "" ? (
          <p className="settings-muted" role="status">Cargando ajustes…</p>
        ) : (
          <>
            <p className="form-error" role="alert">{loadError}</p>
            <button className="secondary-action ai-settings-retry" type="button" onClick={() => void loadSettings()}>Intentar de nuevo</button>
          </>
        )}
      </SettingsCard>
    );
  }

  const modelOptions = models?.models ?? [];
  const savedModelMissing = !modelOptions.some((option) => option.id === draft.model);

  const status: SettingsStatus = view.apiKeyConfigured
    ? { label: `Configurada${view.apiKeyHint === null ? "" : ` (${view.apiKeyHint})`}`, tone: "ok" }
    : { label: "Sin configurar", tone: "warn" };

  return (
    <SettingsCard id="ai-settings" index="01" eyebrow="NVIDIA Build" title="Informe con IA" description={AI_DESCRIPTION} status={status}>
      <form className="settings-form ai-settings-form" noValidate onSubmit={(event) => void handleSave(event)}>
        <fieldset className="settings-fieldset" disabled={pending}>
          <legend className="visually-hidden">Ajustes de NVIDIA Build</legend>
          <section className="settings-group" aria-labelledby="ai-settings-key">
            <h3 id="ai-settings-key">Clave de acceso</h3>
            <div className="form-field">
              <label htmlFor="ai-api-key">API key de NVIDIA Build</label>
              <input
                id="ai-api-key"
                name="apiKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={view.apiKeyConfigured ? "Dejala vacía para conservar la actual" : "nvapi-…"}
                value={apiKey}
                aria-describedby="ai-api-key-hint"
                onChange={(event) => { setApiKey(event.currentTarget.value); setFormError(""); setNotice(""); }}
              />
              <span id="ai-api-key-hint" className="field-hint">
                Conseguí una API key gratuita en <a href={NVIDIA_MODELS_URL} target="_blank" rel="noreferrer">build.nvidia.com/models</a>. Se guarda en el servidor y nunca se vuelve a mostrar completa.
              </span>
            </div>
            <div className="settings-row-actions">
              <button className="text-button" type="button" disabled={!view.apiKeyConfigured} onClick={() => void handleRemoveKey()}>Quitar API key</button>
            </div>
          </section>

          <section className="settings-group" aria-labelledby="ai-settings-model">
            <h3 id="ai-settings-model">Modelo y parámetros</h3>
            <div className="form-field">
              <label htmlFor="ai-model">Modelo</label>
              <select
                id="ai-model"
                name="model"
                value={draft.model}
                aria-describedby="ai-model-hint"
                onChange={(event) => updateDraft({ model: event.currentTarget.value })}
              >
                {savedModelMissing && <option value={draft.model}>{draft.model}{models === null ? "" : " (no figura en la lista actual)"}</option>}
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id} title={option.description}>
                    {option.name}{option.reasoning ? " · razonamiento" : ""}
                  </option>
                ))}
              </select>
              <span id="ai-model-hint" className="field-hint">
                {modelsError !== ""
                  ? modelsError
                  : models === null
                    ? "Cargando modelos disponibles…"
                    : models.source === "fallback"
                      ? "No se pudo consultar el catálogo de NVIDIA Build; se muestra una lista de respaldo de modelos de chat gratuitos."
                      : "Modelos de chat Free Endpoint de build.nvidia.com."}
              </span>
            </div>
            <details className="ai-settings-advanced">
              <summary>Parámetros avanzados</summary>
              <div className="ai-settings-grid">
                <div className="form-field">
                  <label htmlFor="ai-reasoning">Esfuerzo de razonamiento</label>
                  <select
                    id="ai-reasoning"
                    name="reasoningEffort"
                    value={draft.reasoningEffort}
                    onChange={(event) => updateDraft({ reasoningEffort: event.currentTarget.value as AiReasoningEffort })}
                  >
                    {(Object.keys(REASONING_LABELS) as AiReasoningEffort[]).map((effort) => (
                      <option key={effort} value={effort}>{REASONING_LABELS[effort]}</option>
                    ))}
                  </select>
                </div>
                <NumberField id="ai-temperature" label="Temperatura" value={draft.temperature} error={fieldErrors.temperature} min={0} max={2} step={0.05} onChange={(temperature) => updateDraft({ temperature })} />
                <NumberField id="ai-top-p" label="Top P" value={draft.topP} error={fieldErrors.topP} min={0.01} max={1} step={0.01} onChange={(topP) => updateDraft({ topP })} />
                <NumberField id="ai-max-tokens" label="Máximo de tokens" value={draft.maxTokens} error={fieldErrors.maxTokens} min={AI_MAX_TOKENS_RANGE.min} max={AI_MAX_TOKENS_RANGE.max} step={1} onChange={(maxTokens) => updateDraft({ maxTokens })} />
              </div>
              <p className="field-hint">“Predeterminado del modelo” no envía el esfuerzo de razonamiento. Si elegís otro valor y el modelo no lo admite, NVIDIA Build rechaza el pedido y vas a ver el error al generar el informe.</p>
            </details>
          </section>

          <p className="settings-privacy">
            Al generar un informe con IA, los datos recopilados del expediente se envían a NVIDIA Build. El informe es hipotético y no confirma identidades.
          </p>
          {formError !== "" && <p className="form-error" role="alert">{formError}</p>}
          {notice !== "" && <p className="settings-notice" role="status">{notice}</p>}
        </fieldset>
        <div className="settings-card-footer">
          <button className="text-button" type="button" disabled={pending} onClick={restoreDefaults}>Restaurar valores por defecto</button>
          <button className="primary-action" type="submit" disabled={pending}>{pending ? "Guardando…" : "Guardar ajustes de IA"}</button>
        </div>
      </form>
    </SettingsCard>
  );
}

interface NumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: string) => void;
}

function NumberField({ id, label, value, error, min, max, step, onChange }: NumberFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error !== undefined && <span id={errorId} className="field-error">{error}</span>}
    </div>
  );
}
