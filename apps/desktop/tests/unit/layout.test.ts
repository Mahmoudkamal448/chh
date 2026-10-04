import { describe, expect, it } from 'vitest';
import { layoutRects, paneIds, removePane, setRatio, splitPane, type LayoutNode } from '../../src/renderer/stores/layout';

describe('split layout', () => {
  const one: LayoutNode = { type: 'pane', paneId: 'a' };

  it('splits, nests, and computes rectangles', () => {
    const two = splitPane(one, 'a', 'b', 'row', 's1');
    const three = splitPane(two, 'b', 'c', 'column', 's2');
    expect(paneIds(three)).toEqual(['a', 'b', 'c']);
    const { panes, dividers } = layoutRects(three);
    expect(panes.get('a')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes.get('b')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(panes.get('c')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(dividers.map((d) => d.dir).sort()).toEqual(['column', 'row']);
  });

  it('removes panes, promoting the sibling', () => {
    const tree = splitPane(splitPane(one, 'a', 'b', 'row', 's1'), 'b', 'c', 'column', 's2');
    const withoutB = removePane(tree, 'b')!;
    expect(paneIds(withoutB)).toEqual(['a', 'c']);
    expect(layoutRects(withoutB).panes.get('c')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(removePane(one, 'a')).toBeNull();
    expect(removePane(tree, 'zzz')).toBe(tree);
  });

  it('clamps ratios', () => {
    const t = splitPane(one, 'a', 'b', 'row', 's1');
    expect(layoutRects(setRatio(t, 's1', 0.7)).panes.get('a')!.w).toBeCloseTo(0.7);
    expect(layoutRects(setRatio(t, 's1', 5)).panes.get('a')!.w).toBeCloseTo(0.9);
    expect(layoutRects(setRatio(t, 's1', -1)).panes.get('a')!.w).toBeCloseTo(0.1);
  });
});
