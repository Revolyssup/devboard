#!/bin/bash
# Deterministic stand-in for the claude CLI, selected via DEVBOARD_CLAUDE_BIN.
#
# It exists so the terminal feature can be verified end-to-end without spawning a real session
# (nondeterministic, burns tokens, needs a live transcript). It proves the parts that actually
# matter: argv + cwd plumbing, bidirectional byte flow, SIGWINCH resize, and the
# /end-chore -> file disappears -> auto-close path.
#
# Env:
#   DEVBOARD_FAKE_CHORE_FILE   chore file to delete when /end-chore is read
#   DEVBOARD_FAKE_CHORE_INDEX  index.txt whose matching row is dropped alongside it

echo "FAKE-CLAUDE argv: $*"
echo "FAKE-CLAUDE pwd: $(pwd)"

if [ "$#" -eq 0 ] && [ -n "$DEVBOARD_FAKE_NEW_TRANSCRIPT" ]; then
  mkdir -p "$(dirname "$DEVBOARD_FAKE_NEW_TRANSCRIPT")"
  printf '{"type":"session_meta","payload":{"id":"%s"},"cwd":"%s"}\n' \
    "${DEVBOARD_FAKE_NEW_SESSION_ID:-11111111-2222-4333-8444-555555555555}" "$(pwd)" \
    > "$DEVBOARD_FAKE_NEW_TRANSCRIPT"
fi

emit_size() { echo "SIZE COLS=${COLUMNS:-?} ROWS=${LINES:-?}"; }

# The pty reports its size via ioctl; `stty size` is the portable way to read it back.
read_size() {
  local s
  s=$(stty size 2>/dev/null) || return
  LINES=${s% *}
  COLUMNS=${s#* }
}

read_size
emit_size
trap 'read_size; emit_size' WINCH

echo "FAKE-CLAUDE ready"
printf '> '

while IFS= read -r line; do
  case "$line" in
    *'/end-chore'* | *'/end-personal-chore'*)
      echo "running end-chore flow..."
      if [ -n "$DEVBOARD_FAKE_CHORE_FILE" ] && [ -f "$DEVBOARD_FAKE_CHORE_FILE" ]; then
        rm -f "$DEVBOARD_FAKE_CHORE_FILE"
        base=$(basename "$DEVBOARD_FAKE_CHORE_FILE")
        if [ -n "$DEVBOARD_FAKE_CHORE_INDEX" ] && [ -f "$DEVBOARD_FAKE_CHORE_INDEX" ]; then
          grep -v "$base" "$DEVBOARD_FAKE_CHORE_INDEX" > "$DEVBOARD_FAKE_CHORE_INDEX.tmp" || true
          mv "$DEVBOARD_FAKE_CHORE_INDEX.tmp" "$DEVBOARD_FAKE_CHORE_INDEX"
        fi
      fi
      # Keep printing after the file is gone — this is what makes the client prove it does not
      # close the instant `chore-gone` arrives.
      echo "CHORE ENDED (file + index row removed)"
      sleep 1
      echo "goodbye"
      exit 0
      ;;
    *'/exit'*)
      echo "bye"
      exit 0
      ;;
    *)
      echo "ECHO: $line"
      printf '> '
      ;;
  esac
done
