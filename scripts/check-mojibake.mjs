#!/usr/bin/env node
// Fails on double-encoded UTF-8 ("mojibake"), e.g. an em-dash that was read as
// Windows-1252 and saved back as UTF-8. Copied from pegno-co and adapted for
// this static site: with no argument it scans every tracked .html file in full.
//
// Usage (from the repo root, before committing or pushing):
//   node scripts/check-mojibake.mjs              # every tracked .html file, all lines
//   node scripts/check-mojibake.mjs --staged     # added lines in the staged diff
//   node scripts/check-mojibake.mjs <base-ref>   # added lines in <base>...HEAD
//
// Exit codes: 0 clean, 1 mojibake found, 2 usage/git error.
// No dependencies. This file is ASCII-only: every pattern is a \u escape, so
// the script never contains the sequences it looks for.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Double-encoded UTF-8 signatures. Precise enough not to flag ordinary
// accented text such as "cafe" with an acute accent, "Sao Paulo" with a tilde,
// or a correctly encoded en/em-dash.
const PATTERNS = [
  { name: "a-circumflex + euro sign (mangled punctuation, e.g. em-dash)", re: /\u00e2\u20ac/ },
  { name: "A-tilde + U+0080..U+00BF (mangled accented letter)", re: /\u00c3[\u0080-\u00bf]/ },
  { name: "A-tilde + low-9 quote (symbol encoded three times)", re: /\u00c3\u201a/ },
  { name: "A-circumflex + U+00A0..U+00BF (mangled symbol, e.g. pound or middle dot)", re: /\u00c2[\u00a0-\u00bf]/ },
  { name: "eth + Y-diaeresis (mangled emoji)", re: /\u00f0\u0178/ },
  { name: "a-circumflex + dagger (mangled arrow)", re: /\u00e2\u2020/ },
  { name: "a-circumflex + s-caron (mangled symbol, e.g. lightning)", re: /\u00e2\u0161/ },
  { name: "a-circumflex + low-9 quote (mangled currency/symbol)", re: /\u00e2\u201a/ },
  { name: "U+FFFD replacement character (invalid or lost bytes)", re: /\ufffd/ },
];

// Files that legitimately contain the patterns (or describe them).
const ALLOWLIST = new Set(["scripts/check-mojibake.mjs"]);
const SKIP = [/(^|\/)node_modules\//];

function git(args) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=off", ...args], { maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message;
    console.error(`check-mojibake: git ${args.join(" ")} failed:\n${msg.trim()}`);
    process.exit(2);
  }
}

const hits = [];
let scanned = 0;
function scanLine(file, lineNo, rawText) {
  scanned++;
  const text = rawText.replace(/\r$/, "");
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 30);
      const snippet = text.slice(start, m.index + 40).replace(/\t/g, " ");
      hits.push({ file, line: lineNo, name: p.name, snippet: `${start > 0 ? "..." : ""}${snippet}${m.index + 40 < text.length ? "..." : ""}` });
    }
  }
}

const arg = process.argv[2] || "--all";
let what;
if (arg === "--all") {
  // Whole-file scan of every tracked .html file, read from the working tree.
  const top = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const files = git(["-C", top, "ls-files", "-z", "--", "*.html"]).toString("utf8").split(String.fromCharCode(0)).filter(Boolean);
  for (const file of files) {
    if (ALLOWLIST.has(file) || SKIP.some((re) => re.test(file))) continue;
    // Decode as UTF-8 without throwing: invalid bytes become U+FFFD and are reported.
    readFileSync(`${top}/${file}`).toString("utf8").split("\n").forEach((line, i) => scanLine(file, i + 1, line));
  }
  what = `${files.length} tracked .html file(s)`;
} else {
  const range = arg === "--staged" ? ["--cached"] : [`${arg}...HEAD`];
  if (arg !== "--staged") git(["rev-parse", "--verify", "--quiet", `${arg}^{commit}`]);

  // Binary files show "-\t-" in numstat; skip them.
  const binaries = new Set();
  for (const line of git(["diff", "--numstat", "--no-renames", ...range]).toString("utf8").split("\n")) {
    const m = line.match(/^-\t-\t(.+)$/);
    if (m) binaries.add(m[1]);
  }

  // Decode as UTF-8 without throwing: invalid bytes become U+FFFD and are reported.
  const diff = git(["diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", ...range]).toString("utf8");
  let file = null;
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4);
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && (ALLOWLIST.has(file) || binaries.has(file) || SKIP.some((re) => re.test(file)))) file = null;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("\\")) continue;
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { lineNo = Number(h[1]); continue; }
    if (raw.startsWith("+")) {
      if (file) scanLine(file, lineNo, raw.slice(1));
      lineNo++;
    }
  }
  what = `lines added by ${arg === "--staged" ? "staged changes" : `${arg}...HEAD`}`;
}

if (hits.length) {
  console.error(`check-mojibake: ${hits.length} problem(s) in ${what}:\n`);
  console.error(hits.map((h) => `${h.file}:${h.line}: ${h.name}\n    ${h.snippet}`).join("\n"));
  console.error(
    "\nThese look like double-encoded UTF-8 (text read as Windows-1252 and saved as UTF-8)." +
      "\nCommon cause: Windows PowerShell 5.1 Get-Content/Set-Content without -Encoding utf8." +
      "\nFix the characters in your editor, or re-save the file as UTF-8."
  );
  process.exit(1);
}
console.log(`check-mojibake: OK - ${scanned} line(s) in ${what}, no double-encoded UTF-8.`);
