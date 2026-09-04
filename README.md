# toolport-mcp-servers

**Full-API MCP servers, generated from official OpenAPI specs. One `npx` command, no build step.**

Most official MCP servers hand your agent a handful of tools, or a clunky "call the API"
bridge. But the whole API is right there in the vendor's OpenAPI spec. This turns that spec
into a real MCP server with intent-friendly tool names your model can actually find.

[![npm](https://img.shields.io/npm/v/toolport-mcp-servers.svg)](https://www.npmjs.com/package/toolport-mcp-servers) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> Unofficial. Generated from public OpenAPI specs. Not affiliated with Stripe, Clerk, Vercel,
> or any API provider.

## Servers

| Server | Tools | Auth env |
|---|--:|---|
| **stripe** | **587** | `STRIPE_API_KEY` |
| **vercel** | **333** | `VERCEL_TOKEN` |
| **clerk** | **224** | `CLERK_SECRET_KEY` |

All three ship ready to run. No install, no build, no keys needed to inspect them.

## Quick start

Point any MCP client (Claude Desktop, Cursor, Cline, ...) at it. Pick your server as the
first argument:

```jsonc
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "toolport-mcp-servers", "stripe"],
      "env": { "STRIPE_API_KEY": "sk_live_..." }
    },
    "clerk": {
      "command": "npx",
      "args": ["-y", "toolport-mcp-servers", "clerk"],
      "env": { "CLERK_SECRET_KEY": "sk_..." }
    },
    "vercel": {
      "command": "npx",
      "args": ["-y", "toolport-mcp-servers", "vercel"],
      "env": { "VERCEL_TOKEN": "..." }
    }
  }
}
```

That's it. Your agent gets the full API as clean, callable tools (`create_customer`,
`create_deployment`, `create_invitation`, `list_organizations`, ...).

Want to see the wiring before you wire in a key? Run any server in dry-run (no key needed) -
it prints the exact HTTP request each tool would make:

```bash
npx -y toolport-mcp-servers stripe
```

## Why these beat the raw generators

Anyone can run an OpenAPI-to-tools generator. The catalog you get back is usually unusable by
an agent: `PostCustomers`, `GetUsersUserIdOrganizationMemberships`. The model searches on the
name, so a bad name is a tool the agent never finds. These servers fix that:

- **Intent-friendly names.** `PostCustomers` becomes `create_customer`; `GetUserList` becomes
  `list_users`. Path-style and verb-style operationIds are both normalized.
- **Enriched descriptions.** Real domain vocabulary (payments: charge, refund, dispute,
  payout; auth: member, session, sign-in, magic link) so natural queries match.
- **Every operation, not a curated few.** The full write surface, including the endpoints the
  official servers leave out.
- **Benchmarked.** Names and descriptions are tuned against a real retrieval ranker. On Stripe,
  curation lifts recall@10 from 91% to 96% over 587 tools (23-intent set); the core subset hits
  100%.

## Behind Toolport (recommended)

Run any of these standalone, or point [Toolport](https://toolport.app) at them and get:

- **Lazy discovery** - your agent sees a few meta-tools and searches on demand, so 587 tools
  cost almost nothing in context.
- **Human approval** - hold destructive calls (refund a charge, delete a user, remove a
  deployment) for a one-click OK.
- **Local-first** - keys stay in your OS keychain, nothing leaves your machine.

That's the point of full-API servers: the whole API is reachable, and Toolport is the layer
that makes 587 tools safe and cheap to keep on.

## Add your own

Any OpenAPI/Swagger API can become a curated MCP server. Drop a `vendors/<name>.js` config
(spec URL, naming style, domain vocabulary, auth env), run the prep script, and you have a new
`npx toolport-mcp-servers <name>` server. PRs welcome.

```bash
git clone https://github.com/btsouth/toolport-mcp-servers && cd toolport-mcp-servers
npm run prep:vercel      # example: refetch the public spec and regenerate
```

## How it works

An operationId humanizer (path-style and verb-style) plus a description-enrichment overlay
turn a raw OpenAPI-generated tool catalog into intent-shaped tools, benchmarked against the
real Toolport ranker. Generated artifacts are bundled per vendor in `data/`; the humanizer and
overlay live in `src/`, and each server's config is a single file under `vendors/`.

## License

MIT. Tool definitions are derived from each vendor's public OpenAPI spec. Not affiliated with
or endorsed by any API provider. Vendor names are trademarks of their respective owners and
are used here only to identify the API each server targets.
