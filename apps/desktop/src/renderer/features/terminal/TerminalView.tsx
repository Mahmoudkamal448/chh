import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_HOST_SETTINGS, resolveSettings, type GroupLike, type HostSettings, type TerminalStream } from '@cy-ssh/shared';
import { Button, IconButton, Input } from '../../components/ui';
import { splitStatusMessage } from '../../lib/errors';
import { COMMAND_IDS, effectiveKeymap, matches } from '../../lib/keymap';
import { useApp } from '../../stores/app-store';
import { useHosts } from '../../stores/hosts-store';
import { useTabs, type SessionTab } from '../../stores/tabs-store';
import { schemeById } from '../../themes/terminal-themes';
import { registerTerminal, unregisterTerminal } from './registry';

/** Let the app handle its shortcuts instead of sending them to the shell. */
function isAppShortcut(e: KeyboardEvent): boolean {
  const km = effectiveKeymap(useApp.getState().settings.keymap);
  const mac = window.cy.platform === 'darwin';
  return COMMAND_IDS.some((id) => {
    if (mac && (id === 'terminal.copy' || id === 'terminal.paste')) return false; // native menu roles handle these
    if (id === 'hosts.search') return false;
    return matches(e, km[id]);
  });
}

async function settingsFor(tab: SessionTab): Promise<HostSettings> {
  if (!tab.hostId) return DEFAULT_HOST_SETTINGS;
  try {
    const host = await window.cy.hosts.get({ id: tab.hostId });
    const groups = useHosts.getState().groups;
    return resolveSettings(host.groupId, host.settings, new Map<string, GroupLike>(groups.map((g) => [g.id, g])));
  } catch {
    return DEFAULT_HOST_SETTINGS;
  }
}

export function TerminalView({ tab, active }: { tab: SessionTab; active: boolean }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const streamRef = useRef<TerminalStream | null>(null);
  const [ready, setReady] = useState(false);
  const [bg, setBg] = useState<string | undefined>(undefined);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const setStatus = useTabs((s) => s.setStatus);
  const reconnect = useTabs((s) => s.reconnect);
  const closeTab = useTabs((s) => s.close);

  // Create the terminal once per tab.
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    void settingsFor(tab).then((s) => {
      if (disposed || !containerRef.current) return;
      term = new Terminal({
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        cursorStyle: s.cursorStyle,
        cursorBlink: s.cursorBlink,
        scrollback: s.scrollback,
        theme: schemeById(s.terminalTheme).theme,
        allowProposedApi: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
      });
      setBg(schemeById(s.terminalTheme).theme.background);
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.loadAddon(
        new WebLinksAddon((_e, uri) => {
          if (/^https?:\/\//.test(uri)) void window.cy.app.openExternal({ url: uri });
        }),
      );
      term.open(containerRef.current);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable: xterm falls back to its DOM renderer.
      }
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const km = effectiveKeymap(useApp.getState().settings.keymap);
        const mac = window.cy.platform === 'darwin';
        if (!mac && matches(e, km['terminal.copy'])) {
          const sel = term!.getSelection();
          if (sel) void navigator.clipboard.writeText(sel);
          return false;
        }
        if (!mac && matches(e, km['terminal.paste'])) {
          void navigator.clipboard.readText().then((text) => text && term!.paste(text));
          return false;
        }
        return !isAppShortcut(e);
      });
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;
      registerTerminal(tab.id, term);
      setReady(true);
    });
    return () => {
      disposed = true;
      unregisterTerminal(tab.id);
      term?.dispose();
      termRef.current = null;
    };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach to the session's byte stream (again after a reconnect).
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    setExitCode(undefined);
    const stream = window.cy.attachTerminal(tab.sessionId, {
      onData: (d) => {
        const n = typeof d === 'string' ? d.length : d.byteLength;
        term.write(d, () => stream.ack(n));
      },
      onStatus: (status, message) => setStatus(tab.sessionId, status, message),
      onExit: (code) => setExitCode(code),
    });
    streamRef.current = stream;
    const d1 = term.onData((d) => stream.write(d));
    const d2 = term.onBinary((d) => stream.write(d));
    const d3 = term.onResize(({ cols, rows }) => stream.resize(cols, rows));
    try {
      fitRef.current?.fit();
    } catch {
      // not visible yet
    }
    stream.resize(term.cols, term.rows);
    return () => {
      d1.dispose();
      d2.dispose();
      d3.dispose();
      stream.detach();
      streamRef.current = null;
    };
  }, [ready, tab.sessionId, setStatus]);

  // Keep the terminal sized to its container while visible.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ready) return;
    const ro = new ResizeObserver(() => {
      if (el.offsetParent === null) return;
      try {
        fitRef.current?.fit();
      } catch {
        // ignore transient layout states
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  useEffect(() => {
    if (active && ready) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore
        }
        if (!findOpen) termRef.current?.focus();
      });
    }
  }, [active, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find bar shortcut (dispatched by the global shortcut handler).
  useEffect(() => {
    const onFind = () => active && setFindOpen(true);
    window.addEventListener('cy:terminal-find', onFind);
    return () => window.removeEventListener('cy:terminal-find', onFind);
  }, [active]);

  const findNext = (back = false) => {
    if (!findText) return;
    if (back) searchRef.current?.findPrevious(findText);
    else searchRef.current?.findNext(findText);
  };

  const msg = splitStatusMessage(tab.message);
  const ended = exitCode !== undefined || tab.status === 'closed' || tab.status === 'error';
  const showOverlay = tab.status === 'connecting' || tab.status === 'authenticating' || ended;

  return (
    <div className="relative h-full w-full" style={{ background: bg }} data-testid="terminal" data-session-id={tab.sessionId}>
      <div ref={containerRef} className="h-full w-full" />

      {findOpen && (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-surface p-1 shadow-lg">
          <Input
            autoFocus
            className="h-7 w-56"
            placeholder={t('terminal.find')}
            aria-label={t('terminal.find')}
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') findNext(e.shiftKey);
              if (e.key === 'Escape') {
                setFindOpen(false);
                searchRef.current?.clearDecorations();
                termRef.current?.focus();
              }
            }}
          />
          <IconButton label={t('terminal.findPrev')} onClick={() => findNext(true)}>
            <ChevronUp size={14} />
          </IconButton>
          <IconButton label={t('terminal.findNext')} onClick={() => findNext()}>
            <ChevronDown size={14} />
          </IconButton>
          <IconButton
            label={t('common.close')}
            onClick={() => {
              setFindOpen(false);
              searchRef.current?.clearDecorations();
              termRef.current?.focus();
            }}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}

      {showOverlay && (
        <div
          className={
            ended
              ? 'absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-border bg-surface/95 px-4 py-2.5'
              : 'pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-surface/90 px-3 py-1.5 text-[12px] text-muted shadow'
          }
          role="status"
          data-testid="session-overlay"
        >
          {!ended && (tab.status === 'authenticating' ? t('session.authenticating') : t('session.connecting'))}
          {ended && (
            <>
              <span className="text-[13px]">
                {tab.status === 'error' && msg
                  ? t(msg.key, { defaultValue: t('session.error.generic'), detail: msg.detail ?? '' })
                  : exitCode !== undefined && exitCode !== null
                    ? t('session.exited', { code: exitCode })
                    : t('session.closed')}
              </span>
              <span className="ml-auto flex gap-2">
                <Button variant="primary" onClick={() => void reconnect(tab.id)} data-testid="reconnect">
                  {t('session.reconnect')}
                </Button>
                <Button onClick={() => closeTab(tab.id)}>{t('session.closeTab')}</Button>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
