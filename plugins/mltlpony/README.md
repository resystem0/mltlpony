# mltlpony

Measure your Claude Code harness. mltlpony is a plugin that lives in this
ponytail fork's marketplace. It works with or without ponytail installed.

- **Event logger** (hook): writes one JSON line per session start, prompt, and
  subagent spawn to `~/.local/share/mltlpony/events/<session>.jsonl`. It also
  records the active ponytail level, if there is one.
  - Secrets are redacted before anything is written (API keys, tokens, JWTs,
    private keys, `password=`).
  - The directory is `0700` and the files are `0600`.
  - It never prints, always exits 0, makes no network calls, and has a 5s
    timeout. **Nothing leaves your machine.**
- **`/mltlpony:doctor`** lists your hooks, skills, agents, and plugins, and
  lints hooks for patterns that fail without any error:

  | Code | Meaning |
  |---|---|
  | `TOOL_INPUT_ENV` | The hook reads `$TOOL_INPUT`/`$TOOL_*`. Hook input arrives as JSON on stdin, so these are always empty. |
  | `NO_TIMEOUT` | There's no timeout, so a stuck hook can hang the turn. |
  | `MISSING_SCRIPT` | The script the hook runs doesn't exist. |
  | `STDOUT_TO_MODEL` | (warning) A SessionStart or UserPromptSubmit hook prints, and that output goes into the model's context. |

  The doctor only reads; it never runs a hook. CLI:
  `node bin/mltlpony-doctor.js [--json] [--project <dir>]`, which exits 2 on
  errors.
- **`/mltlpony:debt`** maintains a persistent ledger of `ponytail:` markers
  across repos. It covers `#`, `//`, and `/* */` comments, with ages taken
  from `git blame`. Markers that disappear stay listed until you acknowledge
  them.

## Install

```
/plugin marketplace add resystem0/mltlpony
```
```
/plugin install mltlpony@mltlpony
```
Send them as two separate prompts. Install `ponytail@mltlpony` too if you
want ponytail itself (upstream, unmodified).

## Configure the ledger

`~/.config/mltlpony.json`:

```json
{
  "repos": ["/abs/path/repo1", "/abs/path/repo2"],
  "ignoreDirs": ["vendor"],
  "acks": { "<marker id>": "paid" }
}
```

The output goes to `~/.local/share/mltlpony/out/` (`ponytail-debt.md` and
`dashboard.json`), never into the plugin folder.

Exit codes:
- `0`: OK.
- `2`: partial. A repo is missing or isn't a git repo, so its markers are
  carried over as "last known".

## Event fields

`ts, event, session, cwd, transcript_path, prompt (redacted, ≤4000 chars),
promptLen, kind (authored | command | pasted/boilerplate), redacted,
agent_type, source (startup|resume|clear|compact), level, level_shared`

`level` is read from ponytail's flag file. That file is machine-global, so
when sessions overlap, `level` reflects the last one to switch.

## Uninstall

`/plugin uninstall mltlpony@mltlpony`. Your data stays in
`~/.local/share/mltlpony/` until you delete it.
