/**
 * The top bar's "More" menu (stage 8 declutter): the controls a trainee needs now and then (the ground rule, the
 * trust center, the companion, pausing motion) behind one button, so the bar holds only what the moment needs. A
 * disclosure button and a list of the same buttons and links, keyboard-operable: Escape or a click elsewhere closes
 * it, and choosing an item closes it.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface MoreItem {
  readonly id: string;
  readonly label: ReactNode;
  /** A link target, or an action. */
  readonly href?: string;
  readonly onSelect?: () => void;
  /** For a toggle: whether it is on. */
  readonly pressed?: boolean;
}

export function MoreMenu({ items }: { readonly items: readonly MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Closing from inside the menu (Escape, or choosing an item) puts focus back on the More button, never on the page.
  const closeToButton = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root.current !== null && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div className="more-menu" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="btn-secondary-sm"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        More
      </button>
      {open ? (
        <ul id={menuId} className="more-list">
          {items.map((item) => (
            <li key={item.id}>
              {item.href !== undefined ? (
                <a className="more-item" href={item.href}>
                  {item.label}
                </a>
              ) : (
                <button
                  type="button"
                  className="more-item"
                  aria-pressed={item.pressed}
                  onClick={() => {
                    closeToButton();
                    item.onSelect?.();
                  }}
                >
                  {item.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
