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
  /** 'busy' = the agent is working; 'idle' = it finished (or needs input) and is waiting on you.
   * Driven by ~/.claude/hooks' shared notifier signal file — see server/lib/terminals.js. */
  agentState?: 'busy' | 'idle';
  /** Bumped to ask an open (or opening) terminal to switch to its Design view. */
  designNonce?: number;
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

// --- environment composition ------------------------------------------------------------------
// Mirrors ~/.agents/specs/environments.md. `properties` is what a probe OBSERVED, never what was
// declared — the UI must never present a cached belief as fact.

// `pending` = never probed yet; the tree renders from cache and fills these in as probes land.
export type EnvState = 'healthy' | 'degraded' | 'absent' | 'unknown' | 'pending';

export interface EnvLease {
  session: string;
  agent: string;
  directory: string | null;
  acquiredAt: string;
  expiresAt: string;
  live: boolean;
}

export interface EnvNode {
  id: string;
  title: string;
  kind: 'host' | 'runtime' | 'artifact' | 'credential';
  parent: string | null;
  parents: string[];
  requires: string[];
  state: EnvState;
  present: boolean | null;
  healthy: boolean | null;
  /** When this layer was last actually observed. Null means never. */
  probedAt: string | null;
  stale: boolean;
  properties: Record<string, unknown>;
  details: string[];
  errors: string[];
  teardown: 'allowed' | 'never' | 'manual';
  estimateSec: number | null;
  claims: { exclusive: string[]; shared: string[]; writes: string[] };
  instance: { id: string; createdAt: string; leases: EnvLease[] } | null;
  sessions: string[];
}

export interface EnvTree {
  nodes: EnvNode[];
  session?: string | null;
  target?: string | null;
  instructions?: string | null;
  /** Params this environment was bound with — plan/run must use these, not recipe defaults. */
  params?: Record<string, unknown>;
  via?: string | null;
  generatedAt: string;
}

export interface EnvPlanStep {
  layer: string;
  title: string;
  action: 'REUSE' | 'REPAIR' | 'REBUILD' | 'CREATE' | 'TEARDOWN' | 'MANUAL' | 'BLOCKED';
  reason: string;
  parent: string | null;
  details: string[];
  errors: string[];
  requiredBy?: string[];
}

export interface EnvPlan {
  target: string;
  teardown?: boolean;
  steps: EnvPlanStep[];
  warnings?: string[];
  summary: {
    reuse: number;
    create: number;
    rebuild: number;
    repair: number;
    teardown: number;
    manual: number;
    blocked: number;
    destructive: number;
    estimateSec: number;
    estimateIsLowerBound: boolean;
  };
  requiresConfirmation: boolean;
  executable: boolean;
}

export interface EnvRunStep {
  layer: string;
  title: string;
  action: string;
  reason: string;
  status: string;
  exitCode: number | null;
  probeAfter: { state: EnvState; errors: string[] } | null;
  error: string | null;
}

export interface EnvRun {
  id: string;
  target: string;
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
  startedAt: string;
  finishedAt: string | null;
  session: string | null;
  steps: EnvRunStep[];
}

/** A session's bound environment. Cheap index — no probe state, so rows can render it for free. */
export interface EnvBinding {
  session: string;
  agent: string;
  target: string;
  instructions: string | null;
  directory: string | null;
  boundAt: string;
  updatedAt: string;
  /** The environment's root recipe — the broadest thing it stands on. Drives the row icon. */
  root?: { id: string; title: string; icon: string | null } | null;
}

/** A config object a recipe manages. `state` is the drift answer: files vs live cluster. */
export interface EnvResource {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  cluster: string;
  state: 'applied' | 'modified' | 'missing' | 'live-only' | 'unknown';
  file?: string;
}

// --- code ontology (codont) --------------------------------------------------------------------
// Contract: ~/.agents/specs/codont.md. The ontology shape itself lives in lib/codontLayout.ts.

export interface CodontBinding {
  session: string;
  instruction: string;
  cwd: string;
  createdAt: string;
}

export interface CodontTab {
  id: string;
  ref: string | null;
  refResolved: string | null;
  label: string;
  createdAt: string;
  status: { state: 'idle' | 'running' | 'error'; error?: string };
  ontology: {
    schema: number;
    nodes: import('./lib/codontLayout').OntNode[];
    edges: import('./lib/codontLayout').OntEdge[];
    verification: import('./lib/codontLayout').Verification;
  };
}

export interface CodontState {
  binding: CodontBinding;
  context: string;
  /** Append-only audit trail of the agent's updates — what changed, what failed to verify. */
  journal: string;
  tabs: CodontTab[];
  env: { target: string; instructions: string | null } | null;
  envMismatch: { sha: string } | null;
}
