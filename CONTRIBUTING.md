# Contributing

Thanks for considering a contribution. A few things up front so we use each
other's time well.

## Issues that get traction

- Bugs with a clean reproduction. Include the commit hash, the exact request,
  the response, and what you expected. Ten lines beats ten paragraphs.
- Feature requests that come with a use case the maintainers recognize. "We
  need X because Claude users at our company keep asking for Y" lands; "wouldn't
  it be cool if X" does not.
- Documentation gaps. If something in `docs/` was wrong or unclear when you
  deployed, a PR fixing it is the most welcome contribution.

## Pull requests that get merged

- Small. One concern per PR. A 30-line change with a clean diff merges fast;
  a 600-line refactor sits forever.
- Match the existing style. No reformatter passes, no rename-everything
  changes mixed with feature work, no introducing new abstractions to handle
  one extra case. The code style here is deliberately plain.
- Pass typecheck (`npm run typecheck`).
- Update docs and the SKILL.md when behavior or tool surface changes.
- Include a one-paragraph PR description explaining what and why. The diff
  shows what; reviewers need why.
- Do not change the public MCP tool surface (tool names, parameter shapes,
  return formats) without an explicit issue discussion first. Anything that
  Claude would call directly is a stable interface.

## Local setup

```bash
npm install
echo 'MCP_BEARER_TOKEN=dev-test-token' > .dev.vars
npm run dev
```

Wrangler will rewrite all three hostnames onto `localhost:8787`. The Worker
routes by path in dev. See `README.md` for the routing table.

## Code style notes

- TypeScript strict mode is on. Do not silence type errors with `any`.
- No frameworks in the Worker. The whole thing is hand-rolled by design;
  bundle size matters and dependencies on the hot path matter.
- Templates are template literals, not JSX. The output is HTML for browsers,
  not React.
- Logs go to `console.log`. `wrangler tail` is the production debugger.
- Prefer dropping a comment that explains *why* over inventing a helper that
  hides the *what*.

## Ground rules

- Be respectful. Disagreement is fine; sneering is not.
- Do not paste secrets into issues or PRs. If you accidentally do, force-push
  immediately and rotate the secret regardless.
- Do not ship features that depend on closed-source services unless the user
  can opt out and the project still works. Cloudflare is the floor; everything
  above it is optional.
