# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue.

- Email **security@commitport.com** with a description, steps to reproduce, and
  the impact you've found.
- Or use GitHub's **private vulnerability reporting** (Security → Report a
  vulnerability) on this repository.

We aim to acknowledge reports within **72 hours** and to ship a fix or mitigation
as quickly as the severity warrants. We'll keep you updated and credit you in the
release notes unless you prefer to stay anonymous.

## Scope notes

commitport runs locally and produces static output — it has no server component
in this repository. The app's local helper UI binds to `127.0.0.1` only and is
gated by a per-launch token; reports about that surface are in scope. Please act
in good faith: don't access data that isn't yours and don't run denial-of-service
or destructive tests.

Thank you for helping keep commitport and its users safe.
