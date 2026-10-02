#!/usr/bin/env node
'use strict';

/**
 * mltlpony-debt.js — persistent, cross-repo ponytail debt ledger.
 *
 * Greps a list of repos for `ponytail:` markers (upstream's convention,
 * `skills/ponytail-debt/SKILL.md`: `(#|//) ?ponytail:`), ages them with
 * `git blame`, diffs against the previous run's snapshot, and writes a
 * markdown ledger into a fenced region plus a `debt` section of
 * dashboard.json.
 *
 * Zero dependencies. Node >= 16 (uses fs, path, crypto, child_process).
 *
 * Marker identity is (repo, file, hash(marker text)) — NOT line number,
 * because line numbers shift with every edit.
 *
 * Usage:
 *   mltlpony-debt.js [repo...] [--out <path>] [--state <dir>]
 *
 * Exit codes: 0 OK, 1 nothing to do, 2 partial (some repos skipped; their
 * markers are carried over unchanged, never reported as vanished).
 *
 * Vanished markers stay in the snapshot until acknowledged in
 * ~/.config/mltlpony.json: { "acks": { "<marker id>": "paid" | "deleted" } }.
 *
 * Repos come from CLI args, or from `repos` in ~/.config/mltlpony.json if
 * no repo args are given. This is mltlpony's OWN config file — it never
 * reads or writes ponytail's config.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DEFAULT_CONFIG = process.env.MLTLPONY_CONFIG || path.join(HOME, '.config', 'mltlpony.json');
// Outside the plugin dir: a plugin update replaces its own folder.
const DEFAULT_OUT = path.join(HOME, '.local', 'share', 'mltlpony', 'out', 'ponytail-debt.md');
const DEFAULT_DASHBOARD = path.join(HOME, '.local', 'share', 'mltlpony', 'out', 'dashboard.json');
const DEFAULT_STATE_DIR = path.join(HOME, '.local', 'share', 'mltlpony', 'state');
const FENCE_BEGIN = '<!-- mltlpony:begin -->';
const FENCE_END = '<!-- mltlpony:end -->';
const SCHEMA_VERSION = 1;

// Matches upstream's `(#|//) ?ponytail:` prefix plus block comments
// (upstream #811/#815/#872), then an optional `[rung]` tag, then the
// free-text ceiling/upgrade part.
const GREP_RE = '(#|//|/\\*) ?ponytail:';
const MARKER_RE = /(?:#|\/\/|\/\*)\s?ponytail:\s*(?:\[(\w+)\]\s*)?(.*?)\s*(?:\*\/)?$/;

function parseArgs(argv) {
  const out = { repos: [], out: DEFAULT_OUT, stateDir: DEFAULT_STATE_DIR, dashboard: DEFAULT_DASHBOARD };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out.out = argv[++i]; }
    else if (a === '--state') { out.stateDir = argv[++i]; }
    else if (a === '--dashboard') { out.dashboard = argv[++i]; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else { out.repos.push(a); }
  }
  return out;
}

function loadConfig() {
  try {
    const json = JSON.parse(fs.readFileSync(DEFAULT_CONFIG, 'utf8'));
    return {
      repos: Array.isArray(json.repos) ? json.repos : [],
      acks: json.acks && typeof json.acks === 'object' ? json.acks : {},
      ignoreDirs: Array.isArray(json.ignoreDirs) ? json.ignoreDirs : [],
    };
  } catch (err) {
    // No config, bad JSON, etc. — fall through to empty.
    return { repos: [], acks: {}, ignoreDirs: [] };
  }
}

// Markdown table cell: a pipe or newline in marker text would break the row.
function cell(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // git grep exits 1 when there are no matches — that's not an error.
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

function isGitRepo(repoPath) {
  try {
    run('git', ['rev-parse', '--is-inside-work-tree'], repoPath);
    return true;
  } catch (err) {
    return false;
  }
}

// Directory names to skip at any depth: `ignoreDirs` in the config.
let IGNORED_DIR_NAMES = new Set();

function grepMarkers(repoPath) {
  const output = run('git', ['grep', '-n', '-E', GREP_RE], repoPath);
  const lines = output.split('\n').filter(Boolean);
  const markers = [];
  for (const line of lines) {
    // git grep -n format: <file>:<lineno>:<text>
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNoStr, text] = m;
    if (file.split(path.sep).some((seg) => IGNORED_DIR_NAMES.has(seg))) continue;
    const markerMatch = text.match(MARKER_RE);
    if (!markerMatch) continue;
    const [, rung, rest] = markerMatch;
    const trimmedRest = rest.trim();
    let ceiling = trimmedRest;
    let upgrade = '';
    const commaIdx = trimmedRest.indexOf(',');
    if (commaIdx !== -1) {
      ceiling = trimmedRest.slice(0, commaIdx).trim();
      upgrade = trimmedRest.slice(commaIdx + 1).trim();
    }
    const noTrigger = upgrade.length === 0;
    const markerText = text.trim();
    markers.push({
      repo: repoPath,
      file,
      line: Number(lineNoStr),
      text: markerText,
      rung: rung || null,
      ceiling,
      upgrade,
      noTrigger,
      id: sha1(`${repoPath}::${file}::${markerText}`),
    });
  }
  return markers;
}

function blameAge(repoPath, file, line) {
  try {
    const out = run('git', ['blame', '--porcelain', '-L', `${line},${line}`, '--', file], repoPath);
    const authorTimeMatch = out.match(/^author-time (\d+)/m);
    const authorMatch = out.match(/^author (.+)$/m);
    const shaMatch = out.match(/^([0-9a-f]{7,40})\s/);
    if (!authorTimeMatch) return null;
    const ts = Number(authorTimeMatch[1]) * 1000;
    const ageDays = Math.floor((Date.now() - ts) / 86400000);
    return {
      commit: shaMatch ? shaMatch[1].slice(0, 12) : null,
      author: authorMatch ? authorMatch[1] : null,
      date: new Date(ts).toISOString().slice(0, 10),
      ageDays,
    };
  } catch (err) {
    return null;
  }
}

function findRemovalCommit(repoPath, file, markerText) {
  try {
    // -S pickaxe: find the commit that changed the marker's occurrence count
    // (i.e. removed the exact string). Search the whole history for `file`;
    // if the file itself was deleted this still finds the last touch.
    const out = run('git', ['log', '-S', markerText, '--oneline', '-n', '3', '--', file], repoPath);
    const first = out.split('\n').filter(Boolean)[0];
    if (!first) return null;
    const [hash, ...rest] = first.split(' ');
    return { commit: hash, subject: rest.join(' ') };
  } catch (err) {
    return null;
  }
}

function loadPreviousSnapshot(stateDir) {
  const file = path.join(stateDir, 'debt.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { schemaVersion: SCHEMA_VERSION, markers: {} };
  }
}

function saveSnapshot(stateDir, snapshot) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'debt.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, file);
}

function writeFenced(outPath, body) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let existing = '';
  try {
    existing = fs.readFileSync(outPath, 'utf8');
  } catch (err) {
    // File doesn't exist yet — start fresh.
  }
  const beginIdx = existing.indexOf(FENCE_BEGIN);
  const endIdx = existing.indexOf(FENCE_END);
  let next;
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + FENCE_END.length);
    next = `${before}${FENCE_BEGIN}\n${body}\n${FENCE_END}${after}`;
  } else {
    // No fence yet: create the file with the fence, preserving anything
    // that was already there above it.
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? existing + '\n' : existing;
    next = `${prefix}${FENCE_BEGIN}\n${body}\n${FENCE_END}\n`;
  }
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, outPath);
}

function updateDashboard(dashboardPath, debtSection) {
  fs.mkdirSync(path.dirname(dashboardPath), { recursive: true });
  let dashboard = { schemaVersion: SCHEMA_VERSION };
  try {
    dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));
  } catch (err) {
    // Fresh dashboard.json.
  }
  dashboard.schemaVersion = dashboard.schemaVersion || SCHEMA_VERSION;
  dashboard.debt = debtSection;
  const tmp = dashboardPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dashboard, null, 2));
  fs.renameSync(tmp, dashboardPath);
}

function buildLedgerMarkdown(currentMarkers, vanished, skipped = []) {
  const lines = [];
  const byRepo = new Map();
  for (const m of currentMarkers) {
    if (!byRepo.has(m.repo)) byRepo.set(m.repo, []);
    byRepo.get(m.repo).push(m);
  }

  const totalMarkers = currentMarkers.length;
  const noTriggerCount = currentMarkers.filter((m) => m.noTrigger).length;
  lines.push(`_Generated ${new Date().toISOString()}. ${totalMarkers} markers, ${noTriggerCount} with no trigger._`);
  lines.push('');

  if (totalMarkers === 0) {
    lines.push('No `ponytail:` debt. Clean ledger.');
  } else {
    for (const [repo, markers] of byRepo) {
      lines.push(`### ${path.basename(repo)}`);
      lines.push('');
      lines.push('| file:line | rung | ceiling | upgrade | age | rot |');
      lines.push('|---|---|---|---|---|---|');
      for (const m of markers) {
        let age = m.blame ? `${m.blame.ageDays}d (${m.blame.author || 'unknown'})` : 'unknown';
        if (m.carried) age += ' [repo skipped, last known]';
        const rot = m.noTrigger ? 'no-trigger' : '';
        lines.push(`| ${cell(m.file)}:${m.line} | ${cell(m.rung)} | ${cell(m.ceiling)} | ${cell(m.upgrade)} | ${cell(age)} | ${rot} |`);
      }
      lines.push('');
    }
  }

  if (vanished.length > 0) {
    lines.push('### Vanished (unacknowledged)');
    lines.push('');
    lines.push('_Paid off or silently deleted — not auto-classified. Ack by id in `~/.config/mltlpony.json` `acks` to clear._');
    lines.push('');
    lines.push('| id | repo | file | marker | vanished | removed in |');
    lines.push('|---|---|---|---|---|---|');
    for (const v of vanished) {
      const removal = v.removal ? `${v.removal.commit} ${v.removal.subject}` : 'unknown (history search found nothing)';
      lines.push(`| ${v.id} | ${cell(path.basename(v.repo))} | ${cell(v.file)} | ${cell(v.text)} | ${(v.vanishedAt || '').slice(0, 10)} | ${cell(removal)} |`);
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push(`_Skipped (not a git repo or missing; markers carried over): ${skipped.map((r) => path.basename(r)).join(', ')}._`);
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: mltlpony-debt.js [repo...] [--out <path>] [--state <dir>] [--dashboard <path>]');
    process.exit(0);
  }

  const config = loadConfig();
  IGNORED_DIR_NAMES = new Set(config.ignoreDirs);
  let repos = args.repos.length > 0 ? args.repos : config.repos;
  repos = repos.map((r) => path.resolve(r));

  if (repos.length === 0) {
    console.error('No repos given and none found in ~/.config/mltlpony.json ("repos" array). Nothing to do.');
    process.exit(1);
  }

  const previous = loadPreviousSnapshot(args.stateDir);
  const previousMarkers = previous.markers || {};

  const currentMarkers = [];
  const skipped = [];
  for (const repoPath of repos) {
    if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) {
      console.error(`Skipping ${repoPath}: missing or not a git repository.`);
      skipped.push(repoPath);
      continue;
    }
    const markers = grepMarkers(repoPath);
    for (const m of markers) {
      const blame = blameAge(repoPath, m.file, m.line);
      m.blame = blame;
      currentMarkers.push(m);
    }
  }

  const now = new Date().toISOString();
  const currentIds = new Set(currentMarkers.map((m) => m.id));
  const skippedSet = new Set(skipped);
  const nextSnapshot = { schemaVersion: SCHEMA_VERSION, generatedAt: now, markers: {} };
  const vanished = [];
  for (const [id, prev] of Object.entries(previousMarkers)) {
    if (currentIds.has(id)) continue;
    // A skipped repo tells us nothing: carry its markers over unchanged.
    if (skippedSet.has(prev.repo)) {
      nextSnapshot.markers[id] = prev;
      if (prev.status === 'vanished') vanished.push({ id, ...prev });
      else currentMarkers.push({ id, ...prev, carried: true });
      continue;
    }
    // Acknowledged (paid/deleted) by hand: drop from the snapshot for good.
    if (config.acks[id]) continue;
    // Vanished markers persist until acked, so a missed run loses nothing.
    const v = prev.status === 'vanished'
      ? prev
      : { ...prev, status: 'vanished', vanishedAt: now, removal: findRemovalCommit(prev.repo, prev.file, prev.text) };
    nextSnapshot.markers[id] = v;
    vanished.push({ id, ...v });
  }

  for (const m of currentMarkers) {
    if (m.carried) continue;
    nextSnapshot.markers[m.id] = {
      repo: m.repo,
      file: m.file,
      line: m.line,
      text: m.text,
      rung: m.rung,
      ceiling: m.ceiling,
      upgrade: m.upgrade,
      noTrigger: m.noTrigger,
      blame: m.blame,
    };
  }

  const ledgerBody = buildLedgerMarkdown(currentMarkers, vanished, skipped);
  writeFenced(args.out, ledgerBody);
  saveSnapshot(args.stateDir, nextSnapshot);
  updateDashboard(args.dashboard, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nextSnapshot.generatedAt,
    totalMarkers: currentMarkers.length,
    noTriggerCount: currentMarkers.filter((m) => m.noTrigger).length,
    vanishedCount: vanished.length,
    markers: currentMarkers.map((m) => ({
      id: m.id,
      repo: m.repo,
      file: m.file,
      line: m.line,
      rung: m.rung,
      ceiling: m.ceiling,
      upgrade: m.upgrade,
      noTrigger: m.noTrigger,
      blame: m.blame,
    })),
    vanished: vanished.map((v) => ({
      id: v.id,
      repo: v.repo,
      file: v.file,
      text: v.text,
      vanishedAt: v.vanishedAt,
      removal: v.removal,
    })),
    skipped,
  });

  console.log(`mltlpony-debt: ${currentMarkers.length} markers across ${repos.length} repo(s), ${vanished.length} vanished since last run.`);
  console.log(`Ledger: ${args.out}`);
  console.log(`Dashboard: ${args.dashboard}`);
  console.log(`State: ${path.join(args.stateDir, 'debt.json')}`);
  if (skipped.length > 0) process.exit(2);
}

// Exported so other scripts can call these directly instead of shelling out.
module.exports = { loadConfig, grepMarkers, blameAge, buildLedgerMarkdown };

if (require.main === module) main();
