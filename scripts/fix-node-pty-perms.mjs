/**
 * node-pty ships its macOS/Linux `spawn-helper` inside `prebuilds/` without the execute bit
 * (the prebuild tarball loses the mode). Without +x every `pty.spawn` fails with a bare
 * "posix_spawnp failed", which is a miserable thing to debug. Re-apply it after every install.
 *
 * Safe to run anywhere: if node-pty isn't installed, or there are no helpers, it does nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');

let fixed = 0;
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    let st;
    try {
      st = fs.statSync(helper);
    } catch {
      continue; // windows prebuilds have no spawn-helper
    }
    if (st.mode & 0o111) continue; // already executable
    fs.chmodSync(helper, 0o755);
    fixed++;
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err; // node-pty not installed yet — fine
}

if (fixed) console.log(`[devboard] made ${fixed} node-pty spawn-helper(s) executable`);
