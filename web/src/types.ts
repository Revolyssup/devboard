export type Scope = 'work' | 'personal';
export type AgentKind = 'claude' | 'codex';

export interface SessionRef {
  agent: AgentKind;
  id: string;
  active: boolean;
  lastSeen: string | null;
  projectSlug?: string | null;
  transcript?: string | null;
  directory: string | null;
}

/** What a row needs to open a terminal. Chores and learnings carry sessions differently. */
export interface TerminalTarget {
  scope: Scope;
  kind: 'chore' | 'learning' | 'new';
  newKind?: 'learning' | 'chore';
  agent: AgentKind;
  filename: string;
  title: string;
  sessionId: string;
  directory: string;
  learningTitle?: string;
  choreTitle?: string;
  choreDescription?: string;
}

export interface TerminalTicket {
  terminalId: string;
  ticket: string;
  agent: AgentKind;
  sessionId: string | null;
  cwd: string;
  filename?: string | null;
  filePath?: string | null;
  warnings: { code: string; message: string }[];
}

export interface PersonalMeta {
  track?: string | null;
  subtype?: string | null;
  topic?: string | null;
  outcome?: string | null;
  confidence?: string | null;
  mode?: string | null;
  hintsUsed?: string | null;
}

export interface Learning {
  scope: Scope;
  filename: string;
  title: string;
  summary: string;
  keywords: string[];
  indexed: boolean;
  indexDate: string | null;
  directory: string | null;
  sessions: SessionRef[];
  active: boolean;
  mtime: string;
  mtimeMs: number;
  size: number;
  meta: PersonalMeta;
  _score?: number;
  matchedFields?: string[];
}

export interface ChoreSections {
  done: string[];
  happening: string[];
  pending: string[];
}

export interface Chore {
  scope: Scope;
  filename: string;
  title: string;
  summary: string;
  keywords: string[];
  indexed: boolean;
  sessionIds: string[];
  sessions: SessionRef[];
  directory: string | null;
  indexDate: string | null;
  sections: ChoreSections;
  progress: { done: number; happening: number; pending: number };
  mtime: string;
  mtimeMs: number;
  size: number;
  _score?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export interface FileContent {
  scope: string;
  filename: string;
  path: string;
  title: string;
  content: string;
  mtime: string;
  size: number;
  sections?: ChoreSections;
}

export interface ProgressReport {
  kind: 'markdown' | 'html';
  name: string;
  path: string;
  mtime: string;
  content?: string;
  url?: string;
}
