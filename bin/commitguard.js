#!/usr/bin/env node
/*
 * commitguard - stop credentials from reaching your git history.
 *
 * Commands:
 *   install     put a pre-commit hook in this repository
 *   uninstall   remove it (restores a hook it replaced, if any)
 *   check       scan what is staged            (what the hook runs)
 *   scan        scan the whole working tree
 *   status      is the hook installed here?
 *
 * Exit codes: 0 clean, 1 findings, 2 usage or environment error.
 */
"use strict";

const path = require("path");
const { execFileSync } = require("child_process");
const { scanStaged, scanFiles } = require("../lib/scan");
const hook = require("../lib/hook");

// FORCE_COLOR keeps colours alive through a pipe, the way most CLI tools do.
const FORCED = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0";
const NO_COLOR = process.env.NO_COLOR || (!FORCED && !process.stdout.isTTY);
const c = (code, text) => (NO_COLOR ? text : "\u001b[" + code + "m" + text + "\u001b[0m");
const red = (t) => c("31", t);
const green = (t) => c("32", t);
const yellow = (t) => c("33", t);
const blue = (t) => c("36", t);
const dim = (t) => c("90", t);
const bold = (t) => c("1", t);

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    return process.cwd();
  }
}

function report(result, heading) {
  const { findings, scanned } = result;

  if (!findings.length) {
    console.log(green("commitguard: clean") + dim("  (" + scanned + " files scanned)"));
    return 0;
  }

  // Group by file so the output reads like a list of places to go fix.
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  console.log("");
  console.log(red(bold("  " + heading)));
  console.log(
    dim("  " + findings.length + " finding" + (findings.length === 1 ? "" : "s") +
      " in " + byFile.size + " file" + (byFile.size === 1 ? "" : "s"))
  );
  console.log("");

  for (const [file, items] of byFile) {
    console.log("  " + blue(file));
    for (const item of items) {
      const where = item.line ? dim("line " + item.line + "  ") : "";
      console.log("    " + red("x") + " " + where + bold(item.title) + dim("  [" + item.rule + "]"));
      if (item.masked) console.log("      " + yellow(item.masked));
      if (item.preview) console.log("      " + dim(item.preview));
      console.log("      " + green("fix: ") + item.fix);
    }
    console.log("");
  }

  console.log(dim("  To allow a specific line, end it with:  commitguard-ignore"));
  console.log(dim("  To allow a path, add it to .commitguardignore"));
  console.log(dim("  To bypass once (not recommended):  git commit --no-verify"));
  console.log("");

  return 1;
}

function usage() {
  console.log(`
  ${bold("commitguard")} - keep credentials out of your git history

  ${bold("Usage")}
    npx commitguard install       install the pre-commit hook here
    npx commitguard check         scan staged changes
    npx commitguard scan          scan the whole working tree
    npx commitguard status        show whether the hook is installed
    npx commitguard uninstall     remove the hook

  ${bold("Notes")}
    The hook blocks a commit when it finds an API key, token, private key,
    database URL with a password or a staged .env file. Nothing is uploaded
    anywhere; the scan runs entirely on your machine.
`);
}

function main() {
  const command = (process.argv[2] || "").toLowerCase();
  const root = repoRoot();

  try {
    switch (command) {
      case "check": {
        const result = scanStaged(root);
        const code = report(result, "commit blocked - credentials found in staged changes");
        return code;
      }

      case "scan": {
        const target = process.argv[3] ? path.resolve(process.argv[3]) : root;
        const result = scanFiles(target);
        return report(result, "credentials found in the working tree");
      }

      case "install": {
        const entry = path.resolve(__filename);
        const outcome = hook.install(root, entry);
        if (outcome.status === "chained") {
          console.log(green("commitguard installed") + " and your existing pre-commit hook was kept.");
          console.log(dim("  backup: " + outcome.backup));
        } else if (outcome.status === "updated") {
          console.log(green("commitguard hook updated") + dim("  " + outcome.hookPath));
        } else {
          console.log(green("commitguard installed") + dim("  " + outcome.hookPath));
        }
        console.log(dim("  every commit in this repository is now scanned first"));
        return 0;
      }

      case "uninstall": {
        const outcome = hook.uninstall(root);
        const messages = {
          removed: "commitguard hook removed",
          restored: "commitguard removed, your previous hook was restored",
          absent: "no pre-commit hook here",
          "not-ours": "the pre-commit hook here was not installed by commitguard, leaving it alone",
        };
        console.log(messages[outcome.status] || outcome.status);
        return 0;
      }

      case "status": {
        const s = hook.status(root);
        if (s.installed) console.log(green("installed") + dim("  " + s.hookPath));
        else console.log(yellow("not installed") + dim(s.reason ? "  " + s.reason : ""));
        return 0;
      }

      case "":
      case "-h":
      case "--help":
      case "help":
        usage();
        return 0;

      default:
        console.error("commitguard: unknown command '" + command + "'");
        usage();
        return 2;
    }
  } catch (err) {
    if (err && err.code === "NOT_GIT") {
      console.error(red("commitguard: this is not a git repository"));
      return 2;
    }
    console.error(red("commitguard: " + (err && err.message ? err.message : String(err))));
    return 2;
  }
}

process.exit(main());
