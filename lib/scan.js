/*
 * Scanning.
 *
 * Two modes:
 *   scanStaged()  - what git is about to commit (used by the hook)
 *   scanFiles()   - the working tree (used by "commitguard scan")
 *
 * Staged mode reads blobs out of the index with `git show :file`, not from
 * disk. That distinction matters: if you edit a file after `git add`, the
 * commit still carries the older content, and that is what has to be checked.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RULES, entropy, isPlaceholder } = require("./rules");

const SKIP_DIRS = [
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".cache", "target",
];

const SKIP_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z", ".mp4", ".mkv", ".mp3", ".wav",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".exe", ".dll", ".so", ".dylib",
  ".class", ".jar", ".pyc", ".pdb", ".bin", ".wasm",
];

const SKIP_FILES = [
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "Gemfile.lock", "poetry.lock", "cargo.lock",
];

const ENV_FILE = /(^|[\\/])\.env(\.|$)/i;
const ENV_ALLOWED = /\.env\.(example|sample|template|dist)$/i;
const INLINE_ALLOW = /commitguard[- ]?ignore/i;
const MAX_SIZE = 2 * 1024 * 1024; // files larger than 2 MB are skipped

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function isGitRepo(cwd) {
  try {
    git(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch (err) {
    return false;
  }
}

/** A NUL byte means the blob is not text. */
function isBinary(content) {
  return content.includes("\0");
}

function shouldSkip(filePath) {
  const parts = filePath.split(/[\\/]/);
  if (parts.some((p) => SKIP_DIRS.includes(p))) return true;

  const name = parts[parts.length - 1];
  if (SKIP_FILES.includes(name)) return true;
  if (/\.min\.(js|css)$/i.test(name)) return true;
  if (/\.map$/i.test(name)) return true;

  return SKIP_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

/** .commitguardignore: one path or simple glob per line. */
function readIgnoreList(root) {
  const file = path.join(root, ".commitguardignore");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function isIgnored(filePath, patterns) {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const p = pattern.replace(/\\/g, "/");
    if (p.includes("*")) {
      const re = new RegExp(
        "^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
      );
      return re.test(normalized);
    }
    return normalized === p || normalized.startsWith(p.replace(/\/$/, "") + "/");
  });
}

/** Never print a full credential - the terminal scrollback is not a safe place. */
function mask(value) {
  if (value.length <= 8) return value[0] + "*".repeat(Math.max(1, value.length - 1));
  return value.slice(0, 4) + "*".repeat(Math.min(12, value.length - 8)) + value.slice(-4);
}

/** Runs every rule over a blob of text. */
function scanText(filePath, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    if (INLINE_ALLOW.test(line)) continue;

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        const value = match[1] || match[0];
        if (rule.entropy) {
          if (isPlaceholder(value)) continue;
          if (entropy(value) < 3.2) continue;
        }
        findings.push({
          file: filePath,
          line: i + 1,
          column: match.index + 1,
          rule: rule.id,
          title: rule.title,
          fix: rule.fix,
          masked: mask(value),
          // The preview must be redacted too - otherwise the secret ends up in
          // terminal scrollback and CI logs, which is exactly what we are
          // trying to avoid.
          preview: line.trim().split(value).join(mask(value)).slice(0, 120),
        });
        if (!rule.pattern.global) break;
      }
    }
  }

  return findings;
}

/** Files that should never be committed, whatever is inside them. */
function fileLevelFinding(filePath) {
  const name = filePath.replace(/\\/g, "/");

  if (ENV_FILE.test(name) && !ENV_ALLOWED.test(name)) {
    return {
      file: filePath,
      line: 0,
      column: 0,
      rule: "env-file",
      title: "Environment file staged for commit",
      fix: "Add it to .gitignore and commit a .env.example with empty values instead.",
      masked: "",
      preview: "",
    };
  }

  if (/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(name) ||
      /\.(pem|pfx|p12|keystore|jks)$/i.test(name)) {
    return {
      file: filePath,
      line: 0,
      column: 0,
      rule: "key-file",
      title: "Key or certificate file staged for commit",
      fix: "Keep key material outside the repository and add this path to .gitignore.",
      masked: "",
      preview: "",
    };
  }

  return null;
}

/** Scans what is in the git index - the content the commit will contain. */
function scanStaged(root) {
  if (!isGitRepo(root)) {
    const err = new Error("not a git repository");
    err.code = "NOT_GIT";
    throw err;
  }

  const output = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"], root);
  const files = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const ignores = readIgnoreList(root);

  const findings = [];
  let scanned = 0;

  for (const file of files) {
    if (isIgnored(file, ignores)) continue;

    const fileFinding = fileLevelFinding(file);
    if (fileFinding) findings.push(fileFinding);

    if (shouldSkip(file)) continue;

    let content;
    try {
      content = git(["show", ":" + file], root);
    } catch (err) {
      continue; // deleted or unreadable index entry
    }
    if (content.length > MAX_SIZE || isBinary(content)) continue;

    scanned++;
    findings.push.apply(findings, scanText(file, content));
  }

  return { findings, scanned, totalFiles: files.length };
}

/** Scans the working tree. Does not need git. */
function scanFiles(root) {
  const ignores = readIgnoreList(root);
  const findings = [];
  let scanned = 0;

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, "/");

      if (isIgnored(relative, ignores)) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const fileFinding = fileLevelFinding(relative);
      if (fileFinding) findings.push(fileFinding);

      if (shouldSkip(relative)) continue;

      let stat;
      try {
        stat = fs.statSync(full);
      } catch (err) {
        continue;
      }
      if (stat.size > MAX_SIZE) continue;

      let content;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch (err) {
        continue;
      }
      if (isBinary(content)) continue;

      scanned++;
      findings.push.apply(findings, scanText(relative, content));
    }
  }

  return { findings, scanned, totalFiles: scanned };
}

module.exports = {
  scanStaged,
  scanFiles,
  scanText,
  fileLevelFinding,
  shouldSkip,
  isIgnored,
  mask,
  isGitRepo,
};
