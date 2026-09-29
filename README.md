# commitguard

[![tests](https://github.com/ProBurakElci/commitguard/actions/workflows/ci.yml/badge.svg)](https://github.com/ProBurakElci/commitguard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stops you from committing an API key.** One command to install, no dependencies, nothing leaves your machine.

Pushing a secret to GitHub is a bad afternoon: you rotate the key, you audit what used it, and the value stays in the history forever unless you rewrite it. The fix is boring and cheap — check before the commit happens, not after.

```bash
npx commitguard install
```

That's it. Every `git commit` in that repository is scanned first.

## What it looks like when it saves you

```
  commit blocked - credentials found in staged changes
  4 findings in 2 files

  .env
    x Environment file staged for commit  [env-file]
      fix: Add it to .gitignore and commit a .env.example with empty values instead.

  config.js
    x line 3  AWS access key id  [aws-access-key]
      AKIA************MPLE
      awsKey: "AKIA************MPLE",
      fix: Rotate it in the AWS console (IAM > Access keys), then read it from an environment variable.
    x line 4  Stripe live key  [stripe-key]
      sk_l************yZa1
      stripe: "sk_l************yZa1",
      fix: Roll the key in the Stripe dashboard (Developers > API keys) right now.
    x line 5  Database connection string with password  [connection-string]
      post************/app
      db: "post************/app",
      fix: Change the database password and build the URL from environment variables.
```

The commit does not go through, and every finding comes with the one action that actually matters: where to go rotate it.

Note that the secret is masked even in the preview line. A scanner that prints the key back into your terminal — and into your CI logs — has just made a second copy of the problem.

## What it catches

| | |
|---|---|
| AWS | access key ids (`AKIA…`), secret access keys |
| GitHub | classic and fine-grained tokens (`ghp_…`, `github_pat_…`) |
| Google | API keys (`AIza…`) |
| Slack | bot/user tokens, incoming webhook URLs |
| Stripe | live secret and restricted keys |
| OpenAI, Anthropic | `sk-…`, `sk-ant-…` |
| Keys & certs | `-----BEGIN … PRIVATE KEY-----`, `id_rsa`, `.pem`, `.p12` |
| Tokens | JSON Web Tokens |
| Databases | `postgres://`, `mysql://`, `mongodb+srv://`, `redis://` URLs that carry a password |
| Config | a staged `.env` (but `.env.example` is fine) |
| Generic | `apiKey = "…"` style assignments, filtered by entropy so placeholders stay quiet |

## What it deliberately does not do

It does not flag `process.env.API_KEY`, `"changeme"`, `"your-api-key"`, `<your-token>`, `${API_KEY}`, `postgres://localhost:5432/app`, or a twelve-character string of `x`. A scanner that cries wolf gets uninstalled on day two, so the rules only match credential formats real providers actually issue, and the generic rule runs a Shannon-entropy check before it says anything.

It also skips `node_modules`, lock files, minified bundles, images and binaries — so a scan stays fast on a real repository.

## Commands

```bash
npx commitguard install      # install the pre-commit hook in this repo
npx commitguard check        # scan what is staged right now
npx commitguard scan         # scan the whole working tree
npx commitguard scan ./src   # scan one directory
npx commitguard status       # is the hook installed here?
npx commitguard uninstall    # remove it
```

Exit codes: `0` clean, `1` findings, `2` usage or environment error — so `commitguard scan` also works as a CI step.

## Letting something through

Three levels, from narrow to wide:

```js
const id = "AKIAIOSFODNN7EXAMPLE"; // commitguard-ignore
```

```
# .commitguardignore
test/fixtures/
docs/*.md
```

```bash
git commit --no-verify        # bypass once, git's own escape hatch
```

## If you already have a pre-commit hook

Install keeps it. Your existing hook is backed up to `pre-commit.commitguard-backup` and appended below the commitguard block, so both run. `uninstall` puts your original back. If your project sets `core.hooksPath` (husky, lefthook), the hook is installed there instead.

## Tests

```bash
node test/run-tests.js
```

70 checks: every rule against a real credential of that format, a long list of ordinary lines that must stay quiet, and an end-to-end run that creates a real git repository, installs the hook, and verifies that `git commit` is genuinely blocked — including the case where a file is cleaned up *after* `git add`, because the commit still contains the staged version.

## How it works

Three files, no dependencies:

```
bin/commitguard.js   CLI and output
lib/rules.js         the patterns and their "how to fix" text
lib/scan.js          staged / working-tree scanning
lib/hook.js          installing and removing the git hook
```

The hook itself is four lines of shell that call this package, so updating commitguard never means reinstalling the hook, and anyone who opens `.git/hooks/pre-commit` can read exactly what runs before their commits.

Staged scanning reads blobs out of the index (`git show :file`) rather than from disk. If you stage a secret and then clean the file, the commit still carries the secret — that is the case a naive scanner misses.

## Contributing

New provider patterns are welcome and easy: add an entry to `RULES` in `lib/rules.js` with a `fix` line that says where to rotate the credential, then add one "must be caught" case and, if the format could collide with ordinary code, one "must stay quiet" case in `test/run-tests.js`.

## License

MIT — see [LICENSE](LICENSE).
