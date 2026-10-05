# End Chore Spec

Close an ephemeral chore by deleting its file and removing its `index.txt` row.

Before deletion:

- Read the chore file.
- If work is still pending or happening, confirm before closing.
- If the chore produced durable knowledge, offer to run the handoff flow first.

Delete only the selected chore file and only its matching index row. Do not delete another live
session's chore without explicit confirmation.
