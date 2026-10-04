import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** The same empty screen everywhere: icon, what this section is for, and what to do first. */
export function EmptyState({ icon: Icon, children, action, note }: { icon: LucideIcon; children: ReactNode; action?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted" data-testid="empty-state">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg/70">
        <Icon size={22} aria-hidden />
      </span>
      <p className="max-w-sm text-[13px]">{children}</p>
      {action}
      {note && <p className="max-w-sm text-[12px]">{note}</p>}
    </div>
  );
}
