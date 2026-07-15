# Source plugins

A source plugin is a directory of TypeScript that dev-stream polls for posts.
Its code runs inside a sandboxed worker that can only touch what its manifest
declares, and only after you have explicitly trusted it in Settings.

## Installing one

Paste a GitHub repository or tree URL into Settings → Integrations, or install a
local development copy manually:

```sh
mkdir -p ~/.dev-stream/plugins
cp -R examples/plugins/hackernews ~/.dev-stream/plugins/
```

Restart dev-stream. The plugin appears in Settings → Integrations with its
permission list and a **Trust this plugin** button. Nothing runs until you
press it.

## Layout

```
~/.dev-stream/plugins/<name>/
├── manifest.json   # who it is + what it may access (no code runs to read this)
└── mod.ts          # the entry module; must export poll()
```

## manifest.json

```jsonc
{
  "slug": "hackernews",          // the `source` its posts carry; [a-z0-9_-]
  "label": "Hacker News",        // what Settings shows
  "entry": "mod.ts",             // relative, must stay inside the plugin dir
  "defaultIntervalMs": 300000,   // poll cadence; clamped to >= 15000
  "configFields": [              // what Settings collects; `secret` values are
    {                            // stored server-side and never echoed back
      "key": "query",
      "label": "Search query",
      "secret": false,
      "placeholder": "deno",
      "help": "Shown under the input."
    }
  ],
  "permissions": {
    "net": ["hn.algolia.com"],       // the ONLY hosts fetch() may reach
    "net_from_config": ["api_base"], // + the host found in this config value
    "read": [],                      // extra readable paths (own dir is free)
    "write": [],                     // writable paths
    "run": [],                       // executables, e.g. ["gh"] — ELEVATED:
                                     // subprocesses are NOT sandboxed
    "env": []                        // readable environment variables
  }
}
```

Everything is deny-by-default: an empty `permissions` object means the plugin
can compute and nothing else. `net_from_config` exists for self-hosted APIs
(GitHub Enterprise and friends) — the manifest names the config *key*, the user
types the URL, and only that URL's host is admitted.

**Trust binds to the manifest's bytes.** Editing `manifest.json` — adding a
host, requesting `run` — changes its hash, which revokes trust and disables the
plugin until it is granted again. Code changes alone do *not* re-prompt: trust
grants capabilities, and whatever the code becomes, it stays inside them.

## mod.ts

The entry module exports one function:

```ts
export function poll(ctx: {
  config: Record<string, unknown>; // values from configFields (secrets included)
  cursor: string | null;           // your watermark from last time, or null
}): Promise<{
  posts: PostInput[];              // same shape the HTTP ingest API takes
  cursor: string | null;           // persisted and handed back next poll
}>;
```

Throwing is fine and expected (bad token, rate limit, outage): the runner
records the message, shows it in Settings, and tries again next tick.

Rules of the sandbox:

- `fetch` works only against hosts in `net` / `net_from_config`; anything else
  throws `NotCapable`.
- The filesystem, environment and subprocesses are closed unless requested.
- Imports must be local files inside the plugin directory — remote imports are
  blocked at runtime, so vendor what you need.
- `post.source` is overwritten with your slug server-side; a plugin cannot post
  as another source.
- A poll that runs past its deadline (2 minutes) is terminated.
