# Rapport — Rafraîchissement dynamique des tools MCP dans Claude Code web

**Question tranchée :** quand un serveur MCP modifie sa liste de tools en cours de
session et émet `notifications/tools/list_changed`, le client **Claude Code web**
rafraîchit-il sa liste, rendant un tool nouvellement ajouté (`reverse`) appelable
**dans la même session, sans relance** ?

**Verdict (résumé) : INCONCLUSIF sur le client.** Le prérequis §5 (mcpmon relance bien
le SUT `.ts` à l'édition et émet `list_changed`) est **ÉTABLI**. Mais un prérequis
plus fondamental, propre au modèle d'exécution de Claude Code web, n'est **pas**
rempli : le serveur SUT n'a pas pu être attaché à la session de l'agent en cours, donc
les tools `echo`/`reverse` n'ont jamais été appelables par l'agent. Le test client
n'a donc pas pu être administré (ce n'est **pas** un échec du client ; voir §Verdict).

---

## En-tête

### Versions

| Composant      | Version             | Source |
|----------------|---------------------|--------|
| Node.js        | `v22.22.2`          | `node --version` |
| mcpmon         | `1.0.1`             | `npx -y mcpmon` (package résolu dans `~/.npm/_npx/.../mcpmon`) |
| tsx            | `4.22.3`            | `npx tsx --version` / `node_modules/.bin/tsx` |
| SDK MCP        | `@modelcontextprotocol/sdk@1.29.0` | dépendance du projet, installée pour le SUT |
| Protocole MCP  | `2024-11-05`        | négocié à l'`initialize` |

### Mécanisme de watch mcpmon retenu

L'aide de `mcpmon 1.0.1` (`npx -y mcpmon --help`) impose une **syntaxe différente**
de celle suggérée dans la consigne §4 :

```
Usage:  mcpmon [options] -- <command>
  -w, --watch <dir>   Directory to watch (default: .)
  -e, --ext <exts>    Extensions to watch, comma-separated (default: py)
```

Deux écarts critiques par rapport au modèle de la consigne :

1. **Séparateur `--` obligatoire** entre les options mcpmon et la commande serveur.
2. **Extension par défaut = `py`.** Le SUT est un `.ts` exécuté par `tsx` ; sans
   `--ext ts`, mcpmon **ne surveillerait pas** `server.ts`. Il faut donc `--ext ts`.

Mécanisme retenu et **confirmé empiriquement** : `--watch poc/sut --ext ts`. La preuve
§5 montre le log `[mcpmon] Watching poc/sut for .ts changes` puis
`[mcpmon] File modified: server.ts` au moment de l'édition. mcpmon détecte donc bien
l'édition d'un `.ts` exécuté par tsx.

### Entrée `mcpServers` exacte utilisée

(fichier `poc/mcp-config.example.json` — ajusté à la syntaxe mcpmon 1.0.1 confirmée
ci-dessus ; déplacé hors de la racine pour ne pas auto-démarrer le serveur dans le
projet principal) :

```json
{
  "mcpServers": {
    "sut-hotreload": {
      "command": "npx",
      "args": ["-y", "mcpmon", "--watch", "poc/sut", "--ext", "ts", "--", "npx", "tsx", "poc/sut/server.ts"],
      "cwd": "/home/user/zendesk-mcp-server"
    }
  }
}
```

---

## Écart par rapport à la consigne §3 (réutilisation du SUT existant)

**La consigne affirme que `poc/sut/server.ts`, `poc/sut/variants/variant-a.ts` et
`poc/sut/variants/variant-b.ts` existaient déjà sur la branche. Ce n'était pas le
cas** : le répertoire `poc/` était absent (`find` + `git log` ne trouvent aucun de ces
fichiers sur `claude/mcp-tools-dynamic-refresh-qmprx` ni `main`). Conformément à
l'instruction « adapte-toi… et documente l'écart », je les ai **créés** en respectant
le contrat décrit :

- `variant-a.ts` : 1 tool `echo` ; marqueur stderr `SUT variant A ready — 1 tool (echo)`.
- `variant-b.ts` : `echo` (description **modifiée**) + `reverse` ; marqueur stderr
  `SUT variant B ready — 2 tools (echo, reverse)`.
- `server.ts` : copie de `variant-a.ts` (état A initial).

Serveurs MCP réels (stdio, SDK officiel `@modelcontextprotocol/sdk`), annonçant
`capabilities.tools.listChanged: true`. Aucun timer ni mutation programmatique : seul
le couple « édition de fichier + watch mcpmon » déclenche le reload, comme demandé.

---

## Feasibilité : le SUT peut-il être appelé par l'agent dans CETTE session ?

C'est le point bloquant, et il a été testé **empiriquement**, sans le présupposer.

1. **Config MCP au démarrage de session = vide.** `~/.claude.json` :
   `mcpServers` global `{}` ; projet `/home/user/zendesk-mcp-server` →
   `mcpServers {}`, `enabledMcpjsonServers []`. Les seuls serveurs MCP attachés à la
   session sont des serveurs **distants** fournis par la plateforme web (Microsoft
   Graph, Todoist, data.gouv, github, etc.) — **pas** le SUT.

2. **Tentative d'attache à chaud.** J'ai écrit l'entrée `mcpServers` ci-dessus dans
   un `.mcp.json` à la racine, puis recherché les tools `sut-hotreload` / `echo` /
   `reverse` dans l'inventaire d'outils de la session (mécanisme `ToolSearch`).
   **Résultat : `No matching deferred tools found`.** Aucun tool du SUT n'apparaît.

   → Dans Claude Code (web comme CLI), l'inventaire des serveurs MCP est constitué au
   **démarrage de la session**. Ajouter une entrée `mcpServers` en cours de session ne
   « branche » pas un nouveau serveur stdio à chaud : ses tools ne deviennent pas
   appelables par l'agent sans **relancer la session** — ce que la consigne interdit
   explicitement pour l'observation décisive (§6.4).

**Conséquence directe :** je ne peux pas exécuter la boucle agentique §6 sur le SUT
(je ne peux ni établir la baseline A en appelant `echo`, ni tenter `reverse` après
édition), car ces tools ne font pas partie — et ne peuvent pas être ajoutés à chaud —
de l'inventaire de ma session. Cela ne dit **rien** sur la façon dont le client
honore `list_changed` : cela dit seulement que le test n'a pas pu être **administré**
au client dans ce contexte d'exécution.

---

## Déroulé §6 (preuve §5 établie via un client stdio manuel)

> **Important (respect de §6) :** je n'ai écrit **aucun runner** qui exécuterait la
> boucle de test à la place de l'agent pour répondre à la question **client**. Le test
> client ne peut être résolu que par le vrai client Claude Code rendant `reverse`
> appelable — ce qui, comme montré ci-dessus, est hors de portée dans cette session.
>
> Le script ci-dessous (`/tmp/probe.mjs`, **hors du repo**) est un **client MCP stdio
> distinct**, utilisé **uniquement** pour établir le prérequis §5 (côté serveur :
> mcpmon relance-t-il le SUT et émet-il `list_changed` ?). Ce n'est en aucun cas un
> substitut du client Claude Code, et il ne peut pas répondre à la question client
> (c'est un autre client).

Sortie brute du probe (horodatée) :

```
[06:08:49.430] reset server.ts -> variant A
[06:08:51.817] [mcpmon/sut stderr] [mcpmon] Watching poc/sut for .ts changes
[06:08:51.819] [mcpmon/sut stderr] [mcpmon pid:8111] Started: npx tsx poc/sut/server.ts
[06:08:51.935] >>> sent: initialize
[06:08:52.650] [mcpmon/sut stderr] SUT variant A ready — 1 tool (echo)
[06:08:52.663] <<< response id=1: {"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"sut-hotreload","version":"1.0.0-variant-a"}}
[06:08:53.436] >>> sent: notifications/initialized

=== STEP 1: baseline tools/list (expect echo only) ===
[06:08:53.738] >>> sent: tools/list
[06:08:53.740] <<< response id=2: {"tools":[{"name":"echo","description":"Echo back the provided text (variant A).", ... }]}

=== STEP 1b: call reverse on variant A (expect error / unknown tool) ===
[06:08:54.739] >>> sent: tools/call
[06:08:54.742] <<< response id=3: {"content":[{"type":"text","text":"MCP error -32602: Tool reverse not found"}],"isError":true}

=== STEP 2: EDIT A->B (copy variant-b.ts over server.ts) ===
[06:08:55.740] copied variant-b.ts -> server.ts; waiting for mcpmon reload...
[06:08:55.741] [mcpmon/sut stderr] [mcpmon] File modified: server.ts
[06:08:55.741] [mcpmon/sut stderr] [mcpmon pid:8111] Restarting...
[06:08:55.768] [mcpmon/sut stderr] [mcpmon pid:8157] Started: npx tsx poc/sut/server.ts
[06:08:55.768] [mcpmon/sut stderr] [mcpmon pid:8157] Restart #1 complete
[06:08:55.869] <<< NOTIFICATION from server: notifications/tools/list_changed
[06:08:55.869] [mcpmon/sut stderr] [mcpmon] Sent tools/list_changed notification
[06:08:56.515] [mcpmon/sut stderr] SUT variant B ready — 2 tools (echo, reverse)

=== STEP 4: tools/list after reload (expect echo + reverse) ===
[06:09:01.746] >>> sent: tools/list
[06:09:01.755] <<< response id=4: {"tools":[
    {"name":"echo","description":"Echo back the provided text (variant B — description updated).", ...},
    {"name":"reverse","description":"Reverse the provided text (variant B).", ...}
]}

=== STEP 4b: call reverse({text:'abc'}) after reload (expect cba) ===
[06:09:02.748] >>> sent: tools/call
[06:09:02.752] <<< response id=5: {"content":[{"type":"text","text":"cba"}]}
```

Correspondance avec les étapes §6 :

| Étape §6 | Observation (côté serveur, via client stdio manuel) |
|---|---|
| **1. Baseline A** | `tools/list` → `echo` seul. |
| **1b. `reverse` absent** | `tools/call reverse` → `-32602 Tool reverse not found`. ✅ conforme. |
| **2. Édition A→B** | `copyFileSync(variant-b.ts → server.ts)`. |
| **3. Reload mcpmon (§5)** | `File modified: server.ts` → `Restarting…` → `Restart #1 complete` → `Sent tools/list_changed notification` → `SUT variant B ready — 2 tools`. |
| **4. Après reload** | `tools/list` → `echo` (**description B mise à jour**) + `reverse`. |
| **4b. Appel `reverse`** | `reverse({text:"abc"})` → `"cba"`. |

---

## Preuve §5 (mcpmon a-t-il relancé le SUT en variante B ?)

**ÉTABLIE.** Extrait décisif des logs mcpmon/stderr du SUT, **dans le même processus,
sans relance manuelle** :

```
[mcpmon] File modified: server.ts
[mcpmon pid:8111] Restarting...
[mcpmon pid:8157] Started: npx tsx poc/sut/server.ts
[mcpmon pid:8157] Restart #1 complete
[mcpmon] Sent tools/list_changed notification
SUT variant B ready — 2 tools (echo, reverse)
```

mcpmon (1) surveille bien le `.ts`, (2) détecte l'édition, (3) redémarre le
sous-processus SUT (PID 8111 → 8157), (4) **émet `notifications/tools/list_changed`
vers le client**, et (5) le SUT redémarre en variante B. Le prérequis §5 est donc
**rempli** — l'éventuelle non-apparition de `reverse` ne pourrait pas être imputée à
mcpmon.

---

## Verdict (un seul cas §7, justifié par preuves)

> **INCONCLUSIF sur la question client — pour une cause distincte d'un échec §5.**

La trichotomie §7 suppose qu'on peut observer si `reverse` devient appelable par
l'agent en session. Or :

- **§5 est ÉTABLIE** (mcpmon relance le SUT et émet `list_changed` — preuve ci-dessus).
- **Mais l'observation décisive §6.4/§6.5 n'a pas pu être réalisée** : le serveur SUT
  n'était pas attaché à la session de l'agent au démarrage (config `mcpServers` vide),
  et il **ne peut pas être branché à chaud** dans une session Claude Code en cours
  (preuve : l'entrée `mcpServers` ajoutée en session ne fait apparaître aucun tool
  `sut-hotreload` dans l'inventaire). Ni `echo` (baseline) ni `reverse` ne sont
  appelables par l'agent — non pas parce que le client a refusé un `list_changed`,
  mais parce qu'aucun `list_changed` n'a jamais pu être adressé à **cette** session
  pour ce serveur (il n'y était pas).

Ce cas ne tombe donc proprement ni dans « Client OK » ni dans « Client KO » : il
correspond à l'esprit du **3ᵉ cas (Inconclusif)** — « rien ne peut être conclu sur le
client » — la cause précise étant ici le **modèle d'exécution de Claude Code web**
(serveurs MCP figés au démarrage de session, pas d'attache à chaud), et **non** un
problème mcpmon/watch. Conformément à la consigne (« ne force pas une conclusion »),
je **n'affirme pas** que le client web honore — ou n'honore pas — `list_changed` :
ce run ne l'a pas mis à l'épreuve.

### Comment le test serait concluant

Il faudrait démarrer une session Claude Code web **avec le serveur `sut-hotreload`
déjà déclaré dans `mcpServers` au lancement** (état A, 1 tool), puis, dans cette même
session : appeler `echo`, éditer A→B, et tenter `reverse` sans relance. Cette mise en
place n'est pas réalisable par l'agent depuis une session déjà démarrée sans le SUT.

---

## Comparaison ergonomique

Non applicable : « Client OK » n'a pas été démontré. (Note : côté serveur, mcpmon
**préserve bien les noms réels** `echo`/`reverse` — pas d'indirection par méta-outils —
de sorte que *si* le client rafraîchissait, l'agent appellerait `reverse` directement
par son nom.)

---

## Limites

- **Bloquant principal :** impossibilité d'attacher un serveur MCP stdio à une session
  Claude Code web **déjà démarrée**. C'est ce qui rend le test client non administrable
  ici, indépendamment de mcpmon.
- **Écart de syntaxe mcpmon :** la version résolue (1.0.1) exige `--` et `--ext ts`
  (défaut `py`), contrairement à la forme `args` suggérée dans la consigne §4.
- **Fichiers SUT absents** alors que §3 les disait présents : créés de novo (écart
  documenté plus haut).
- **Latence / buffering :** non bloquants ici. Le redémarrage mcpmon est quasi
  instantané (modif → `Restart complete` en ~30 ms) ; la `list_changed` est émise
  ~100 ms après, et le SUT B est « ready » ~750 ms après (boot `tsx`). mcpmon
  bufferise pendant le redémarrage (annoncé par son `--help`).
- **Menu `/mcp` :** non observable — l'agent headless ne pilote pas l'UI interactive.
- **`@modelcontextprotocol/sdk` non installé** initialement (pas de `node_modules`) :
  installé pour les besoins du PoC.

---

## Reproduire

```bash
# 1. déclarer le serveur dans la config MCP de session AVANT de démarrer la session :
#    contenu de poc/mcp-config.example.json (état A en place : server.ts == variant A)
# 2. dans la session : appeler echo, puis
cp poc/sut/variants/variant-b.ts poc/sut/server.ts   # édition A -> B
# 3. sans relancer la session : appeler reverse({text:"abc"})
#    -> "cba" => client OK ; "tool inconnu" (avec preuve §5) => client KO
```
