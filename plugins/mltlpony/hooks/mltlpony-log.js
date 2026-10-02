#!/usr/bin/env node
'use strict';

// mltlpony-log.js — standalone event logger, independent of ponytail.
// Reads a Claude Code hook JSON payload from stdin and appends one JSON
// line to a per-session log. MUST be silent on stdout and MUST always
// exit 0 — hook stdout is injected into the conversation, and a nonzero
// exit or a thrown error would break the turn. No git, no network, no
// model calls.
//
// Base dir override for tests: MLTLPONY_HOME env var (defaults to
// ~/.local/share/mltlpony). Never write elsewhere.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{10,}/g,
  /\bghp_[a-zA-Z0-9]{20,}/g,
  /\bgithub_pat_[a-zA-Z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bbearer\s+[a-zA-Z0-9._-]{20,}\b/gi,
  /\bxox[bpaors]-[a-zA-Z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+/g,
  /\b(password|passwd|pwd|token|secret|api[_-]?key)(\s*[=:]\s*)[^\s'"&]+/gi,
];
const KV_SECRET = SECRET_PATTERNS[SECRET_PATTERNS.length - 1];
const MAX_PROMPT_LEN = 4000;

// Returns { text, count } so each event records that redaction fired.
function redact(text) {
  let out = text;
  let count = 0;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => {
      count++;
      // key=value: keep the key so the event stays readable.
      return re === KV_SECRET ? `${m[1]}${m[2]}[REDACTED]` : '[REDACTED]';
    });
  }
  return { text: out, count };
}

// ponytail's live level: plain-text flag file, absent = off
// (ponytail hooks/ponytail-runtime.js). The file is global, not per-session.
function readLevel() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return fs.readFileSync(path.join(dir, '.ponytail-active'), 'utf8').trim() || null;
  } catch (e) {
    return null;
  }
}

// Simple, stated heuristic: slash commands are their own kind (mode
// switches are the level-change signal); pasted/boilerplate if very long or mostly log
// lines (timestamps/stack frames).
function classifyKind(prompt) {
  if (!prompt) return 'unknown';
  if (/^\s*\//.test(prompt)) return 'command';
  if (prompt.length > 2000) return 'pasted/boilerplate';
  const logLineCount = (prompt.match(/^\s*(\d{4}-\d{2}-\d{2}|\s*at\s|Traceback)/gm) || []).length;
  if (logLineCount >= 3) return 'pasted/boilerplate';
  return 'authored';
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
    const data = JSON.parse(raw);
    const base = process.env.MLTLPONY_HOME || path.join(os.homedir(), '.local', 'share', 'mltlpony');
    const eventsDir = path.join(base, 'events');
    fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
    fs.chmodSync(eventsDir, 0o700);

    // session_id becomes a filename: never let it carry path separators.
    const sessionId = String(data.session_id || 'unknown-session').replace(/[^\w-]/g, '_');
    const originalLen = typeof data.prompt === 'string' ? data.prompt.length : 0;
    const red = typeof data.prompt === 'string' ? redact(data.prompt) : null;
    const promptRedacted = red ? red.text.slice(0, MAX_PROMPT_LEN) : undefined;

    const event = {
      ts: new Date().toISOString(),
      event: data.hook_event_name || 'unknown',
      session: sessionId,
      cwd: data.cwd || null,
      transcript_path: data.transcript_path || null,
      prompt: promptRedacted,
      promptLen: originalLen || undefined,
      kind: promptRedacted !== undefined ? classifyKind(data.prompt) : undefined,
      redacted: red && red.count ? red.count : undefined,
      agent_type: data.agent_type || undefined,
      // SessionStart: startup|resume|clear|compact. ponytail resets the level
      // to the default on resume/compact, so a mid-session switch is lost there.
      source: data.source || undefined,
      // On UserPromptSubmit this may be the level from before a /ponytail
      // switch in the same prompt: hooks run in parallel with mode-tracker.
      level: readLevel(),
      level_shared: true,
    };

    const file = path.join(eventsDir, `${sessionId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch (err) {
    // Swallow everything. Never print, never throw past this point.
  }
  process.exit(0);
}

main();
