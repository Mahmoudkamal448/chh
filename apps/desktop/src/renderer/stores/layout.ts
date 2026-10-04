/** Split-pane layout tree for a terminal tab. Pure functions, unit-tested. */

export type SplitDir = 'row' | 'column';

export type LayoutNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; id: string; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  splitId: string;
  dir: SplitDir;
  /** Divider position within the parent rect (fractions of the whole tab). */
  rect: Rect;
  parent: Rect;
}

export const MIN_RATIO = 0.1;

export function paneIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : [...paneIds(node.a), ...paneIds(node.b)];
}

/** Replaces the leaf `paneId` with a split of [old, new]. */
export function splitPane(node: LayoutNode, paneId: string, newPaneId: string, dir: SplitDir, splitId: string): LayoutNode {
  if (node.type === 'pane') {
    return node.paneId === paneId ? { type: 'split', id: splitId, dir, ratio: 0.5, a: node, b: { type: 'pane', paneId: newPaneId } } : node;
  }
  return { ...node, a: splitPane(node.a, paneId, newPaneId, dir, splitId), b: splitPane(node.b, paneId, newPaneId, dir, splitId) };
}

/** Removes a leaf; its sibling takes the parent's place. Returns null if the tree becomes empty. */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'pane') return node.paneId === paneId ? null : node;
  const a = removePane(node.a, paneId);
  const b = removePane(node.b, paneId);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === 'pane') return node;
  if (node.id === splitId) return { ...node, ratio: Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio)) };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

/** Pane rectangles (fractions 0..1 of the tab area) and the dividers between them. */
export function layoutRects(node: LayoutNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): { panes: Map<string, Rect>; dividers: Divider[] } {
  const panes = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const walk = (n: LayoutNode, r: Rect) => {
    if (n.type === 'pane') {
      panes.set(n.paneId, r);
      return;
    }
    if (n.dir === 'row') {
      const w1 = r.w * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: w1, h: r.h });
      walk(n.b, { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h });
      dividers.push({ splitId: n.id, dir: 'row', rect: { x: r.x + w1, y: r.y, w: 0, h: r.h }, parent: r });
    } else {
      const h1 = r.h * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: h1 });
      walk(n.b, { x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 });
      dividers.push({ splitId: n.id, dir: 'column', rect: { x: r.x, y: r.y + h1, w: r.w, h: 0 }, parent: r });
    }
  };
  walk(node, rect);
  return { panes, dividers };
}
