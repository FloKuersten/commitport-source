# Contributing to commitport

Thanks for your interest! commitport is **source-available** software: the code
is public so you can read, audit, build, and improve it. It is a commercial
product — **using** commitport requires a [license](https://commitport.com/#pricing) —
but contributions are very welcome.

## Ways to help

- **Report a bug** — open an issue with steps to reproduce (see the bug template).
- **Suggest a feature** — open a feature request describing the problem it solves.
- **Send a pull request** — fixes, docs, tests, and translations are all appreciated.
- **Report a vulnerability** — please do **not** open a public issue; see [SECURITY.md](SECURITY.md).

## Developing

Pure standard-library Node (18+), no dependencies to install.

```bash
npm run demo       # build a sample repo and generate a portal into ./public
npm run preview    # serve it at http://localhost:8080
npm test           # the test suite (node:test, zero deps)
```

Packaging the Windows app/installer (maintainers) needs a couple of build-time
dev dependencies — see `npm run build:exe` / `npm run build:installer`.

## Commit style

commitport dogfoods its own conventions. Use
[Conventional Commits](https://www.conventionalcommits.org/), and keep commits
focused. (You'll see the client-facing marker scheme — gitmoji, `(client)`
scopes, `Client:` trailers — in the history; that's the product's own feature,
not a requirement for contributing.)

Before opening a PR: run `npm test`, keep the change small and well-described,
and add a test when you fix a bug or add behavior.

## Contributor terms

By submitting a contribution you agree that it is your own work and that you
license it to the project under the repository
[LICENSE](LICENSE), granting the maintainer the rights needed to use,
modify, and distribute it as part of commitport (including in the commercial,
licensed product). You retain copyright to your contribution.

Questions? **support@commitport.com**
