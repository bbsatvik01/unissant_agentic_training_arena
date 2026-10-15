/**
 * Arrow-key movement between the tower's agents (a roving tab stop): left and right move along a floor, then on to
 * the floor above or below; up and down move to the nearest floor that has an agent, to the one closest in x.
 */
export interface NavItem {
  id: string;
  row: number;
  x: number;
}

export type NavDir = "up" | "down" | "left" | "right";

/** Items in reading order: top floor first, left to right. */
export function readingOrder<T extends NavItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.row - b.row || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function nearestInDirection(items: readonly NavItem[], from: string, dir: NavDir): string | null {
  const order = readingOrder(items);
  const i = order.findIndex((it) => it.id === from);
  const cur = order[i];
  if (!cur) return order[0]?.id ?? null;
  if (dir === "left") return order[i - 1]?.id ?? null;
  if (dir === "right") return order[i + 1]?.id ?? null;
  const rows = [...new Set(order.map((it) => it.row))];
  const k = rows.indexOf(cur.row);
  const target = rows[dir === "up" ? k - 1 : k + 1];
  if (target === undefined) return null;
  let best: NavItem | null = null;
  for (const it of order) {
    if (it.row !== target) continue;
    if (!best || Math.abs(it.x - cur.x) < Math.abs(best.x - cur.x)) best = it;
  }
  return best?.id ?? null;
}
