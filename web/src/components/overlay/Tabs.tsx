/**
 * Tabs for the room's right column (WAI-ARIA tabs pattern): a tablist of buttons with roving focus (arrow keys,
 * Home, End) and one visible tabpanel.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

export function Tabs({ tabs, value, onChange, label }: { tabs: readonly TabSpec[]; value: string; onChange: (id: string) => void; label: string }) {
  const base = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: KeyboardEvent, index: number) => {
    const next = e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    if (tab === undefined) return;
    onChange(tab.id);
    buttons.current.get(tab.id)?.focus();
  };
  return (
    <div className="panel tabs">
      <div className="tab-list" role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el === null) buttons.current.delete(t.id);
              else buttons.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={value === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={value === t.id ? 0 : -1}
            className="tab"
            data-state={value === t.id ? "active" : "inactive"}
            onClick={() => {
              onChange(t.id);
            }}
            onKeyDown={(e) => {
              move(e, i);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} hidden={value !== t.id} className="panel-body" tabIndex={0}>
          {value === t.id ? t.content : null}
        </div>
      ))}
    </div>
  );
}
