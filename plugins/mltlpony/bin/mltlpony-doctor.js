#!/usr/bin/env node
'use strict';

/**
 * mltlpony-doctor.js — inventory of Claude Code harness utilities plus a
 * static lint for patterns that fail silently. Reads settings, skills, agents
 * and installed plugins; never runs a hook and never writes anything.
 *
 * Usage: mltlpony-doctor.js [--json] [--project <dir>]
 *
 * Lint rules (one code each, so a group can count them):
 *   TOOL_INPUT_ENV    command reads $TOOL_INPUT / $TOOL_* — Claude Code passes
 *                     hook input as JSON on stdin, so these are always empty.
 *   NO_TIMEOUT        no timeout: a stuck hook can hang the turn.
 *   MISSING_SCRIPT    the script the command runs does not exist.
 *   STDOUT_TO_MODEL   (warn) echo/print on SessionStart or UserPromptSubmit,
 *                     whose stdout is added to the model's context.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function listNames(dir, pick) {
  try { return fs.readdirSync(dir).filter((n) => pick(path.join(dir, n), n)).sort(); } catch (e) { return []; }
}

const isSkill = (p) => fs.existsSync(path.join(p, 'SKILL.md'));
const isAgent = (p, n) => n.endsWith('.md');

// Every hook command in one settings-style `hooks` object.
function hooksOf(hooks, source, root) {
  const out = [];
  for (const [event, groups] of Object.entries(hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks || []) {
        if (h.type !== 'command' || typeof h.command !== 'string') continue;
        out.push({ source, event, matcher: g.matcher || '', command: h.command, timeout: h.timeout, root });
      }
    }
  }
  return out;
}

// First argument that looks like a script path, with ${CLAUDE_PLUGIN_ROOT} resolved.
function scriptPath(cmd, root) {
  const expanded = cmd.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, root || '\0');
  const m = expanded.match(/(?:^|[\s"'])((?:~|\/)[^\s"';|&]+\.(?:js|cjs|mjs|py|sh|rb|ts))/);
  if (!m || m[1].includes('\0')) return null;
  return m[1].replace(/^~/, os.homedir());
}

function lint(h) {
  const findings = [];
  if (/\$\{?TOOL_[A-Z_]+/.test(h.command)) findings.push({ code: 'TOOL_INPUT_ENV', level: 'error' });
  if (h.timeout == null) findings.push({ code: 'NO_TIMEOUT', level: 'warn' });
  const script = scriptPath(h.command, h.root);
  if (script && !fs.existsSync(script)) findings.push({ code: 'MISSING_SCRIPT', level: 'error', detail: script });
  if (/^(SessionStart|UserPromptSubmit)$/.test(h.event) && /\b(echo|printf|print\()/.test(h.command) && !/>>?\s*\S/.test(h.command)) {
    findings.push({ code: 'STDOUT_TO_MODEL', level: 'warn' });
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const pi = argv.indexOf('--project');
  const project = path.resolve(pi !== -1 ? argv[pi + 1] : process.cwd());

  const settingsFiles = [
    path.join(CLAUDE_DIR, 'settings.json'),
    path.join(CLAUDE_DIR, 'settings.local.json'),
    path.join(project, '.claude', 'settings.json'),
    path.join(project, '.claude', 'settings.local.json'),
  ];
  let hooks = [];
  const enabledPlugins = new Set();
  for (const f of settingsFiles) {
    const s = readJson(f);
    if (!s) continue;
    hooks = hooks.concat(hooksOf(s.hooks, f, null));
    for (const [id, on] of Object.entries(s.enabledPlugins || {})) if (on) enabledPlugins.add(id);
  }

  // Hooks shipped by installed, enabled plugins.
  const installed = (readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const plugins = [];
  for (const [id, installs] of Object.entries(installed)) {
    const inst = (installs || [])[0];
    if (!inst) continue;
    plugins.push({ id, version: inst.version, enabled: enabledPlugins.has(id) });
    if (!enabledPlugins.has(id)) continue;
    const manifest = readJson(path.join(inst.installPath, '.claude-plugin', 'plugin.json')) || {};
    const hooksFile = path.join(inst.installPath, typeof manifest.hooks === 'string' ? manifest.hooks : 'hooks/hooks.json');
    const hj = readJson(hooksFile);
    if (hj) hooks = hooks.concat(hooksOf(hj.hooks, `plugin:${id}`, inst.installPath));
  }

  for (const h of hooks) h.findings = lint(h);

  const report = {
    generatedAt: new Date().toISOString(),
    project,
    plugins,
    skills: { user: listNames(path.join(CLAUDE_DIR, 'skills'), isSkill), project: listNames(path.join(project, '.claude', 'skills'), isSkill) },
    agents: { user: listNames(path.join(CLAUDE_DIR, 'agents'), isAgent), project: listNames(path.join(project, '.claude', 'agents'), isAgent) },
    hooks: hooks.map(({ root, ...h }) => h),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const n = (a) => a.length;
    console.log(`Plugins: ${plugins.map((p) => `${p.id} v${p.version}${p.enabled ? '' : ' (disabled)'}`).join(', ') || 'none'}`);
    console.log(`Skills: ${n(report.skills.user)} user, ${n(report.skills.project)} project. Agents: ${n(report.agents.user)} user, ${n(report.agents.project)} project.`);
    console.log(`Hooks: ${hooks.length}`);
    for (const h of hooks) {
      const flags = h.findings.map((f) => `${f.level.toUpperCase()} ${f.code}${f.detail ? ` (${f.detail})` : ''}`).join('; ');
      console.log(`  ${h.event}${h.matcher ? `[${h.matcher}]` : ''} ← ${path.basename(h.source)}: ${h.command.slice(0, 70)}${h.command.length > 70 ? '…' : ''}`);
      if (flags) console.log(`      ${flags}`);
    }
    const all = hooks.flatMap((h) => h.findings);
    const errors = all.filter((f) => f.level === 'error').length;
    console.log(`${errors} error(s), ${all.length - errors} warning(s).`);
  }
  process.exit(hooks.some((h) => h.findings.some((f) => f.level === 'error')) ? 2 : 0);
}

main();
