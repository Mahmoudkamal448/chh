import { create } from 'zustand';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@cy-ssh/shared';

type Info = Awaited<ReturnType<typeof window.cy.app.info>>;

export type HomeSection = 'hosts' | 'keys' | 'identities' | 'knownHosts';

interface AppState {
  info: Info | null;
  section: HomeSection;
  setSection(section: HomeSection): void;
  settings: AppSettings;
  resolvedTheme: 'light' | 'dark';
  settingsOpen: boolean;
  paletteOpen: boolean;
  load(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  setSettingsOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;
}

const media = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(s: AppSettings): 'light' | 'dark' {
  if (s.uiTheme === 'system') return media.matches ? 'dark' : 'light';
  return s.uiTheme;
}

export const useApp = create<AppState>((set) => ({
  info: null,
  section: 'hosts',
  setSection: (section) => set({ section }),
  settings: DEFAULT_APP_SETTINGS,
  resolvedTheme: media.matches ? 'dark' : 'light',
  settingsOpen: false,
  paletteOpen: false,
  async load() {
    const [info, settings] = await Promise.all([window.cy.app.info({}), window.cy.app.getSettings({})]);
    set({ info, settings, resolvedTheme: resolveTheme(settings) });
  },
  async updateSettings(patch) {
    const settings = await window.cy.app.setSettings(patch);
    set({ settings, resolvedTheme: resolveTheme(settings) });
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

media.addEventListener('change', () => {
  const s = useApp.getState().settings;
  useApp.setState({ resolvedTheme: resolveTheme(s) });
});
