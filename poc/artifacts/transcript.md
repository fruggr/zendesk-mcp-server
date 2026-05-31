# Meta-MCP PoC — automated validation transcript

- Date: 2026-05-31T05:32:55.752Z
- Node: v22.22.2
- Meta-MCP entry: `/home/user/zendesk-mcp-server/poc/meta-mcp/index.ts`
- Client → meta-MCP over stdio; the meta-MCP is the MCP *client* of the SUT.

Meta-tools exposed (fixed surface): ["sut_call_tool","sut_list_tools","sut_logs","sut_reload","sut_start","sut_status","sut_stop"]

## AC-1 — Initial load & start (variant A)

```jsonc
// → sut_start({})
{
  "ok": true,
  "pid": 5146,
  "serverInfo": {
    "name": "demo-sut",
    "version": "1.0.0-A"
  },
  "capabilities": {
    "tools": {
      "listChanged": true
    }
  },
  "recentLogs": [
    "[demo-sut variant A] ready — 1 tool: echo"
  ]
}
```

```jsonc
// → sut_status({})
{
  "state": "running",
  "running": true,
  "pid": 5146,
  "lastExitCode": null,
  "lastExitSignal": null,
  "lastError": null,
  "serverInfo": {
    "name": "demo-sut",
    "version": "1.0.0-A"
  },
  "command": "/opt/node22/bin/node",
  "args": [
    "/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs",
    "/home/user/zendesk-mcp-server/poc/sut/server.ts"
  ],
  "cwd": "/home/user/zendesk-mcp-server/",
  "stderrLines": 1,
  "parseErrorCount": 0,
  "lastParseError": null
}
```

**AC-1 — Initial load: ✅ PASS** — handshake ok=true, running=true, pid=5146, serverInfo={"name":"demo-sut","version":"1.0.0-A"}

## AC-2 — Proxied tools/list (variant A)

```jsonc
// → sut_list_tools({})
{
  "ok": true,
  "tools": [
    {
      "name": "echo",
      "description": "Echo back the provided text unchanged.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Text to echo back"
          }
        },
        "required": [
          "text"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "annotations": {
        "readOnlyHint": true,
        "openWorldHint": false
      }
    }
  ]
}
```

**AC-2 — Proxied listing: ✅ PASS** — 1 tool(s): echo; echo desc="Echo back the provided text unchanged."; annotations={"readOnlyHint":true,"openWorldHint":false}

## AC-3 — Proxied tools/call (echo)

```jsonc
// → sut_call_tool({"name":"echo","arguments":{"text":"hi"}})
{
  "ok": true,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "hi"
      }
    ]
  }
}
```

**AC-3 — Proxied call: ✅ PASS** — echo("hi") → "hi"

## AC-4 — Hot reload A→B without session restart (CORE)

Editing SUT *source* on disk: copying variant-b.ts over sut/server.ts (simulates a dev edit)…

```jsonc
// → sut_reload({})
{
  "ok": true,
  "diff": {
    "added": [
      "reverse"
    ],
    "removed": [],
    "changed": [
      "echo"
    ],
    "before": [
      "echo"
    ],
    "after": [
      "echo",
      "reverse"
    ]
  },
  "pid": 5175,
  "recentLogs": [
    "[demo-sut variant A] ready — 1 tool: echo",
    "[demo-sut variant B] ready — 2 tools: echo, reverse"
  ]
}
```

```jsonc
// → sut_list_tools({})
{
  "ok": true,
  "tools": [
    {
      "name": "echo",
      "description": "Echo back the provided text unchanged (variant B — description updated).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Text to echo back"
          }
        },
        "required": [
          "text"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "annotations": {
        "readOnlyHint": true,
        "openWorldHint": false
      }
    },
    {
      "name": "reverse",
      "description": "Return the input text reversed character-by-character.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Text to reverse"
          }
        },
        "required": [
          "text"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "annotations": {
        "readOnlyHint": true,
        "openWorldHint": false
      }
    }
  ]
}
```

```jsonc
// → sut_call_tool({"name":"reverse","arguments":{"text":"abc"}})
{
  "ok": true,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "cba"
      }
    ]
  }
}
```

**AC-4 — Hot reload (CORE): ✅ PASS** — reload diff={"added":["reverse"],"removed":[],"changed":["echo"],"before":["echo"],"after":["echo","reverse"]}; tools now=[echo, reverse]; reverse("abc")→"cba". Meta-MCP NOT restarted (same stdio session, same transport pid).

## AC-5 — Meta surface stable (no list_changed dependency)

Meta-tools before AC-2: ["sut_call_tool","sut_list_tools","sut_logs","sut_reload","sut_start","sut_status","sut_stop"]
Meta-tools after AC-4:  ["sut_call_tool","sut_list_tools","sut_logs","sut_reload","sut_start","sut_status","sut_stop"]

**AC-5 — Meta surface persistence: ✅ PASS** — The client-visible meta-tool list is byte-identical before/after the SUT mutated A→B. The SUT's 1→2 tool change happened entirely behind the fixed meta surface, so no client-side list_changed handling was required.

## AC-6 — Robustness to a crashing SUT

```jsonc
// → sut_stop({})
{
  "ok": true,
  "pid": 5175,
  "exitCode": 0
}
```

```jsonc
// → sut_start({"args":["/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs","/home/user/zendesk-mcp-server/poc/sut/broken.ts"]})   [isError]
{
  "ok": false,
  "error": "MCP error -32000: Connection closed",
  "pid": null,
  "recentLogs": [
    "[demo-sut variant A] ready — 1 tool: echo",
    "[demo-sut variant B] ready — 2 tools: echo, reverse",
    "[demo-sut broken] about to crash on purpose…",
    "/home/user/zendesk-mcp-server/poc/sut/broken.ts:7",
    "throw new Error('demo-sut-broken: intentional startup crash for robustness testing');",
    "      ^",
    "Error: demo-sut-broken: intentional startup crash for robustness testing",
    "    at <anonymous> (/home/user/zendesk-mcp-server/poc/sut/broken.ts:7:7)",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)",
    "    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)",
    "    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)",
    "Node.js v22.22.2"
  ]
}
```

```jsonc
// → sut_status({})
{
  "state": "error",
  "running": false,
  "pid": null,
  "lastExitCode": 1,
  "lastExitSignal": null,
  "lastError": "MCP error -32000: Connection closed",
  "serverInfo": {
    "name": "demo-sut",
    "version": "1.1.0-B"
  },
  "command": "/opt/node22/bin/node",
  "args": [
    "/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs",
    "/home/user/zendesk-mcp-server/poc/sut/broken.ts"
  ],
  "cwd": "/home/user/zendesk-mcp-server/",
  "stderrLines": 12,
  "parseErrorCount": 0,
  "lastParseError": null
}
```

```jsonc
// → sut_logs({"lines":10})
{
  "lines": [
    "[demo-sut broken] about to crash on purpose…",
    "/home/user/zendesk-mcp-server/poc/sut/broken.ts:7",
    "throw new Error('demo-sut-broken: intentional startup crash for robustness testing');",
    "      ^",
    "Error: demo-sut-broken: intentional startup crash for robustness testing",
    "    at <anonymous> (/home/user/zendesk-mcp-server/poc/sut/broken.ts:7:7)",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)",
    "    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)",
    "    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)",
    "Node.js v22.22.2"
  ]
}
```

**AC-6 — Crash robustness: ✅ PASS** — sut_start(broken) returned structured error (isError=true: "MCP error -32000: Connection closed"). Meta-MCP still answers sut_status (state=error) and sut_logs (10 lines).

## AC-7 — stdout noise does not corrupt JSON-RPC

```jsonc
// → sut_stop({})
{
  "ok": true,
  "pid": null,
  "exitCode": 1,
  "error": "SUT was not running."
}
```

```jsonc
// → sut_start({"args":["/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs","/home/user/zendesk-mcp-server/poc/sut/noisy.ts"]})
{
  "ok": true,
  "pid": 5221,
  "serverInfo": {
    "name": "demo-sut-noisy",
    "version": "1.0.0-NOISY"
  },
  "capabilities": {
    "tools": {
      "listChanged": true
    }
  },
  "recentLogs": [
    "      ^",
    "Error: demo-sut-broken: intentional startup crash for robustness testing",
    "    at <anonymous> (/home/user/zendesk-mcp-server/poc/sut/broken.ts:7:7)",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)",
    "    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)",
    "    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)",
    "Node.js v22.22.2",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo"
  ]
}
```

```jsonc
// → sut_status({})
{
  "state": "running",
  "running": true,
  "pid": 5221,
  "lastExitCode": 1,
  "lastExitSignal": null,
  "lastError": null,
  "serverInfo": {
    "name": "demo-sut-noisy",
    "version": "1.0.0-NOISY"
  },
  "command": "/opt/node22/bin/node",
  "args": [
    "/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs",
    "/home/user/zendesk-mcp-server/poc/sut/noisy.ts"
  ],
  "cwd": "/home/user/zendesk-mcp-server/",
  "stderrLines": 15,
  "parseErrorCount": 2,
  "lastParseError": "Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON"
}
```

```jsonc
// → sut_call_tool({"name":"echo","arguments":{"text":"still-works"}})
{
  "ok": true,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "still-works"
      }
    ]
  }
}
```

**AC-7 — stdout/stderr isolation: ✅ PASS** — SUT printed garbage to stdout; handshake still succeeded (ok=true). Malformed lines were captured as parse errors (parseErrorCount=2, last="Unexpected token 'j', ...""almost": json, but "... is not valid JSON") and did NOT break the protocol: echo→"still-works".

## AC-8 — Clean stop & no orphan processes

```jsonc
// → sut_stop({})
{
  "ok": true,
  "pid": 5221,
  "exitCode": 0
}
```

```jsonc
// → sut_start({})
{
  "ok": true,
  "pid": 5244,
  "serverInfo": {
    "name": "demo-sut-noisy",
    "version": "1.0.0-NOISY"
  },
  "capabilities": {
    "tools": {
      "listChanged": true
    }
  },
  "recentLogs": [
    "    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)",
    "    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)",
    "    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)",
    "Node.js v22.22.2",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo"
  ]
}
```

```jsonc
// → sut_reload({})
{
  "ok": true,
  "diff": {
    "added": [],
    "removed": [],
    "changed": [],
    "before": [
      "echo"
    ],
    "after": [
      "echo"
    ]
  },
  "pid": 5267,
  "recentLogs": [
    "Node.js v22.22.2",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo"
  ]
}
```

```jsonc
// → sut_status({})
{
  "state": "running",
  "running": true,
  "pid": 5267,
  "lastExitCode": 0,
  "lastExitSignal": null,
  "lastError": null,
  "serverInfo": {
    "name": "demo-sut-noisy",
    "version": "1.0.0-NOISY"
  },
  "command": "/opt/node22/bin/node",
  "args": [
    "/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs",
    "/home/user/zendesk-mcp-server/poc/sut/noisy.ts"
  ],
  "cwd": "/home/user/zendesk-mcp-server/",
  "stderrLines": 21,
  "parseErrorCount": 2,
  "lastParseError": "Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON"
}
```

```jsonc
// → sut_reload({})
{
  "ok": true,
  "diff": {
    "added": [],
    "removed": [],
    "changed": [],
    "before": [
      "echo"
    ],
    "after": [
      "echo"
    ]
  },
  "pid": 5290,
  "recentLogs": [
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token '=', \"==== demo-\"... is not valid JSON",
    "[meta-mcp] transport error (ignored, SUT kept alive): Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON",
    "[demo-sut noisy] ready despite stdout noise — 1 tool: echo"
  ]
}
```

```jsonc
// → sut_status({})
{
  "state": "running",
  "running": true,
  "pid": 5290,
  "lastExitCode": 0,
  "lastExitSignal": null,
  "lastError": null,
  "serverInfo": {
    "name": "demo-sut-noisy",
    "version": "1.0.0-NOISY"
  },
  "command": "/opt/node22/bin/node",
  "args": [
    "/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs",
    "/home/user/zendesk-mcp-server/poc/sut/noisy.ts"
  ],
  "cwd": "/home/user/zendesk-mcp-server/",
  "stderrLines": 24,
  "parseErrorCount": 2,
  "lastParseError": "Unexpected token 'j', ...\"\"almost\": json, but \"... is not valid JSON"
}
```

```jsonc
// → sut_stop({})
{
  "ok": true,
  "pid": 5290,
  "exitCode": 0
}
```

**AC-8 — Clean stop / no orphans: ✅ PASS** — pids across 1 start + 2 reloads: [5244,5267,5290]. After stop, all are dead (orphans alive=[], finalPid 5290 alive=false).

## AC-9 — Whole loop in one client session

**AC-9 — Single-session executability: ✅ PASS** — Every step above ran against ONE meta-MCP process connected once over stdio (single client session). No reconnect/initialize was issued to the meta-MCP between AC-1 and AC-8; only the SUT subprocess was spawned/killed. The same is true when the meta-MCP is configured in Claude Code web — see poc/README.md.

```jsonc
// → sut_stop({})
{
  "ok": true,
  "pid": null,
  "exitCode": 0,
  "error": "SUT was not running."
}
```

## Summary
✅ AC-1 Initial load: PASS
✅ AC-2 Proxied listing: PASS
✅ AC-3 Proxied call: PASS
✅ AC-4 Hot reload (CORE): PASS
✅ AC-5 Meta surface persistence: PASS
✅ AC-6 Crash robustness: PASS
✅ AC-7 stdout/stderr isolation: PASS
✅ AC-8 Clean stop / no orphans: PASS
✅ AC-9 Single-session executability: PASS