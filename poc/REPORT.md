# Rapport de validation — PoC Meta-MCP de pilotage d'un SUT

> Hypothèse : un meta-MCP générique, chargé **une fois** au démarrage de session,
> peut piloter un serveur MCP cible (SUT) — start / reload après édition / list / call —
> **sans relancer la session LLM ni renégocier les capabilities côté client**,
> parce que la surface vue par le LLM (les meta-tools) est **figée**.

**Verdict : hypothèse VALIDÉE. 9/9 AC ✅, dont les deux AC bloquants (AC-4, AC-9).**

---

## En-tête

| | |
|---|---|
| **Node** | v22.22.2 |
| **Langage** | TypeScript, exécuté via `tsx` (pas d'étape de build pour le SUT → le reload relit la source) |
| **SDK MCP** | `@modelcontextprotocol/sdk` **1.29.0** (déjà dépendance du repo) |
| **Transport** | stdio des deux côtés (client→meta, meta→SUT) |
| **Validation** | `node node_modules/tsx/dist/cli.mjs poc/validate.ts` → exit `0` |
| **Date du run** | 2026-05-31T05:29Z |

### Arborescence

```
poc/
├── meta-mcp/{index.ts, sut-controller.ts, config.ts}
├── sut/{server.ts (live A), variants/{variant-a.ts, variant-b.ts}, broken.ts, noisy.ts}
├── validate.ts
├── artifacts/{transcript.md, results.json}
├── README.md
└── REPORT.md
```

### Commande de config dans Claude Code (`mcpServers`)

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

Surface exposée (figée) : `sut_start, sut_stop, sut_reload, sut_list_tools, sut_call_tool, sut_status, sut_logs`.

---

## Tableau des AC

| AC | Statut | Preuve | Commentaire |
|---|:---:|---|---|
| **AC-1 — Chargement initial** | ✅ | `sut_start` → `ok:true, pid:4242, serverInfo:{demo-sut,1.0.0-A}` ; `sut_status` → `running:true`. *(transcript §AC-1)* | Handshake `initialize` SUT réussi ; capabilities SUT remontées (`tools.listChanged:true`). |
| **AC-2 — Listing proxifié** | ✅ | `sut_list_tools` → exactement **1 tool `echo`**, avec `description`, `inputSchema` (draft-07) et `annotations:{readOnlyHint:true,openWorldHint:false}` intacts. *(§AC-2)* | Passe-plat fidèle de `tools/list` du SUT. |
| **AC-3 — Appel proxifié** | ✅ | `sut_call_tool("echo",{text:"hi"})` → `content:[{type:"text",text:"hi"}]`. *(§AC-3)* | `content` brut du SUT renvoyé tel quel. |
| **AC-4 — Hot reload (CŒUR)** | ✅ | Édition source A→B (copie `variant-b.ts`→`server.ts`), puis `sut_reload` → diff `{added:["reverse"], changed:["echo"]}` ; `sut_list_tools` → **2 tools** ; `sut_call_tool("reverse",{text:"abc"})` → **`"cba"`**. *(§AC-4)* | **Aucun restart** : même process meta-MCP, même session stdio. Seul le sous-process SUT a changé de pid (4242→4271). |
| **AC-5 — Persistance surface meta** | ✅ | Liste meta-tools **byte-identique** avant AC-2 et après AC-4 : `[sut_call_tool, sut_list_tools, sut_logs, sut_reload, sut_start, sut_status, sut_stop]`. *(§AC-5)* | La mutation 1→2 du SUT est invisible côté client : elle se produit derrière `sut_list_tools`. **Zéro dépendance à `list_changed` côté client** (voir justification ci-dessous). |
| **AC-6 — Robustesse au crash** | ✅ | `sut_start(broken)` → `isError:true`, `error:"MCP error -32000: Connection closed"` + `recentLogs` avec la stack du throw. Le meta-MCP répond encore à `sut_status` (`state:"error"`, `lastExitCode:1`) et `sut_logs` (10 lignes). *(§AC-6)* | Le crash du SUT remonte comme **résultat structuré**, jamais comme coupure du meta-MCP. Process à demi-spawné nettoyé (best-effort `close()`). |
| **AC-7 — Isolation stdout/stderr** | ✅ | SUT « noisy » pollue stdout (2 lignes non-JSON) : handshake **réussi** quand même (`ok:true`), `parseErrorCount:2` capturés sans corruption, puis `echo("still-works")` → `"still-works"`. *(§AC-7)* | Les lignes hors-protocole sont remontées en erreurs de parse claires (`sut_status.lastParseError`) et **ignorées** ; le flux JSON-RPC reste intègre. |
| **AC-8 — Arrêt propre / pas de zombie** | ✅ | 1 start + 2 reload → pids `[4358, 4381, 4404]`. Après `sut_stop` : `orphansAlive:[]`, dernier pid `alive:false` (vérifié via `process.kill(pid,0)`). *(§AC-8)* | `close()` du SDK fait SIGTERM→SIGKILL avec timeouts ; aucun process orphelin après deux cycles. |
| **AC-9 — Exécutable depuis Claude Code web** | ✅ | Toute la séquence AC-1→AC-8 s'est déroulée contre **un seul** `connect()` au meta-MCP (une session client unique) ; aucun `initialize` rejoué côté meta. Config `mcpServers` fournie ci-dessus. *(§AC-9)* | La boucle AC-4 est réalisable telle quelle dans une session Claude Code unique : seul le sous-process SUT est tué/relancé. |

> Preuves intégrales (transcript appel-par-appel) : [`artifacts/transcript.md`](artifacts/transcript.md) — verdicts machine : [`artifacts/results.json`](artifacts/results.json).

### Justification AC-5 (pourquoi `list_changed` est hors-jeu)

Le client (Claude Code) ne négocie les tools qu'**une fois**, au `initialize` du meta-MCP.
Les 7 meta-tools sont enregistrés statiquement et ne changent jamais. Quand le SUT passe
de 1 à 2 tools, **rien ne change dans la liste du meta-MCP** : le changement n'est observable
qu'en **appelant** `sut_list_tools` (un *appel d'outil*, pas une renégociation de capabilities).
Le PoC ne déclenche donc jamais `notifications/tools/list_changed` vers le client et n'en
dépend pas. C'est exactement ce qui contourne le bug de re-fetch côté client.

---

## Section findings (obligatoire)

### 1. `list_changed` chez le client Claude Code web — **non testé**

Non testé de façon concluante côté **client Claude Code web**, et c'est acceptable car le PoC
est précisément conçu pour **ne pas en dépendre**. Précisions factuelles observées :

- Les serveurs SUT annoncent pourtant `capabilities.tools.listChanged: true` (visible dans
  `sut_start` au transcript), et le meta-MCP (via `McpServer`) l'annonce aussi par défaut.
- Mais le meta-MCP **n'émet jamais** `tools/list_changed` : sa liste est immuable. Le test
  « SUT qui mute 1→3 après init, le client le voit-il sans meta-tools ? » nécessiterait
  d'instrumenter le client Claude Code web lui-même (hors du runner stdio autonome utilisé ici).
- La valeur du PoC est justement d'être **agnostique** à ce comportement client : qu'il
  rafraîchisse ou non, la boucle de dev fonctionne via les meta-tools.

### 2. Limites rencontrées

- **Code/signal de sortie du SUT.** `StdioClientTransport` n'expose pas le process enfant.
  Récupéré proprement via une sous-classe (`TrackedStdioTransport`) qui pose un listener
  `exit` additionnel — sans toucher au lifecycle du SDK. Sinon le « dernier code de sortie »
  ne serait pas disponible.
- **Erreurs de parse vs exceptions.** Les lignes stdout malformées déclenchent
  `transport.onerror`, que le `Client` écrase au `connect()`. On capte donc l'événement via
  `client.onerror` (hook public du `Protocol`), pas via le transport, pour ne pas se faire
  écraser le handler.
- **Lifecycle / signaux.** Le meta-MCP installe `SIGINT`/`SIGTERM` → `controller.stop()` afin
  de ne pas orphaniser le SUT si le meta-MCP est tué. `close()` du SDK gère SIGTERM→SIGKILL.
- **Env transmis au SUT.** Le SDK ne propage qu'un env « sûr » (`getDefaultEnvironment`). On
  forwarde explicitement `PATH/HOME/NODE_OPTIONS/TMPDIR/LANG/LC_ALL` + l'`env` d'override, sinon
  `node`/`tsx` peuvent ne pas se résoudre selon l'hôte.
- **`tsx` plutôt que build.** Choix délibéré : exécuter le SUT en `.ts` direct rend le reload
  fidèle à l'édition de source, sans `tsc`/`tsdown` entre deux itérations.

### 3. Recommandation finale

**Le meta-MCP est une base de travail viable** — et plus adaptée que `mcpmon` pour cet objectif :

- `mcpmon` est un **proxy transparent** : il préserve la surface réelle du SUT et **rejoue/dépend
  de `tools/list_changed`** vers le client pour refléter les reloads. Or c'est précisément ce
  signal qu'on ne peut pas tenir pour acquis (le bug à l'origine du PoC). `mcpmon` réintroduit
  donc la dépendance qu'on cherche à éliminer.
- Le meta-MCP **déplace l'interaction d'une frontière de *capabilities* (fragile) vers une
  frontière d'*appels d'outils* (robuste)**. La surface est figée, la mutation est lue à la
  demande. C'est strictement indépendant du comportement client.
- Coût : le LLM appelle des tools « enveloppe » (`sut_*`) plutôt que les tools réels du SUT —
  un léger surcoût d'ergonomie/prompt, acceptable en phase de développement.

**Conclusion :** garder le meta-MCP comme harnais de dev. Réserver un proxy transparent type
`mcpmon` au jour où l'on cible un usage *runtime* (et où le client gère fiablement
`list_changed`), pas le dev en session LLM.

---

## Questions ouvertes — décisions

- **Q1 — Diff de tools dans `sut_reload` :** **retenu et fiable**, car calculé côté meta-MCP en
  comparant deux snapshots `tools/list` (avant stop / après respawn) — pas une heuristique. On
  renvoie `{added, removed, changed, before, after}` (`changed` = description modifiée).
  Voir AC-4. On **invite quand même** à `sut_list_tools` pour le schéma complet (le diff ne porte
  que sur les noms + descriptions).
- **Q2 — Identité du SUT :** **config par défaut codée en dur + override** (préférence PO).
  Défaut dans `meta-mcp/config.ts` (lance `poc/sut/server.ts` via `tsx`) ; chaque champ
  (`command/args/cwd/env`) est surchargeable par `sut_start`. C'est ce qui permet de pointer
  `broken.ts`/`noisy.ts` dans les tests AC-6/AC-7.
- **Q3 — Réinjection des mocks backend :** le SUT tournant en sous-process isolé, l'approche
  retenue est **par variables d'environnement** passées à `sut_start({ env })` (puis fusionnées
  dans l'env du spawn). Pour un backend HTTP (ex. Zendesk), on injecterait une `BASE_URL`
  pointant un faux serveur, ou un flag `MOCK=1`. Alternative documentée : fichier de fixtures lu
  par le SUT via un chemin passé en env. Hors AC, mais l'« seam » `env` est déjà en place et testé.

---

## Artefacts

- Meta-MCP : `poc/meta-mcp/{index.ts, sut-controller.ts, config.ts}`
- SUT démo : `poc/sut/{server.ts, variants/variant-a.ts, variants/variant-b.ts, broken.ts, noisy.ts}`
- Runner : `poc/validate.ts`
- Transcript de validation (dont AC-4) : `poc/artifacts/transcript.md`
- Verdicts machine : `poc/artifacts/results.json`
