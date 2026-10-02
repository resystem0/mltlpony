---
description: Inventory your hooks, skills, agents and plugins, and lint hooks for patterns that fail silently
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/mltlpony-doctor.js"`

Summarize the report above. For each ERROR or WARN, say in one line what breaks and the smallest fix (hook `timeout` is in seconds; 5–30 is typical) (for TOOL_INPUT_ENV: read the JSON on stdin, e.g. `jq -r '.tool_input.file_path'`). Do not edit any settings unless the user asks.
