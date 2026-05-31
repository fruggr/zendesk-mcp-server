# Meta-MCP PoC — piloter un serveur MCP « sous test » sans relancer la session

Ce PoC démontre qu'un **meta-MCP** générique, chargé **une seule fois** au démarrage
d'une session LLM, peut piloter un serveur MCP cible (**SUT**, *Server Under Test*) :
le démarrer, le **recharger après édition du code**, lister et appeler ses tools —
**sans jamais relancer la session du LLM ni renégocier les capabilities** côté client.

La clé : la surface d'outils vue par le LLM est **figée** (les 7 meta-tools ci-dessous).
Toute mutation du SUT se produit *derrière* cette surface, donc indépendamment de
`notifications/tools/list_changed`.

## Arborescence

```
poc/
├── meta-mcp/
│   ├── index.ts          # serveur MCP stdio : enregistre les 7 meta-tools, connecte stdio
│   ├── sut-controller.ts # cycle de vie du SUT + rôle client MCP (start/stop/reload/list/call)
│   └── config.ts         # config SUT par défaut (Q2 : défaut codé en dur + override)
├── sut/
│   ├── server.ts         # SUT de démo LIVE & ÉDITABLE — démarre en variante A
│   ├── variants/
│   │   ├── variant-a.ts  # référence A : 1 tool (echo)
│   │   └── variant-b.ts  # référence B : 2 tools (echo desc. modifiée + reverse)
│   ├── broken.ts         # SUT qui crashe au démarrage (AC-6)
│   └── noisy.ts          # SUT qui pollue stdout puis fonctionne (AC-7)
├── validate.ts           # runner automatisé AC-1…AC-9 → artefacts
├── artifacts/
│   ├── transcript.md     # transcript complet appels/réponses (preuve)
│   └── results.json      # verdicts machine
├── REPORT.md             # rapport de validation
└── README.md             # ce fichier
```

## Les 7 meta-tools (surface figée)

| Tool | Entrée | Sortie | Annotations |
|---|---|---|---|
| `sut_start` | `{ command?, args?, cwd?, env? }` | statut + handshake `initialize` | `readOnlyHint:false, openWorldHint:true` |
| `sut_stop` | `{}` | confirmation d'arrêt propre | `readOnlyHint:false, destructiveHint:true` |
| `sut_reload` | `{}` | tue puis respawn ; renvoie le diff de tools | `readOnlyHint:false` |
| `sut_list_tools` | `{}` | tools du SUT (name, description, inputSchema, annotations) | `readOnlyHint:true` |
| `sut_call_tool` | `{ name, arguments }` | passe-plat `tools/call` ; `content` brut du SUT | `readOnlyHint:false` |
| `sut_status` | `{}` | pid, running/stopped/error, dernier code/signal, dernière erreur | `readOnlyHint:true` |
| `sut_logs` | `{ lines? }` | dernières lignes de `stderr` du SUT | `readOnlyHint:true` |

## Lancer la validation automatisée

Pré-requis : `pnpm install` à la racine du repo (installe `@modelcontextprotocol/sdk` + `tsx`).

```bash
node node_modules/tsx/dist/cli.mjs poc/validate.ts
```

Le runner se connecte au meta-MCP exactement comme le ferait Claude Code (stdio),
puis déroule AC-1…AC-9 en n'appelant **que** les meta-tools. Code de sortie `0`
si tous passent et que les AC bloquants (AC-4, AC-9) sont verts.

## Configuration dans Claude Code (web/desktop) — entrée `mcpServers`

Le meta-MCP se branche en **stdio**. On lance le SUT en TypeScript via le CLI `tsx`
local (aucun `npx`, aucun réseau, et les éditions de `poc/sut/server.ts` sont prises
en compte au prochain `sut_reload` sans étape de compilation).

```json
{
  "mcpServers": {
    "meta-mcp": {
      "command": "node",
      "args": [
        "/home/user/zendesk-mcp-server/node_modules/tsx/dist/cli.mjs",
        "/home/user/zendesk-mcp-server/poc/meta-mcp/index.ts"
      ]
    }
  }
}
```

> Adapter le chemin absolu à votre clone. Une variante `npx tsx <…>/index.ts` marche
> aussi mais dépend du réseau au premier lancement.

## La boucle de dev (cœur du PoC), dans une seule session

1. l'agent édite `poc/sut/server.ts` (p. ex. ajoute un tool `reverse`) ;
2. `sut_reload()` — tue l'ancien process, respawn, renvoie le diff ;
3. `sut_list_tools()` — le nouveau tool apparaît ;
4. `sut_call_tool({ name: "reverse", arguments: { text: "abc" } })` → `cba` ;
5. recommencer.

À aucun moment la session LLM ni le meta-MCP ne sont relancés : seul le **sous-process
SUT** est tué/relancé, derrière la surface figée des meta-tools.
