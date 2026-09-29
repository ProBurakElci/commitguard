/*
 * Tests:  node test/run-tests.js
 *
 * Two things matter for a tool like this, and they pull in opposite directions:
 *   1. it must catch real credentials
 *   2. it must not scream about ordinary code
 * The second half of this file is the one that keeps the tool installed.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { scanText, fileLevelFinding, shouldSkip, mask } = require("../lib/scan");

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("  FAILED: " + label);
  }
}

function hits(line) {
  return scanText("test.js", line);
}

function section(name) {
  console.log("\n" + name);
}

/* ---------------- must be caught ---------------- */

section("Credentials that must be caught");

/*
 * The fixtures below are assembled at runtime instead of being written out as
 * literals. They are fake, but they have the exact shape of the real thing, so
 * a file containing them is a file full of "secrets" as far as any scanner is
 * concerned - including GitHub's own push protection, which refuses a push that
 * carries them. Joining the parts keeps this repository pushable while still
 * exercising the real patterns.
 */
const j = (...parts) => parts.join("");

const FAKE = {
  aws: j("AKIA", "IOSFODNN7EXAMPLE"),
  github: j("ghp", "_", "1234567890abcdefghijklmnopqrstuvwxyz"),
  google: j("AIza", "SyD-1234567890abcdefghijklmnopqrstu"),
  slack: j("xox", "b-123456789012-1234567890123-abcdefghijklmnop"),
  stripe: j("sk", "_live_", "51H8xQ2KlmNoPqRsTuVwXyZa1"),
  openai: j("sk", "-proj-", "abcdefghij1234567890KLMNOP"),
  anthropic: j("sk", "-ant-", "api03-abcdefghij1234567890KLMNOPqrst"),
  privateKey: j("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
  jwt: j("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"),
  slackHook: j("https://hooks.", "slack", ".com/services/", "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"),
};

const mustCatch = [
  ["AWS access key", 'const id = "' + FAKE.aws + '";', "aws-access-key"],
  ["GitHub token", 'token: "' + FAKE.github + '"', "github-token"],
  ["Google API key", "key=" + FAKE.google, "google-api-key"],
  ["Slack token", 'const t = "' + FAKE.slack + '"', "slack-token"],
  ["Stripe live key", 'stripe("' + FAKE.stripe + '")', "stripe-key"],
  ["OpenAI key", "OPENAI_API_KEY=" + FAKE.openai, "openai-key"],
  ["Anthropic key", 'const k = "' + FAKE.anthropic + '"', "anthropic-key"],
  ["private key header", FAKE.privateKey, "private-key"],
  ["JWT", 'auth = "' + FAKE.jwt + '"', "jwt"],
  ["Slack webhook", 'url = "' + FAKE.slackHook + '"', "slack-webhook"],
  ["postgres URL with password", 'DATABASE_URL="postgres://admin:h7Kd92mXpQ@db.internal:5432/app"', "connection-string"],
  ["mongodb URL with password", 'const uri = "mongodb+srv://user:S3cretPassw0rd@cluster0.mongodb.net/test"', "connection-string"],
  ["hardcoded api key", 'const apiKey = "9f2b4c7e1a8d5f3b6c0e9a2d4f7b1c8e";', "generic-secret"],
];

for (const [label, line, expectedRule] of mustCatch) {
  const found = hits(line);
  ok(label + " is detected", found.length > 0);
  ok(label + " maps to rule " + expectedRule, found.some((f) => f.rule === expectedRule));
}

/* ---------------- must NOT be caught ---------------- */

section("Ordinary code that must stay quiet");

const mustNotCatch = [
  'const apiKey = process.env.API_KEY;',
  'password: "changeme"',
  'const token = "your-token-here";',
  'API_KEY=<your-api-key>',
  'apiKey: "${API_KEY}"',
  'const secret = "";',
  'password = "xxxxxxxxxxxx"',
  '// token: replace-with-real-value',
  'const url = "postgres://localhost:5432/app";',
  'const url = "mongodb://127.0.0.1:27017/dev";',
  'import { apiKey } from "./config";',
  'const password = "password";',
  'expect(token).toBe("test");',
  'const key = "abc";',
  'auth_token = "TODO"',
];

for (const line of mustNotCatch) {
  const found = hits(line);
  ok("quiet: " + line.slice(0, 44), found.length === 0);
}

/* ---------------- ignore comment ---------------- */

section("Ignore mechanisms");

ok(
  "inline commitguard-ignore suppresses the finding",
  hits('const id = "' + FAKE.aws + '"; // commitguard-ignore').length === 0
);
ok(
  "a real key without the comment still fires",
  hits('const id = "' + FAKE.aws + '";').length === 1
);

/* ---------------- file level ---------------- */

section("File level rules");

ok(".env is flagged", fileLevelFinding(".env") !== null);
ok(".env.local is flagged", fileLevelFinding("config/.env.local") !== null);
ok(".env.example is allowed", fileLevelFinding(".env.example") === null);
ok("id_rsa is flagged", fileLevelFinding("keys/id_rsa") !== null);
ok("server.pem is flagged", fileLevelFinding("certs/server.pem") !== null);
ok("normal source file is fine", fileLevelFinding("src/index.js") === null);

ok("node_modules is skipped", shouldSkip("node_modules/pkg/index.js"));
ok("lock files are skipped", shouldSkip("package-lock.json"));
ok("images are skipped", shouldSkip("assets/logo.png"));
ok("minified bundles are skipped", shouldSkip("dist/app.min.js"));
ok("source files are scanned", !shouldSkip("src/server.js"));

/* ---------------- masking ---------------- */

section("Output safety");

const secret = FAKE.aws;
const masked = mask(secret);
ok("masked value hides the middle", !masked.includes("OSFODNN7"));
ok("masked value keeps a hint", masked.startsWith("AKIA"));
ok("short values are masked too", mask("abc123") === "a*****");

/* ---------------- end to end with a real repo ---------------- */

section("End to end: a real git repository");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commitguard-test-"));
const cli = path.resolve(__dirname, "..", "bin", "commitguard.js");

function run(args, options) {
  const opts = Object.assign({ cwd: tmp, encoding: "utf8" }, options || {});
  try {
    return { code: 0, out: execFileSync(process.execPath, [cli].concat(args), opts) };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
}

try {
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["config", "commit.gpgsign", "false"]);

  // clean commit passes
  fs.writeFileSync(path.join(tmp, "app.js"), 'const key = process.env.API_KEY;\n');
  git(["add", "-A"]);
  const clean = run(["check"]);
  ok("clean staged changes exit 0", clean.code === 0);

  git(["commit", "-qm", "first"]);

  // install the hook
  const install = run(["install"]);
  ok("install exits 0", install.code === 0);
  const hookPath = path.join(tmp, ".git", "hooks", "pre-commit");
  ok("hook file is created", fs.existsSync(hookPath));
  ok("status reports installed", run(["status"]).out.includes("installed"));

  // a leaked key blocks the commit
  fs.writeFileSync(
    path.join(tmp, "config.js"),
    'module.exports = { awsKey: "' + FAKE.aws + '" };\n'
  );
  git(["add", "-A"]);
  const dirty = run(["check"]);
  ok("staged credential exits 1", dirty.code === 1);
  ok("output names the file", dirty.out.includes("config.js"));
  ok("output does not print the full key", !dirty.out.includes(FAKE.aws));

  let commitBlocked = false;
  try {
    git(["commit", "-qm", "leak"]);
  } catch (err) {
    commitBlocked = true;
  }
  ok("the hook actually blocks git commit", commitBlocked);

  // --no-verify still works, that is git's own escape hatch
  git(["commit", "-qm", "leak", "--no-verify"]);
  ok("--no-verify bypasses the hook", true);

  // index content is what gets scanned, not the working tree
  fs.writeFileSync(path.join(tmp, "late.js"), 'const t = "' + FAKE.github + '";\n');
  git(["add", "late.js"]);
  fs.writeFileSync(path.join(tmp, "late.js"), "const t = process.env.T;\n"); // cleaned after staging
  const staged = run(["check"]);
  ok("scans the staged blob, not the edited file", staged.code === 1);

  // .commitguardignore
  fs.writeFileSync(path.join(tmp, ".commitguardignore"), "late.js\n");
  git(["add", "-A"]);
  const ignored = run(["check"]);
  ok(".commitguardignore silences the path", ignored.code === 0);

  // uninstall
  const removed = run(["uninstall"]);
  ok("uninstall exits 0", removed.code === 0);
  ok("hook file is gone", !fs.existsSync(hookPath));
} catch (err) {
  failed++;
  console.error("  FAILED: end to end run threw: " + err.message);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    /* temp dir cleanup is best effort */
  }
}

console.log("\n" + passed + " passed, " + failed + " failed.");
process.exit(failed ? 1 : 0);
