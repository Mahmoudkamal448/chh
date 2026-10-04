import { z } from 'zod';
import { HostSettingsSchema } from './settings';

export const UiThemeSchema = z.enum(['system', 'light', 'dark']);
export type UiTheme = z.infer<typeof UiThemeSchema>;

/** Device-local preferences (never synced). */
export const AppSettingsSchema = z.object({
  uiTheme: UiThemeSchema,
  defaultShell: z.string().max(1024).nullable(),
  /** Overrides of the default keymap: commandId -> accelerator string (e.g. "Mod+K"). */
  keymap: z.record(z.string().max(64), z.string().max(64)),
  language: z.string().max(16),
  /** App-wide terminal appearance defaults; groups and hosts can still override them. */
  terminalDefaults: HostSettingsSchema.pick({
    terminalTheme: true,
    fontFamily: true,
    fontSize: true,
    cursorStyle: true,
    cursorBlink: true,
    scrollback: true,
  }).partial(),
  /** Record typed commands in the searchable history. */
  historyEnabled: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  uiTheme: 'system',
  defaultShell: null,
  keymap: {},
  language: 'en',
  terminalDefaults: {},
  historyEnabled: true,
};
