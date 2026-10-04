/**
 * Keyboard shortcuts. Accelerators use "Mod" for Cmd on macOS and Ctrl elsewhere.
 * Shortcuts that collide with common shell keys (Ctrl+W, Ctrl+T, …) use Ctrl+Shift off macOS,
 * so the terminal still receives the plain keys.
 */
export type CommandId =
  | 'palette.open'
  | 'tab.newLocal'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.hosts'
  | 'host.new'
  | 'hosts.search'
  | 'terminal.find'
  | 'terminal.copy'
  | 'terminal.paste'
  | 'settings.open'
  | 'pane.splitRight'
  | 'pane.splitDown'
  | 'pane.focusNext'
  | 'pane.focusPrev'
  | 'panel.toggle'
  | 'app.lock';

const isMac = () => window.cy.platform === 'darwin';

export function defaultKeymap(): Record<CommandId, string> {
  const mac = isMac();
  return {
    'palette.open': mac ? 'Mod+K' : 'Ctrl+Shift+K',
    'tab.newLocal': mac ? 'Mod+T' : 'Ctrl+Shift+T',
    'tab.close': mac ? 'Mod+W' : 'Ctrl+Shift+W',
    'tab.next': 'Ctrl+Tab',
    'tab.prev': 'Ctrl+Shift+Tab',
    'tab.hosts': mac ? 'Mod+1' : 'Alt+1',
    'host.new': mac ? 'Mod+N' : 'Ctrl+Shift+N',
    'hosts.search': mac ? 'Mod+F' : 'Ctrl+Shift+F',
    'terminal.find': mac ? 'Mod+F' : 'Ctrl+Shift+F',
    'terminal.copy': mac ? 'Mod+C' : 'Ctrl+Shift+C',
    'terminal.paste': mac ? 'Mod+V' : 'Ctrl+Shift+V',
    'settings.open': mac ? 'Mod+,' : 'Ctrl+,',
    'pane.splitRight': mac ? 'Mod+D' : 'Ctrl+Shift+D',
    'pane.splitDown': mac ? 'Mod+Shift+D' : 'Ctrl+Shift+E',
    'pane.focusNext': mac ? 'Mod+]' : 'Ctrl+Shift+]',
    'pane.focusPrev': mac ? 'Mod+[' : 'Ctrl+Shift+[',
    'panel.toggle': mac ? 'Mod+Shift+S' : 'Ctrl+Shift+S',
    'app.lock': mac ? 'Mod+Shift+L' : 'Ctrl+Shift+L',
  };
}

export const COMMAND_IDS = Object.keys({
  'palette.open': 1,
  'tab.newLocal': 1,
  'tab.close': 1,
  'tab.next': 1,
  'tab.prev': 1,
  'tab.hosts': 1,
  'host.new': 1,
  'hosts.search': 1,
  'terminal.find': 1,
  'terminal.copy': 1,
  'terminal.paste': 1,
  'settings.open': 1,
  'pane.splitRight': 1,
  'pane.splitDown': 1,
  'pane.focusNext': 1,
  'pane.focusPrev': 1,
  'panel.toggle': 1,
  'app.lock': 1,
} satisfies Record<CommandId, 1>) as CommandId[];

export function effectiveKeymap(overrides: Record<string, string>): Record<CommandId, string> {
  const km = defaultKeymap();
  for (const id of COMMAND_IDS) if (overrides[id]) km[id] = overrides[id]!;
  return km;
}

/** Unshifted characters for punctuation keys (so Shift+] stays "]" rather than "}"). */
const PUNCTUATION: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
};

function normalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return key === ' ' ? 'Space' : key;
}

/** Serializes a keyboard event into an accelerator string, e.g. "Ctrl+Shift+T". */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  const mac = isMac();
  if (mac ? e.metaKey : false) parts.push('Mod');
  if (e.ctrlKey) parts.push(mac ? 'Ctrl' : 'Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (!mac && e.metaKey) parts.push('Meta');
  // Use the physical key for letters/digits so Shift doesn't change the name ("!" vs "1").
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (PUNCTUATION[e.code]) key = PUNCTUATION[e.code]!;
  parts.push(normalizeKey(key));
  return parts.join('+');
}

/** Canonical form: on non-mac "Mod" means Ctrl. Modifier order is normalized. */
export function canonical(accel: string): string {
  const mac = isMac();
  const parts = accel.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === 'Mod' && !mac ? 'Ctrl' : p === 'Cmd' ? 'Mod' : p)));
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
  return [...order.filter((m) => mods.has(m)), normalizeKey(key)].join('+');
}

export function matches(e: KeyboardEvent, accel: string): boolean {
  const got = eventToAccelerator(e);
  return got !== null && canonical(got) === canonical(accel);
}

/** Human-readable label for menus and the palette. */
export function displayAccelerator(accel: string): string {
  const mac = isMac();
  return accel
    .split('+')
    .map((p) => {
      if (!mac) return p === 'Mod' ? 'Ctrl' : p;
      return { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }[p] ?? p;
    })
    .join(mac ? '' : '+');
}
