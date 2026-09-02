import type {
  Chore,
  FileContent,
  Learning,
  Page,
  ProgressReport,
  Scope,
  TerminalTarget,
  TerminalTicket,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listLearnings(scope: Scope, page: number, pageSize: number) {
    return request<Page<Learning> & { scope: Scope }>(
      `/api/learnings/${scope}?page=${page}&pageSize=${pageSize}`
    );
  },

  searchLearnings(scope: Scope, q: string, page = 1, pageSize = 10) {
    return request<Page<Learning> & { query: string }>(
      `/api/learnings/${scope}/search?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`
    );
  },

  readLearning(scope: Scope, filename: string) {
    return request<FileContent>(`/api/learnings/${scope}/file/${encodeURIComponent(filename)}`);
  },

  saveLearning(scope: Scope, filename: string, content: string) {
    return request<{ filename: string; title: string; mtime: string }>(
      `/api/learnings/${scope}/file/${encodeURIComponent(filename)}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    );
  },

  deleteLearning(scope: Scope, filename: string) {
    return request<{ deleted: boolean; indexRowRemoved: boolean }>(
      `/api/learnings/${scope}/file/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    );
  },

  listChores(scope: Scope, page = 1, pageSize = 10, q = '') {
    return request<Page<Chore> & { query: string }>(
      `/api/chores/${scope}?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(q)}`
    );
  },

  readChore(scope: Scope, filename: string) {
    return request<FileContent>(`/api/chores/${scope}/file/${encodeURIComponent(filename)}`);
  },

  deleteChore(scope: Scope, filename: string) {
    return request<{ deleted: boolean; indexRowRemoved: boolean }>(
      `/api/chores/${scope}/file/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    );
  },

  saveChore(scope: Scope, filename: string, content: string) {
    return request<{ filename: string; title: string; mtime: string }>(
      `/api/chores/${scope}/file/${encodeURIComponent(filename)}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    );
  },

  progressReport() {
    return request<ProgressReport>('/api/reports/progress');
  },

  /**
   * Validate a terminal request and get a single-use ticket. Every rejection (no session, bad
   * directory, session already live, too many terminals) arrives here as a normal error, so the
   * UI can explain itself before mounting any terminal.
   */
  openTerminal(t: TerminalTarget, cols: number, rows: number) {
    return request<TerminalTicket>('/api/terminal', {
      method: 'POST',
      body: JSON.stringify({
        scope: t.scope,
        kind: t.kind,
        agent: t.agent,
        filename: t.filename,
        sessionId: t.sessionId,
        directory: t.directory,
        cols,
        rows,
      }),
    });
  },

  openNewTerminal(t: TerminalTarget, cols: number, rows: number) {
    return request<TerminalTicket>('/api/terminal/new', {
      method: 'POST',
      body: JSON.stringify({
        scope: t.scope,
        agent: t.agent,
        directory: t.directory,
        newKind: t.newKind || 'learning',
        filename: t.filename || '',
        title: t.title || '',
        learningTitle: t.learningTitle || '',
        choreTitle: t.choreTitle || '',
        choreDescription: t.choreDescription || '',
        cols,
        rows,
      }),
    });
  },

  suggestDirectories(q: string) {
    return request<{ root: string; items: { path: string; display: string }[] }>(
      `/api/terminal/directories?q=${encodeURIComponent(q)}`
    );
  },
};
