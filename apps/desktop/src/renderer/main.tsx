import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { installTestHooks } from './features/terminal/registry';
import { initI18n } from './i18n';
import { useApp } from './stores/app-store';
import './styles.css';

async function start() {
  await useApp.getState().load();
  const { settings, info, resolvedTheme } = useApp.getState();
  document.documentElement.dataset.theme = resolvedTheme;
  await initI18n(settings.language);
  if (info?.testMode) installTestHooks();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
