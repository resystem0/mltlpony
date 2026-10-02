---
description: Update the cross-repo ponytail: debt ledger (repos from ~/.config/mltlpony.json)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/mltlpony-debt.js" $ARGUMENTS 2>&1`

Report the marker count, any vanished markers with their removing commit, and any skipped repos. The ledger is at ~/.local/share/mltlpony/out/ponytail-debt.md.
