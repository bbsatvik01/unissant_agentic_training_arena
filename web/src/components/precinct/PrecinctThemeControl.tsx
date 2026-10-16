import { useId } from "react";

export type PrecinctTheme = "office" | "studio";

const THEMES = [
  { value: "office", label: "Office (original)", description: "Warm paper, forest green, a calm working day." },
  { value: "studio", label: "Studio", description: "Charcoal surfaces, crisp type, a quieter interface." },
] as const;

/** Presentation-only preference. The route owns its lifetime; no browser persistence or world events. */
export function PrecinctThemeControl({ value, onChange }: {
  readonly value: PrecinctTheme;
  readonly onChange: (theme: PrecinctTheme) => void;
}) {
  const id = useId();
  return <fieldset className="precinct-theme-picker" aria-describedby={`${id}-note`}>
    <legend>Interface theme</legend>
    <div className="precinct-theme-options">
      {THEMES.map((theme) => <label key={theme.value} className="precinct-theme-option" data-selected={value === theme.value}>
        <span className="precinct-theme-swatch" data-preview={theme.value} aria-hidden="true"><span /><span /><span /></span>
        <span className="precinct-theme-copy"><strong>{theme.label}</strong><small id={`${id}-${theme.value}`}>{theme.description}</small></span>
        <input type="radio" name={`${id}-theme`} value={theme.value} checked={value === theme.value} aria-label={theme.label} aria-describedby={`${id}-${theme.value}`} onChange={() => { onChange(theme.value); }} />
      </label>)}
    </div>
    <p id={`${id}-note`}>Applies throughout this precinct visit. Reloading restores Office.</p>
  </fieldset>;
}
