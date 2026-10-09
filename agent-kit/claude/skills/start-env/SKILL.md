---
name: start-env
description: Spin up (or reuse) a composed environment for this session from a natural-language instruction or a ticket/issue URL — picks the recipe and params, shows devboard's plan (what is reused, built, destroyed), asks about every judgement call, then has devboard build only the missing parts and binds the environment to this session. Use when the user runs /start-env <instruction>, or asks to get an environment ready to reproduce an issue or test a behaviour.
---

# /start-env

The procedure is agent-neutral and lives in **`~/.agents/specs/env-agent.md`**. Read it in full now
(and `~/.agents/specs/environments.md`, the contract), then follow its `/start-env` section with the
instruction you received. Don't work from memory of an older version of this skill.
