/*
 * Detection rules.
 *
 * Each rule is deliberately narrow. A scanner that cries wolf gets uninstalled
 * on day two, so every pattern here matches a credential format that real
 * providers actually issue - not "anything that looks random".
 *
 * Fields:
 *   id       short identifier, shown in output and usable in ignore comments
 *   title    what a human should understand from the hit
 *   pattern  global regex run per line
 *   fix      the sentence that tells the developer what to do next
 *   entropy  when true, the captured value must also look random
 */
"use strict";

const PLACEHOLDERS = [
  "your", "example", "changeme", "change_me", "placeholder", "dummy", "sample",
  "test", "todo", "xxx", "abc123", "secret", "password", "replace", "insert",
  "my-", "foo", "bar", "none", "null", "undefined", "process.env", "import.meta",
  "<", ">", "${", "{{", "***", "redacted", "hidden",
];

/** Shannon entropy in bits per character. */
function entropy(value) {
  if (!value) return 0;
  const counts = Object.create(null);
  for (const ch of value) counts[ch] = (counts[ch] || 0) + 1;
  let sum = 0;
  for (const ch in counts) {
    const p = counts[ch] / value.length;
    sum -= p * Math.log2(p);
  }
  return sum;
}

/** Obvious dummy values must not block anyone's commit. */
function isPlaceholder(value) {
  const low = value.toLowerCase();
  if (low.length < 8) return true;
  if (/^[x*.\-_0]+$/.test(low)) return true;
  return PLACEHOLDERS.some((p) => low.includes(p));
}

const RULES = [
  {
    id: "aws-access-key",
    title: "AWS access key id",
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
    fix: "Rotate it in the AWS console (IAM > Access keys), then read it from an environment variable.",
  },
  {
    id: "aws-secret-key",
    title: "AWS secret access key",
    pattern: /aws.{0,20}?(?:secret|private).{0,20}?["'`]([A-Za-z0-9/+=]{40})["'`]/gi,
    fix: "Rotate the key pair in IAM immediately - a secret key cannot be un-leaked.",
    entropy: true,
  },
  {
    id: "github-token",
    title: "GitHub token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g,
    fix: "Revoke it at github.com/settings/tokens and issue a new one.",
  },
  {
    id: "google-api-key",
    title: "Google API key",
    pattern: /\b(AIza[0-9A-Za-z\-_]{35})\b/g,
    fix: "Delete the key in Google Cloud Console > Credentials and restrict the replacement.",
  },
  {
    id: "slack-token",
    title: "Slack token",
    pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    fix: "Revoke it in the Slack app settings (OAuth & Permissions).",
  },
  {
    id: "stripe-key",
    title: "Stripe live key",
    pattern: /\b((?:sk|rk)_live_[0-9a-zA-Z]{20,})\b/g,
    fix: "Roll the key in the Stripe dashboard (Developers > API keys) right now.",
  },
  {
    id: "openai-key",
    title: "OpenAI API key",
    pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g,
    fix: "Revoke it at platform.openai.com/api-keys.",
  },
  {
    id: "anthropic-key",
    title: "Anthropic API key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
    fix: "Revoke it in the Anthropic console and store the new one in an env var.",
  },
  {
    id: "private-key",
    title: "Private key block",
    pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----)/g,
    fix: "Never commit key material. Move it out of the repo and regenerate the pair.",
  },
  {
    id: "jwt",
    title: "JSON Web Token",
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    fix: "If this is a real session or service token, invalidate it and keep tokens out of source.",
  },
  {
    id: "slack-webhook",
    title: "Slack webhook URL",
    pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]{20,})/g,
    fix: "Delete the webhook in Slack - anyone with the URL can post to that channel.",
  },
  {
    id: "connection-string",
    title: "Database connection string with password",
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@"'`]+:[^\s:@"'`]{6,}@[^\s"'`]+)/gi,
    fix: "Change the database password and build the URL from environment variables.",
  },
  {
    id: "generic-secret",
    title: "Hardcoded secret",
    pattern:
      /\b(?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key|auth)\b\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi,
    fix: "Read it from process.env instead, and rotate the value if it was ever real.",
    entropy: true,
  },
];

module.exports = { RULES, entropy, isPlaceholder };
