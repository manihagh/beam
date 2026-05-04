# Maintenance

Beam is open source under MIT. The maintainers' obligations are limited to
the terms of that license, which is to say: none.

That does not mean the project is abandoned. It means expectations should
match how this is actually maintained.

## What you can expect

- Issues are triaged best-effort. Bugs with a clean reproduction get prioritized
  over questions and feature requests.
- Pull requests are reviewed best-effort. PRs that include tests, follow the
  existing code style, and keep the change small are reviewed faster.
- The `main` branch is kept in a deployable state. Tagged releases follow
  semver. Read the release notes before upgrading a deployment in production.

## What you should not expect

- A response within hours, or even within a day. Best-effort means weekends
  and evenings, around a full-time role.
- Roadmap commitments. The project ships what it ships. Items in the README
  roadmap section are intentions, not promises.
- Backward-compatible patches indefinitely. If a refactor breaks v1.x, there
  will be a migration note in the release, not a long-running maintenance branch.
- Free architectural consulting on your specific deployment in issue threads.
  Stack Overflow and the project discussions tab are better venues for that.

## If you depend on Beam in production

Then you should fork it. Self-hosting open source means owning the operational
risk. Pin a version, run your own CI on the fork, watch the upstream repo for
security advisories, and pull updates on your schedule. This is the standard
operating model for self-hosted infrastructure software and it is the right
one here.

If you would prefer not to self-host or fork, you should not deploy Beam.
There are commercial publishing layers; pick one.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
