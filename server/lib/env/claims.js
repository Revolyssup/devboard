/**
 * Claim expansion and conflict derivation.
 *
 * Layers never name the layers they conflict with. They declare what they *claim*, and conflict
 * falls out of overlap. The point is maintenance cost: when something believed orthogonal turns
 * out to collide, the fix is one claim on one layer and every pairwise relationship updates for
 * free. A pairwise compatibility matrix would be O(n^2) and would go stale on every addition.
 *
 * Claim syntax: <domain>:<path>, '*' is a wildcard within a path segment, ${param} interpolates.
 *   cluster:*\/ns:istio-system
 *   cluster:*\/crd:*.install.xcp.tetrate.io
 *   tsb:workspace:${workspace}
 */

/** Substitute ${param} from a params object. Unresolved params become '*' (widest, safest). */
export function interpolate(claim, params = {}) {
  return claim.replace(/\$\{(\w+)\}/g, (_, name) => {
    const v = params[name];
    return v === undefined || v === null || v === '' ? '*' : String(v);
  });
}

export function expandClaims(layer, params = {}) {
  const map = (list) => (list || []).map((c) => interpolate(c, params));
  return {
    exclusive: map(layer.claims?.exclusive),
    shared: map(layer.claims?.shared),
    writes: map(layer.claims?.writes),
  };
}

/** '*' matches any run of characters other than the '/' separator. */
function toRegex(claim) {
  const escaped = claim.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Two claim strings overlap if either, read as a pattern, matches the other.
 *
 * Checked symmetrically because both sides may contain wildcards: `cluster:*​/ns:istio-system`
 * from xcp-stack and the identical claim from tsb-controlplane must collide, and
 * `cluster:*​/ns:istio-system` must NOT collide with `cluster:*​/ns:tsb`.
 */
export function claimsOverlap(a, b) {
  if (a === b) return true;
  return toRegex(a).test(b) || toRegex(b).test(a);
}

/**
 * Conflicts between two claim sets.
 *
 * Rules:
 *   - exclusive vs exclusive  -> conflict (only one owner allowed)
 *   - exclusive vs writes     -> conflict (a writer would mutate an owned resource)
 *   - writes vs writes        -> conflict (two mutators of the same resource)
 *   - anything vs shared      -> never a conflict (shared is read/attach only)
 *
 * `shared` is deliberately inert. tsb-config:workspace-A and workspace-B both claim `cluster:*`
 * as shared and only their own `tsb:workspace:<name>` exclusively, so their exclusive sets are
 * disjoint and parallel use is derived rather than asserted.
 */
export function findConflicts(a, b) {
  const out = [];
  const pairs = [
    ['exclusive', 'exclusive'],
    ['exclusive', 'writes'],
    ['writes', 'exclusive'],
    ['writes', 'writes'],
  ];
  for (const [ka, kb] of pairs) {
    for (const ca of a[ka] || []) {
      for (const cb of b[kb] || []) {
        if (claimsOverlap(ca, cb)) {
          out.push({ claim: ca, against: cb, kinds: [ka, kb] });
        }
      }
    }
  }
  // Same claim can be reached via several pairs; report each distinct overlap once.
  const seen = new Set();
  return out.filter((c) => {
    const k = `${c.claim}|${c.against}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
