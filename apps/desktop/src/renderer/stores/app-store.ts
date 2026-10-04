import { create } from 'zustand';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@chh/shared';

type Info = Awaited<ReturnType<typeof window.chh.app.info>>;

export type SettingsSection = 'general' | 'terminal' | 'shortcuts' | 'security' | 'sync';

export type HomeSection = 'hosts' | 'keys' | 'identities' | 'knownHosts' | 'snippets' | 'history' | 'forwards';

interface AppState {
  info: Info | null;
  section: HomeSection;
  setSection(section: HomeSection): void;
  settings: AppSettings;
  resolvedTheme: 'light' | 'dark';
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  paletteOpen: boolean;
  load(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  setSettingsOpen(open: boolean, section?: SettingsSection): void;
  setPaletteOpen(open: boolean): void;
  setSettingsSection(section: SettingsSection): void;
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
  settingsSection: 'general',
  paletteOpen: false,
  async load() {
    const [info, settings] = await Promise.all([window.chh.app.info({}), window.chh.app.getSettings({})]);
    set({ info, settings, resolvedTheme: resolveTheme(settings) });
  },
  async updateSettings(patch) {
    const settings = await window.chh.app.setSettings(patch);
    set({ settings, resolvedTheme: resolveTheme(settings) });
  },
  setSettingsOpen: (settingsOpen, section) => set(section ? { settingsOpen, settingsSection: section } : { settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

media.addEventListener('change', () => {
  const s = useApp.getState().settings;
  useApp.setState({ resolvedTheme: resolveTheme(s) });
});
