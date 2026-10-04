import { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';

/** Where an unset setting comes from: a parent group, or the app defaults (no group). */
export const InheritSource = createContext<'group' | 'defaults'>('group');

/** "Inherit (value)" under a group, "Default (value)" otherwise. */
export function useInheritLabel(): (value: string) => string {
  const { t } = useTranslation();
  const source = useContext(InheritSource);
  return (value) => t(source === 'group' ? 'settings.inherit' : 'settings.default', { value });
}
