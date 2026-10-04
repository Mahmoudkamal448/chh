import type { ITheme } from '@xterm/xterm';

export interface TerminalScheme {
  id: string;
  name: string;
  dark: boolean;
  theme: ITheme;
}

type Ansi16 = [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];

function scheme(
  id: string,
  name: string,
  dark: boolean,
  base: { bg: string; fg: string; cursor: string; selection: string },
  c: Ansi16,
): TerminalScheme {
  return {
    id,
    name,
    dark,
    theme: {
      background: base.bg,
      foreground: base.fg,
      cursor: base.cursor,
      cursorAccent: base.bg,
      selectionBackground: base.selection,
      black: c[0],
      red: c[1],
      green: c[2],
      yellow: c[3],
      blue: c[4],
      magenta: c[5],
      cyan: c[6],
      white: c[7],
      brightBlack: c[8],
      brightRed: c[9],
      brightGreen: c[10],
      brightYellow: c[11],
      brightBlue: c[12],
      brightMagenta: c[13],
      brightCyan: c[14],
      brightWhite: c[15],
    },
  };
}

/** Built-in color schemes (original palettes). */
export const TERMINAL_SCHEMES: TerminalScheme[] = [
  scheme('chh-dark', 'chh Dark', true, { bg: '#0f1115', fg: '#d8dee9', cursor: '#6c9bff', selection: '#2a3550' }, [
    '#1c1f26', '#f0717a', '#7fd17f', '#e8c46a', '#6c9bff', '#c792ea', '#5fd3d3', '#c9ced8',
    '#4b5263', '#ff8f96', '#9be89b', '#ffd98a', '#93b6ff', '#dcb0ff', '#86e8e8', '#ffffff',
  ]),
  scheme('chh-light', 'chh Light', false, { bg: '#fbfbfc', fg: '#1f2329', cursor: '#2459d6', selection: '#cdd9f5' }, [
    '#1f2329', '#c4313b', '#2f8a3a', '#a06a00', '#2459d6', '#8a3fb8', '#0f7f86', '#d5d8de',
    '#6b7280', '#e0454f', '#3aa648', '#c18400', '#3c70ee', '#a557d4', '#14999f', '#ffffff',
  ]),
  scheme('harbor', 'Harbor', true, { bg: '#0d1b24', fg: '#cfe3ea', cursor: '#4fd1c5', selection: '#1f3d4d' }, [
    '#132833', '#ef6f6c', '#6cc785', '#e6c36a', '#4ea1d3', '#b48ead', '#4fd1c5', '#bcd3db',
    '#3d5a68', '#ff8a87', '#8be0a1', '#f4d88a', '#73bde8', '#cfa7c9', '#76e4da', '#f2fbff',
  ]),
  scheme('ember', 'Ember', true, { bg: '#1a1210', fg: '#f1dfd3', cursor: '#ff8a4c', selection: '#4a2b20' }, [
    '#241915', '#e5534b', '#a3be6c', '#f0a64a', '#7aa2c7', '#d1849f', '#7fc4b8', '#dccabd',
    '#5c463d', '#ff6f66', '#bdd889', '#ffc06b', '#9bbfe0', '#eba2bb', '#9ddfd3', '#fff5ee',
  ]),
  scheme('moss', 'Moss', true, { bg: '#141a14', fg: '#d6e2cf', cursor: '#9fd36b', selection: '#2f3d2a' }, [
    '#1c241c', '#d9665b', '#9fd36b', '#d8c26a', '#6fa3c4', '#b78bb5', '#6fc2a4', '#c4cfbd',
    '#4a5a46', '#ef8277', '#b8e88a', '#ecd98b', '#8fbfdc', '#d0a6ce', '#8fdabd', '#f3f8ef',
  ]),
  scheme('glacier', 'Glacier', false, { bg: '#f2f7fa', fg: '#203040', cursor: '#1b6fa8', selection: '#c6dff0' }, [
    '#203040', '#b8323e', '#2b7d4f', '#946200', '#1b6fa8', '#7c4aa8', '#127a83', '#d3dde5',
    '#5f7080', '#d1444f', '#359a61', '#b37a00', '#2d86c4', '#965fc4', '#1a959f', '#ffffff',
  ]),
  scheme('dusk', 'Dusk', true, { bg: '#1b1726', fg: '#e3dcf2', cursor: '#f29fd0', selection: '#3a3150' }, [
    '#241f33', '#f07891', '#8fd4a0', '#f1c27d', '#8aa8f0', '#c89cf2', '#7fd0dc', '#d2cbe0',
    '#58506e', '#ff94aa', '#aee9bc', '#ffd89c', '#a8c1ff', '#dcb6ff', '#9ee6f0', '#fbf8ff',
  ]),
  scheme('paper', 'Paper', false, { bg: '#f7f3ea', fg: '#2d2a24', cursor: '#8a5a00', selection: '#e3d8bf' }, [
    '#2d2a24', '#a83232', '#4b7a2a', '#8a5a00', '#2e5c99', '#7d3f7d', '#2a7373', '#ddd5c4',
    '#6e665a', '#c44747', '#5e9636', '#a86f00', '#3d72b8', '#995299', '#358f8f', '#fffdf7',
  ]),
  scheme('midnight', 'Midnight', true, { bg: '#05070d', fg: '#c5cbe0', cursor: '#7aa2ff', selection: '#1c2440' }, [
    '#0d111c', '#e35d6a', '#62c48b', '#d8b863', '#5d8bf4', '#a77bf3', '#4cc1d1', '#b6bdd4',
    '#3a4157', '#f77b87', '#82dca6', '#ebcd80', '#7aa2ff', '#c19aff', '#6ed8e6', '#eef1fb',
  ]),
  scheme('sandstone', 'Sandstone', true, { bg: '#221d17', fg: '#e8dcc8', cursor: '#e0b36a', selection: '#4a3f30' }, [
    '#2b251e', '#d0674f', '#a7b86a', '#e0b36a', '#7d9fb3', '#bc8aa0', '#86b5a3', '#d5c8b2',
    '#5f5446', '#e8826a', '#c1d089', '#f2ca88', '#9bbacb', '#d4a5ba', '#a3cfbe', '#fbf3e6',
  ]),
  scheme('neon', 'Neon', true, { bg: '#0b0b12', fg: '#e8e8f2', cursor: '#00f0c8', selection: '#2b2b48' }, [
    '#15151f', '#ff3d7f', '#3dff8f', '#ffe14d', '#3d9bff', '#c13dff', '#00f0c8', '#cfcfe0',
    '#45455e', '#ff6b9e', '#6dffab', '#fff07a', '#6bb5ff', '#d46bff', '#4dffe0', '#ffffff',
  ]),
  scheme('slate', 'Slate', true, { bg: '#1e2329', fg: '#d3d9e0', cursor: '#a3b8cc', selection: '#38414c' }, [
    '#262c33', '#d87070', '#8fbf8f', '#d4b878', '#7fa3c7', '#ab92c4', '#7fbfbf', '#c2c9d1',
    '#56606b', '#ec8a8a', '#a9d6a9', '#e6cc90', '#9abbdb', '#c2acd8', '#99d6d6', '#f5f7f9',
  ]),
];

/** Scheme ids saved by builds from before the rename to chh. */
const LEGACY_IDS: Record<string, string> = { 'cy-dark': 'chh-dark', 'cy-light': 'chh-light' };

export function schemeById(id: string): TerminalScheme {
  const wanted = LEGACY_IDS[id] ?? id;
  return TERMINAL_SCHEMES.find((s) => s.id === wanted) ?? TERMINAL_SCHEMES[0]!;
}
