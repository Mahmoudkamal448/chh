import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_HOST_SETTINGS, resolveSettings, type GroupLike, type HostSettings, type TerminalStream } from '@cy-ssh/shared';
import { Button, IconButton, Input } from '../../components/ui';
import { cn } from '../../lib/cn';
import { errorMessage, splitStatusMessage } from '../../lib/errors';
import { COMMAND_IDS, effectiveKeymap, matches } from '../../lib/keymap';
import { useApp } from '../../stores/app-store';
import { useHosts } from '../../stores/hosts-store';
import { useTabs, type TermPane } from '../../stores/tabs-store';
import { schemeById } from '../../themes/terminal-themes';
import { useLibrary } from '../../stores/library-store';
import { Ghost, SuggestionList, cursorPosition, type SuggestionItem } from './Autocomplete';
import { HistoryCapture } from './history-capture';
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

/** Effective appearance: built-in defaults ← app terminal defaults ← groups ← host. */
async function settingsFor(pane: TermPane): Promise<HostSettings> {
  const defaults = { ...DEFAULT_HOST_SETTINGS, ...useApp.getState().settings.terminalDefaults };
  if (pane.source.kind !== 'host') return defaults;
  try {
    const host = await window.cy.hosts.get({ id: pane.source.hostId });
    const groups = useHosts.getState().groups;
    return resolveSettings(host.groupId, host.settings, new Map<string, GroupLike>(groups.map((g) => [g.id, g])), defaults);
  } catch {
    return defaults;
  }
}

function termOptions(s: HostSettings): ITerminalOptions {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    theme: schemeById(s.terminalTheme).theme,
  };
}

export function TerminalView({ pane, visible, focused, split }: { pane: TermPane; visible: boolean; focused: boolean; split: boolean }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const streamRef = useRef<TerminalStream | null>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const [ready, setReady] = useState(false);
  const [bg, setBg] = useState<string | undefined>(undefined);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  // Autocomplete: ghost text (→ accepts) and a Ctrl+Space list. Refs mirror state for key handlers.
  const captureRef = useRef<HistoryCapture | null>(null);
  const [ghost, setGhost] = useState<{ text: string; left: number; top: number } | null>(null);
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const [list, setList] = useState<{ input: string; items: SuggestionItem[]; index: number; left: number; top: number; loading: boolean } | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const ghostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fontInfo, setFontInfo] = useState({ font: DEFAULT_HOST_SETTINGS.fontFamily, size: DEFAULT_HOST_SETTINGS.fontSize });
  const setStatus = useTabs((s) => s.setStatus);
  const reconnect = useTabs((s) => s.reconnect);
  const closePane = useTabs((s) => s.closePane);
  const focusPane = useTabs((s) => s.focusPane);
  const terminalDefaults = useApp((s) => s.settings.terminalDefaults);
  const groups = useHosts((s) => s.groups);
  const hostsVersion = useHosts((s) => s.hosts);

  const fit = () => {
    try {
      fitRef.current?.fit();
    } catch {
      // not laid out yet
    }
  };

  // Create the terminal once per pane.
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    void settingsFor(pane).then((s) => {
      if (disposed || !containerRef.current) return;
      term = new Terminal({ ...termOptions(s), allowProposedApi: true, macOptionIsMeta: true, rightClickSelectsWord: true });
      setBg(schemeById(s.terminalTheme).theme.background);
      setFontInfo({ font: s.fontFamily, size: s.fontSize });
      const fitAddon = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fitAddon);
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
      const tm = term;
      tm.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const km = effectiveKeymap(useApp.getState().settings.keymap);
        const mac = window.cy.platform === 'darwin';
        if (!mac && matches(e, km['terminal.copy'])) {
          const sel = tm.getSelection();
          if (sel) void navigator.clipboard.writeText(sel);
          return false;
        }
        if (!mac && matches(e, km['terminal.paste'])) {
          void navigator.clipboard.readText().then((text) => text && tm.paste(text));
          return false;
        }
        // Autocomplete keys.
        const l = listRef.current;
        if (l) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            setList({ ...l, index: (l.index + (e.key === 'ArrowDown' ? 1 : -1) + Math.max(1, l.items.length)) % Math.max(1, l.items.length) });
            return false;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            void pickSuggestion(l.index);
            return false;
          }
          if (e.key === 'Escape') {
            setList(null);
            return false;
          }
          setList(null);
        }
        if (e.key === ' ' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && useApp.getState().settings.autocomplete.enabled) {
          void openList();
          return false;
        }
        const g = ghostRef.current;
        if (g && e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          streamRef.current?.write(g.text);
          setGhost(null);
          return false;
        }
        return !isAppShortcut(e);
      });
      tm.textarea?.addEventListener('focus', () => focusPane(paneRef.current.id));
      termRef.current = tm;
      fitRef.current = fitAddon;
      searchRef.current = search;
      registerTerminal(pane.id, { term: tm, write: (d) => streamRef.current?.write(d) });
      setReady(true);
    });
    return () => {
      disposed = true;
      unregisterTerminal(pane.id);
      term?.dispose();
      termRef.current = null;
    };
  }, [pane.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply appearance changes live (app defaults, group or host edits).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void settingsFor(paneRef.current).then((s) => {
      const term = termRef.current;
      if (cancelled || !term) return;
      term.options = termOptions(s);
      setBg(schemeById(s.terminalTheme).theme.background);
      fit();
    });
    return () => {
      cancelled = true;
    };
  }, [ready, terminalDefaults, groups, hostsVersion]);

  // Attach to the session's byte stream (again after a reconnect).
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    setExitCode(undefined);
    const stream = window.cy.attachTerminal(pane.sessionId, {
      onData: (d) => {
        const n = typeof d === 'string' ? d.length : d.byteLength;
        term.write(d, () => stream.ack(n));
      },
      onStatus: (status, message) => setStatus(pane.sessionId, status, message),
      onExit: (code) => setExitCode(code),
    });
    streamRef.current = stream;
    const src = paneRef.current.source;
    const capture = new HistoryCapture(term, (command) => {
      if (useApp.getState().settings.historyEnabled) {
        void window.cy.history.add({ hostId: src.kind === 'host' ? src.hostId : null, source: paneRef.current.title, command });
      }
    });
    captureRef.current = capture;
    const d1 = term.onData((d) => {
      capture.input(d);
      stream.write(d);
      setGhost(null);
      // Look for a completion once the echo has landed.
      if (ghostTimer.current) clearTimeout(ghostTimer.current);
      if (useApp.getState().settings.autocomplete.enabled && !/[\r\n\x03\x04]/.test(d)) ghostTimer.current = setTimeout(updateGhost, 150);
    });
    const d2 = term.onBinary((d) => stream.write(d));
    const d3 = term.onResize(({ cols, rows }) => stream.resize(cols, rows));
    fit();
    stream.resize(term.cols, term.rows);
    return () => {
      d1.dispose();
      d2.dispose();
      d3.dispose();
      stream.detach();
      streamRef.current = null;
    };
  }, [ready, pane.sessionId, setStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the terminal sized to its pane while visible.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ready) return;
    const ro = new ResizeObserver(() => el.offsetParent !== null && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  useEffect(() => {
    if (visible && focused && ready) {
      requestAnimationFrame(() => {
        fit();
        if (!findOpen) termRef.current?.focus();
      });
    }
  }, [visible, focused, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find bar shortcut (dispatched by the global shortcut handler to the focused pane).
  useEffect(() => {
    const onFind = () => visible && focused && setFindOpen(true);
    window.addEventListener('cy:terminal-find', onFind);
    return () => window.removeEventListener('cy:terminal-find', onFind);
  }, [visible, focused]);

  const hostIdOf = () => (paneRef.current.source.kind === 'host' ? paneRef.current.source.hostId : null);

  async function updateGhost() {
    const term = termRef.current;
    const input = captureRef.current?.typed();
    if (!term || !containerRef.current || !input || input.trim().length < 2) return;
    const [best] = await window.cy.suggest.history({ prefix: input, hostId: hostIdOf(), limit: 1 });
    if (!best || captureRef.current?.typed() !== input) return; // user kept typing
    const pos = cursorPosition(term, containerRef.current);
    if (pos) setGhost({ text: best.slice(input.length), left: pos.left, top: pos.top });
  }

  async function openList() {
    const term = termRef.current;
    if (!term || !containerRef.current) return;
    setGhost(null);
    const input = captureRef.current?.typed() ?? '';
    const pos = cursorPosition(term, containerRef.current);
    if (!pos) return;
    const history = input ? await window.cy.suggest.history({ prefix: input, hostId: hostIdOf(), limit: 8 }) : [];
    const q = input.toLowerCase();
    const snippets = useLibrary
      .getState()
      .snippets.filter((s) => !q || s.label.toLowerCase().includes(q) || s.script.toLowerCase().startsWith(q))
      .slice(0, 5);
    const items: SuggestionItem[] = [
      ...history.map((text) => ({ kind: 'history' as const, text })),
      ...snippets.map((s) => ({ kind: 'snippet' as const, text: s.script, label: s.label })),
    ];
    if (useApp.getState().settings.ai.enabled && input.trim()) items.push({ kind: 'ask-ai', text: '' });
    setList({ input, items, index: 0, left: pos.left, top: pos.top + pos.cellH + 2, loading: false });
  }

  async function pickSuggestion(i: number) {
    const l = listRef.current;
    const item = l?.items[i];
    if (!l || !item) return setList(null);
    if (item.kind === 'ask-ai') {
      setList({ ...l, loading: true, items: l.items.filter((x) => x.kind !== 'ask-ai') });
      try {
        const recent = useApp.getState().settings.ai.sendHistory
          ? (await window.cy.history.search({ hostId: hostIdOf() ?? undefined, limit: 10 })).map((h) => h.command).reverse()
          : [];
        const { suggestions } = await window.cy.suggest.ai({ line: l.input, hostId: hostIdOf(), recent });
        const cur = listRef.current;
        if (cur) setList({ ...cur, loading: false, index: cur.items.length, items: [...cur.items, ...suggestions.map((text) => ({ kind: 'ai' as const, text }))] });
      } catch (err) {
        const cur = listRef.current;
        const { key, detail } = errorMessage(err);
        if (cur) setList({ ...cur, loading: false, items: [...cur.items, { kind: 'ai', text: `# ${t(key, { defaultValue: t('errors.internal'), detail })}` }] });
      }
      return;
    }
    setList(null);
    const stream = streamRef.current;
    if (!stream || item.text.startsWith('# ')) return;
    // Completions extend what's typed; anything else replaces the line (Ctrl+U clears it in most shells).
    if (item.text.startsWith(l.input)) stream.write(item.text.slice(l.input.length));
    else stream.write(`\x15${item.text.replace(/\r?\n/g, '\r')}`);
    termRef.current?.focus();
  }

  const findNext = (back = false) => {
    if (!findText) return;
    if (back) searchRef.current?.findPrevious(findText);
    else searchRef.current?.findNext(findText);
  };
  const closeFind = () => {
    setFindOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  const msg = splitStatusMessage(pane.message);
  const ended = exitCode !== undefined || pane.status === 'closed' || pane.status === 'error';
  const showOverlay = pane.status === 'connecting' || pane.status === 'authenticating' || ended;

  return (
    <div
      className={cn('relative h-full w-full', split && (focused ? 'ring-1 ring-inset ring-accent/70' : 'opacity-90'))}
      style={{ background: bg }}
      onMouseDown={() => focusPane(pane.id)}
      data-testid="terminal"
      data-pane-id={pane.id}
      data-focused={focused || undefined}
    >
      <div ref={containerRef} className="h-full w-full" />
      {ghost && <Ghost text={ghost.text} left={ghost.left} top={ghost.top} font={fontInfo.font} size={fontInfo.size} />}
      {list && <SuggestionList items={list.items} index={list.index} left={list.left} top={list.top} loading={list.loading} onPick={(i) => void pickSuggestion(i)} />}

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
              if (e.key === 'Escape') closeFind();
            }}
          />
          <IconButton label={t('terminal.findPrev')} onClick={() => findNext(true)}>
            <ChevronUp size={14} />
          </IconButton>
          <IconButton label={t('terminal.findNext')} onClick={() => findNext()}>
            <ChevronDown size={14} />
          </IconButton>
          <IconButton label={t('common.close')} onClick={closeFind}>
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
          {!ended && (pane.status === 'authenticating' ? t('session.authenticating') : t('session.connecting'))}
          {ended && (
            <>
              <span className="text-[13px]">
                {pane.status === 'error' && msg
                  ? t(msg.key, { defaultValue: t('session.error.generic'), detail: msg.detail ?? '' })
                  : exitCode !== undefined && exitCode !== null
                    ? t('session.exited', { code: exitCode })
                    : t('session.closed')}
              </span>
              <span className="ml-auto flex gap-2">
                <Button variant="primary" onClick={() => void reconnect(pane.id)} data-testid="reconnect">
                  {t('session.reconnect')}
                </Button>
                <Button onClick={() => closePane(pane.id)}>{split ? t('session.closePane') : t('session.closeTab')}</Button>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
