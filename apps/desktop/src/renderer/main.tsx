import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { LockScreen } from './features/lock/LockScreen';
import { installTestHooks } from './features/terminal/registry';
import { initI18n } from './i18n';
import { useSecurity } from './stores/lock-store';
import './styles.css';

/**
 * Lock gate. With a master password the database isn't even open until unlock, so the app isn't
 * mounted at all; an idle lock overlays the running app (sessions keep running underneath).
 */
function Root() {
  const lock = useSecurity((s) => s.lock);
  useEffect(() => {
    if (!lock) return;
    if (!document.documentElement.dataset.theme) {
      document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  }, [lock]);
  if (!lock) return null;
  if (lock.locked === 'startup') return <LockScreen state={lock} />;
  return (
    <>
      <App />
      {lock.locked === 'idle' && <LockScreen state={lock} />}
    </>
  );
}

async function start() {
  await initI18n('en');
  const [info, lock] = await Promise.all([window.chh.app.info({}), window.chh.lock.state({})]);
  if (info.testMode) installTestHooks();
  useSecurity.getState().setLock(lock);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void start();
