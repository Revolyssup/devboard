import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { AgentKind, Scope, TerminalTarget } from '../types';
import { useEscape } from './ui';

const AGENTS: AgentKind[] = ['claude', 'codex'];
const iconFor = (agent: AgentKind) => (agent === 'claude' ? '/agents/claude.svg' : '/agents/codex.webp');

export function NewSessionDialog({
  scope,
  mode,
  onClose,
  onOpen,
}: {
  scope: Scope;
  mode: 'learning' | 'chore';
  onClose: () => void;
  onOpen: (target: TerminalTarget) => void;
}) {
  const [agent, setAgent] = useState<AgentKind>('codex');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [directory, setDirectory] = useState('~/dev/');
  const [suggestions, setSuggestions] = useState<{ path: string; display: string }[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEscape(onClose);

  const resolvedDirectory = scope === 'personal' ? '~/dev/learning-shit' : directory.trim();
  const canOpen =
    (scope === 'personal' || resolvedDirectory.length > 0) &&
    (mode === 'learning' || (title.trim().length > 0 && description.trim().length > 0));

  useEffect(() => {
    if (scope !== 'work') return;
    const t = setTimeout(() => {
      api
        .suggestDirectories(directory)
        .then((res) => setSuggestions(res.items))
        .catch(() => setSuggestions([]));
    }, 120);
    return () => clearTimeout(t);
  }, [directory, scope]);

  const titleLabel = useMemo(
    () =>
      title.trim() ||
      (mode === 'chore'
        ? scope === 'personal'
          ? 'New personal chore session'
          : 'New work chore session'
        : scope === 'personal'
          ? 'New personal learning session'
          : 'New work learning session'),
    [mode, scope, title]
  );

  const submit = () => {
    if (!canOpen) return;
    onOpen({
      scope,
      kind: 'new',
      newKind: mode,
      agent,
      filename: '',
      title: titleLabel,
      sessionId: '',
      directory: resolvedDirectory,
      learningTitle: mode === 'learning' ? title.trim() : '',
      choreTitle: mode === 'chore' ? title.trim() : '',
      choreDescription: mode === 'chore' ? description.trim() : '',
    });
    onClose();
  };

  return (
    <div className="overlay-backdrop" style={{ alignItems: 'center' }} onClick={onClose}>
      <div className="overlay confirm new-session-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'learning' ? 'New learning session' : 'New chore session'}</h3>

        <label className="field-label">Agent</label>
        <div className="agent-picker">
          {AGENTS.map((a) => (
            <button
              key={a}
              className={`agent-choice ${agent === a ? 'selected' : ''}`}
              onClick={() => setAgent(a)}
              type="button"
            >
              <img className={`agent-icon ${a}`} src={iconFor(a)} alt="" aria-hidden="true" />
              <span>{a}</span>
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="session-title">
          {mode === 'learning' ? 'Learning Title' : 'Chore Title'}
        </label>
        <input
          id="session-title"
          className="field-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={mode === 'learning' ? 'Optional' : 'Required'}
          autoFocus
        />

        {mode === 'chore' && (
          <>
            <label className="field-label" htmlFor="chore-description">
              Description
            </label>
            <textarea
              id="chore-description"
              className="field-input chore-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Required"
              rows={4}
            />
          </>
        )}

        {scope === 'personal' ? (
          <div className="fixed-directory">
            <span className="field-label">Directory</span>
            <code>~/dev/learning-shit</code>
          </div>
        ) : (
          <>
            <label className="field-label" htmlFor="session-directory">
              Directory
            </label>
            <input
              id="session-directory"
              ref={inputRef}
              className="field-input mono-input"
              value={directory}
              onFocus={() => setActiveSuggestion(true)}
              onBlur={() => setTimeout(() => setActiveSuggestion(false), 120)}
              onChange={(e) => setDirectory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && suggestions[0]) {
                  e.preventDefault();
                  setDirectory(suggestions[0].display);
                }
              }}
              placeholder="~/dev/"
            />
            {activeSuggestion && suggestions.length > 0 && (
              <div className="directory-suggestions">
                {suggestions.map((s) => (
                  <button
                    key={s.path}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setDirectory(s.display);
                      inputRef.current?.focus();
                    }}
                    title={s.path}
                  >
                    {s.display}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!canOpen}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
