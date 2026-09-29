/*
 * Installing and removing the pre-commit hook.
 *
 * The hook file is tiny on purpose: it only calls this package. That way an
 * update to commitguard does not require reinstalling the hook, and the file
 * stays readable for whoever opens .git/hooks/pre-commit to see what runs
 * before every commit.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MARKER = "# commitguard";

const HOOK_BODY = `#!/bin/sh
${MARKER} - blocks commits that contain credentials
# Remove with:  npx commitguard uninstall
# Skip once with:  git commit --no-verify

if command -v node >/dev/null 2>&1; then
  node "$(git rev-parse --show-toplevel)/node_modules/commitguard/bin/commitguard.js" check || exit 1
else
  echo "commitguard: node not found, skipping scan" >&2
fi
`;

/** Standalone variant used when the package is not inside node_modules. */
function standaloneBody(entryPath) {
  const posix = entryPath.replace(/\\/g, "/");
  return `#!/bin/sh
${MARKER} - blocks commits that contain credentials
# Remove with:  node "${posix}" uninstall
# Skip once with:  git commit --no-verify

if command -v node >/dev/null 2>&1; then
  node "${posix}" check || exit 1
else
  echo "commitguard: node not found, skipping scan" >&2
fi
`;
}

function hooksDir(root) {
  // Honour core.hooksPath when the project sets one (husky, lefthook, ...).
  let configured = "";
  try {
    configured = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch (err) {
    configured = "";
  }

  if (configured) return path.resolve(root, configured);

  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();

  return path.resolve(root, gitDir, "hooks");
}

function install(root, entryPath) {
  const dir = hooksDir(root);
  fs.mkdirSync(dir, { recursive: true });

  const hookPath = path.join(dir, "pre-commit");
  const insideNodeModules = entryPath.replace(/\\/g, "/").includes("/node_modules/");
  const body = insideNodeModules ? HOOK_BODY : standaloneBody(entryPath);

  if (fs.existsSync(hookPath)) {
    const current = fs.readFileSync(hookPath, "utf8");

    if (current.includes(MARKER)) {
      fs.writeFileSync(hookPath, body, { mode: 0o755 });
      return { status: "updated", hookPath };
    }

    // Somebody else's hook is already here. Keep it, run ours first.
    const backup = hookPath + ".commitguard-backup";
    if (!fs.existsSync(backup)) fs.copyFileSync(hookPath, backup);

    const chained =
      body.trimEnd() +
      "\n\n# --- previously installed hook, kept intact ---\n" +
      current.replace(/^#!.*\n/, "") +
      "\n";

    fs.writeFileSync(hookPath, chained, { mode: 0o755 });
    return { status: "chained", hookPath, backup };
  }

  fs.writeFileSync(hookPath, body, { mode: 0o755 });
  return { status: "installed", hookPath };
}

function uninstall(root) {
  const dir = hooksDir(root);
  const hookPath = path.join(dir, "pre-commit");

  if (!fs.existsSync(hookPath)) return { status: "absent", hookPath };

  const current = fs.readFileSync(hookPath, "utf8");
  if (!current.includes(MARKER)) return { status: "not-ours", hookPath };

  const backup = hookPath + ".commitguard-backup";
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, hookPath);
    fs.unlinkSync(backup);
    return { status: "restored", hookPath };
  }

  fs.unlinkSync(hookPath);
  return { status: "removed", hookPath };
}

function status(root) {
  let dir;
  try {
    dir = hooksDir(root);
  } catch (err) {
    return { installed: false, reason: "not a git repository" };
  }

  const hookPath = path.join(dir, "pre-commit");
  if (!fs.existsSync(hookPath)) return { installed: false, hookPath };

  const current = fs.readFileSync(hookPath, "utf8");
  return { installed: current.includes(MARKER), hookPath };
}

module.exports = { install, uninstall, status, hooksDir, MARKER };
