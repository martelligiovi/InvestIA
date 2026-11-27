import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AI_MAX_TOKENS_RANGE, type AiReasoningEffort, type AiReportSettings } from "@investia/core";
import { InvestigationApiClient, type AiModelList, type AiSettingsView } from "../api/client";
import { GhuntSettings } from "../components/GhuntSettings";
import { FacecheckSettings } from "../components/FacecheckSettings";
import { DecodoSettings } from "../components/DecodoSettings";
import { SETTINGS_INTEGRATIONS, SettingsCard, SettingsFooter, type SettingsCardStatus } from "../components/SettingsCard";

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

function isGoogleDeepLink(): boolean {
  const [path, query] = window.location.hash.split("?", 2);
  return path === "#/ajustes" && new URLSearchParams(query).get("seccion") === "ghunt";
}

function focusSettingsCard(id: string) {
  const card = document.getElementById(id);
  card?.focus({ preventScroll: true });
  card?.scrollIntoView?.({ block: "start", behavior: "instant" });
}

export function AiSettingsPage() {
  const pinnedDeepLinkRef = useRef<{ active: boolean; expectedScrollY: number }>({ active: false, expectedScrollY: 0 });

  const navigateToCard = useCallback((id: string) => {
    pinnedDeepLinkRef.current.active = false;
    focusSettingsCard(id);
  }, []);

  const alignGoogleDeepLink = useCallback(() => {
    const pinned = pinnedDeepLinkRef.current;
    if (!pinned.active || !isGoogleDeepLink()) {
      pinned.active = false;
      return;
    }
    const focusedCard = document.activeElement;
    if (focusedCard?.id !== SETTINGS_INTEGRATIONS.google.id) {
      pinned.active = false;
      return;
    }
    if (Math.abs(window.scrollY - pinned.expectedScrollY) > 2) {
      pinned.active = false;
      return;
    }
    focusedCard.scrollIntoView?.({ block: "start", behavior: "instant" });
    pinned.expectedScrollY = window.scrollY;
  }, []);

  useEffect(() => {
    const followDeepLink = () => {
      if (!isGoogleDeepLink()) {
        pinnedDeepLinkRef.current.active = false;
        return;
      }
      focusSettingsCard(SETTINGS_INTEGRATIONS.google.id);
      pinnedDeepLinkRef.current = { active: true, expectedScrollY: window.scrollY };
    };
    const releaseOnManualScroll = () => {
      const pinned = pinnedDeepLinkRef.current;
      if (pinned.active && Math.abs(window.scrollY - pinned.expectedScrollY) > 2) {
        pinned.active = false;
      }
    };
    const releaseOnUserScrollIntent = () => {
      pinnedDeepLinkRef.current.active = false;
    };
    followDeepLink();
    window.addEventListener("hashchange", followDeepLink);
    window.addEventListener("scroll", releaseOnManualScroll, { passive: true });
    window.addEventListener("wheel", releaseOnUserScrollIntent, { passive: true });
    window.addEventListener("touchmove", releaseOnUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("hashchange", followDeepLink);
      window.removeEventListener("scroll", releaseOnManualScroll);
      window.removeEventListener("wheel", releaseOnUserScrollIntent);
      window.removeEventListener("touchmove", releaseOnUserScrollIntent);
    };
  }, []);

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <header className="settings-intro">
        <p className="eyebrow">Configuración · Integraciones</p>
        <h1 id="settings-title">Ajustes</h1>
        <p>Configurá en esta instancia las integraciones que usás en tus investigaciones.</p>
      </header>
      <div className="settings-layout">
        <nav className="settings-index" aria-label="Integraciones">
          <ol>
            {Object.values(SETTINGS_INTEGRATIONS).map(({ id, index, title }) => (
              <li key={id}>
                <button type="button" aria-controls={id} onClick={() => navigateToCard(id)}>
                  <span className="settings-number" aria-hidden="true">{index}</span>{title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="settings-cards">
          <AiSettingsContent onLayoutSettled={alignGoogleDeepLink} />
          <GhuntSettings />
          <FacecheckSettings />
          <DecodoSettings />
        </div>
      </div>
    </section>
  );
}

function AiSettingsContent({ onLayoutSettled }: { readonly onLayoutSettled: () => void }) {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [models, setModels] = useState<AiModelList | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [modelsPending, setModelsPending] = useState(true);
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

  const loadModels = useCallback(async (isActive: () => boolean = () => true) => {
    setModelsPending(true);
    setModelsError("");
    try {
      const list = await api.listAiModels();
      if (isActive()) setModels(list);
    } catch (error) {
      if (isActive()) setModelsError(`No se pudo obtener la lista de modelos: ${messageFor(error)}`);
    } finally {
      if (isActive()) setModelsPending(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void loadSettings(() => active);
    void loadModels(() => active);
    return () => { active = false; };
  }, [loadSettings, loadModels]);

  useEffect(() => {
    // Re-align the deep-linked Google card after the first card resolves, unless the user scrolled away.
    onLayoutSettled();
  }, [onLayoutSettled, view, loadError, models, modelsError]);

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

  const status: SettingsCardStatus = pending
    ? { label: "En curso", tone: "pending" }
    : view === null
      ? loadError === "" ? { label: "Cargando", tone: "pending" } : { label: "Error de carga", tone: "warn" }
      : view.apiKeyConfigured
        ? { label: `Configurada${view.apiKeyHint === null ? "" : ` (${view.apiKeyHint})`}`, tone: "ok" }
        : { label: "Sin configurar", tone: "off" };
  const modelOptions = models?.models ?? [];
  const savedModelMissing = !modelOptions.some((option) => option.id === draft?.model);

  return (
    <SettingsCard {...SETTINGS_INTEGRATIONS.ai} status={status}
      description="Configurá NVIDIA Build para redactar informes ejecutivos de perfil a partir de los datos del expediente.">
      {view === null || draft === null ? (
        loadError === "" ? (
          <p className="settings-notice" role="status">Cargando ajustes…</p>
        ) : (
          <>
            <p className="form-error" role="alert">{loadError}</p>
            <button className="primary-action settings-retry" type="button" onClick={() => void loadSettings()}>Intentar de nuevo</button>
          </>
        )
      ) : (
        <form className="settings-form" noValidate onSubmit={(event) => void handleSave(event)}>
          <fieldset className="settings-form settings-fields" disabled={pending}>
            <legend className="visually-hidden">Ajustes de NVIDIA Build</legend>
            <div className="settings-group">
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
            </div>
            <div className="settings-group">
              <div className="form-field">
                <label htmlFor="ai-model">Modelo</label>
                <div className="settings-inline">
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
                  <button className="secondary-action" type="button" disabled={modelsPending} onClick={() => void loadModels()}>
                    {modelsPending ? "Cargando modelos…" : "Recargar modelos"}
                  </button>
                </div>
                <span id="ai-model-hint" className="field-hint" aria-live="polite">
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
                <div className="settings-fields-pair">
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
            </div>
            <p className="settings-privacy">
              Al generar un informe con IA, los datos recopilados del expediente se envían a NVIDIA Build. La síntesis asistida por IA no verifica identidad ni titularidad de cuentas.
            </p>
            {formError !== "" && <p className="form-error" role="alert">{formError}</p>}
            {notice !== "" && <p className="settings-notice" role="status">{notice}</p>}
            <SettingsFooter
              secondary={<>
                <button className="text-button" type="button" onClick={restoreDefaults}>Restaurar valores por defecto</button>
                <button className="text-button" type="button" disabled={!view.apiKeyConfigured} onClick={() => void handleRemoveKey()}>Quitar API key</button>
              </>}
              primary={<button className="primary-action" type="submit" disabled={pending}>{pending ? "Guardando…" : "Guardar ajustes de IA"}</button>}
            />
          </fieldset>
        </form>
      )}
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
