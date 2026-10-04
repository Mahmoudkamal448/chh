import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { layoutRects } from '../../stores/layout';
import { useTabs, type TerminalTab } from '../../stores/tabs-store';
import { SidePanel } from './SidePanel';
import { TerminalView } from './TerminalView';

const pct = (n: number) => `${n * 100}%`;

/**
 * Renders a tab's panes as a flat list positioned from the layout tree, so splitting or closing a
 * pane never remounts the others (their scrollback and sessions survive).
 */
export function TerminalTabView({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const panes = useTabs((s) => s.panes);
  const resize = useTabs((s) => s.resize);
  const areaRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { panes: rects, dividers } = useMemo(() => layoutRects(tab.root), [tab.root]);
  const split = rects.size > 1;

  const startDrag = (splitId: string, dir: 'row' | 'column', parent: { x: number; y: number; w: number; h: number }) => (e: React.PointerEvent) => {
    e.preventDefault();
    const area = areaRef.current!.getBoundingClientRect();
    setDragging(splitId);
    const move = (ev: PointerEvent) => {
      const ratio =
        dir === 'row'
          ? ((ev.clientX - area.left) / area.width - parent.x) / parent.w
          : ((ev.clientY - area.top) / area.height - parent.y) / parent.h;
      resize(tab.id, splitId, ratio);
    };
    const up = () => {
      setDragging(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The side panel is toggled by a global command targeting the visible tab.
  useEffect(() => {
    if (!visible) return;
    const toggle = () => setPanelOpen((o) => !o);
    window.addEventListener('chh:toggle-panel', toggle);
    return () => window.removeEventListener('chh:toggle-panel', toggle);
  }, [visible]);

  return (
    <div className="flex h-full min-h-0">
      <div ref={areaRef} className={cn('relative min-w-0 flex-1', dragging && 'select-none')} data-testid="terminal-area">
        {[...rects].map(([paneId, r]) => {
          const pane = panes[paneId];
          if (!pane) return null;
          return (
            <div key={paneId} className="absolute" style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}>
              <TerminalView pane={pane} visible={visible} focused={tab.focusedPaneId === paneId} split={split} />
            </div>
          );
        })}
        {dividers.map((d) => (
          <div
            key={d.splitId}
            role="separator"
            aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
            onPointerDown={startDrag(d.splitId, d.dir, d.parent)}
            className={cn(
              'absolute z-10 bg-border hover:bg-accent',
              d.dir === 'row' ? '-ml-[2px] w-[4px] cursor-col-resize' : '-mt-[2px] h-[4px] cursor-row-resize',
              dragging === d.splitId && 'bg-accent',
            )}
            style={
              d.dir === 'row'
                ? { left: pct(d.rect.x), top: pct(d.rect.y), height: pct(d.rect.h) }
                : { left: pct(d.rect.x), top: pct(d.rect.y), width: pct(d.rect.w) }
            }
          />
        ))}
      </div>
      {panelOpen && <SidePanel focusedPaneId={tab.focusedPaneId} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}


