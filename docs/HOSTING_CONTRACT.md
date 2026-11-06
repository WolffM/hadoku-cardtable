# cardtable's hosting contract with fleet-manager

What every cardtable slice must be, in one place. Section numbers are stable: alerts and code cite
them.

**`hosting.json` (repo root) is the machine-readable half.** fleet-manager registers it as our
request (`fleet hosting-request WolffM/hadoku-cardtable --register`; a change to the file needs a
fresh registration). cardtable's placement reads its host order and slice limits from the same
file (`apps/server/src/play/placement/contract.ts`), so the two can't disagree. A copy in
`rules.ts` did, and held CI red for 12 h on 2026-11-04. This page says what each field promises.

**Checked continuously.** Every fleet poll, `apps/server/src/play/placement/audit.ts` reads
fleet-manager's own reports (`node-status`, and `hosting-demand`'s last converger pass) against
this contract. A violation that holds for 5 min posts one ⚠️ **Hosting contract** alert
(`contract:<key>`), citing the section; it resolves when the contract is kept again. To check by
hand, read-only:

```sh
apps/server/node_modules/.bin/tsx scripts/hosting/contract-check.ts   # exit 1: a violation
```

## §1 How many

- **Units and claws are two numbers** (fleet-manager e481a94, 2026-11-04). The count we restate
  every poll with `fleet hosting-demand cardtable --slices N`, and `slices.min..max` (3..4 today),
  count **units** of `slices.unit`. A claw holds one slice of k units (`declared[].memoryMb` =
  k × 4096). Claws have a floor of their own, `spread.minNodes` (the fleet default, 3, while
  `hosting.json` names none).
- fleet-manager serves **max(demand, minNodes) units on at least minNodes claws**. An extra unit
  goes to the best claw with room in `placement.order`, resized in place; too many shrinks a claw
  (an `ends` notice of kind `hosting` with `shrinkTo`) and ends a whole claw only while more than
  minNodes would remain.
- *Serving* means declared for us, not ending, on a node that keeps §2–§4: the converger's own
  `lastPass.serving` and `lastPass.servingUnits`.
- It may hold more only to replace a slice on a box that **cannot be reached**. It ends any other
  extra from the head of our `--release-order`, with our notice.
- A slice under the reboot cycle's own announced reboot still serves (request §11).
- Checked: `count:over` (more units held than max(demand, minNodes), beyond unreachable claws),
  `count:short` (fewer units serving than that, or fewer claws than minNodes).

## §2 Where

- Only on a node that meets every `placement.require` rule:
  - `wired`: on a cable, not Wi-Fi.
  - `not-beside-unbounded`: nothing else on the node holds memory without a ceiling. A ceiling is
    the smallest `memory.max` from a unit's cgroup up to the root, so a unit that reads
    `MemoryMax=infinity` inside a bounded slice is bounded. Misreading that is what broke this
    on 2026-11-04 (below).
- Ranked by `placement.order`: **claw-8, claw-9, claw-10, claw-5** (operator, 2026-10-31 and
  2026-11-03), ahead of CI cost.
- fleet-manager checks this when it declares (`hosting-plan`). §3 is what keeps it true afterwards.

## §3 Kept where it is

- A node keeps meeting every `require` rule **for as long as it holds one of our slices**.
  fleet-manager places nothing there that breaks one: no other tenant's slice or standby, and no
  pm2 service or unit without a memory ceiling.
- If something does break one, fleet-manager removes or bounds the newcomer. It does not answer
  by declaring us a replacement; that breaks §1 as well.
- Checked: `kept:<node>:<rule>`, from fleet-manager's own verdict (`lastPass.unplaceable` with
  `fails "<rule>"`).

## §4 What each slice gives

Per unit; a claw's slice of k units gives k times the memory and cores.

| | promise | `hosting.json` |
| --- | --- | --- |
| memory | 4096 MB a unit, **guaranteed** (`memory.min` in force), never reclaimed for CI or another tenant | `slices.unit.memoryMb` |
| cores | 4 a unit | `slices.unit.cores` |
| port | 7621, reachable from the controller (hokon) | `network.ports`, `network.ingress: controller` |
| disk | 4 GB of state (2 GB until 2026-11-06: the draft bot's tree, ~1.1 GB a version, two kept) | `disk.stateGb` |
| agent | installed from our kept artifact and supervised; its JVMs outlive our restarts | `runtime` |
| isolation | CI on the node cannot read it | `isolation.ciMayRead: false` |
| state | `guaranteed` in `node-status` | |

Checked from `node-status`: `slice:<node>:memory|cores|port|state|guarantee|observed-cores`
(`declared`, `observed.memoryMinMb`, `observed.cores`, `state`). A box that is down, or inside its
announced reboot, is §1's business.

## §5 Notice

- No slice ends, and no node holding one reboots, with less than **15 min** notice
  (`availability.noticeMin`). The notice is announced in `node-status` `notices`: a `starts`
  notice of kind `reboot`, an `ends` notice of kind `hosting`.
- Checked: the coordinator times each notice from when it first reaches our reads, allowing 2 min
  for read lag, and posts a short one once.

## §6 What we read

Our side of the interface. A change to any of these fields is a contract change, so tell us first.

- `node-status --json`, contract 1: `generatedAt`; per node `node`, `reachable`, `ok`,
  `findings[]` and `notices[]{event,at,kind,shrinkTo?}`; for our primary slice in `tenants[]`: `state`,
  `declared.{tenant,memoryMb,cores,port,role}`,
  `observed.{agent,portReach,memoryInUseMb,memoryMinMb,cores}` and `until`.
- `hosting-demand --json`, contract 1: `auto`, `demand.slices`, `limits.minNodes`,
  `declared[]{node,memoryMb}`, `ending[]`, and
  `lastPass.{live,actions,blocked,serving,servingUnits,unplaceable}`. The unit fields are read as
  optional, so an older fleet-manager reads as one unit per claw.

## What cardtable does on its side

- **Uses only the slices it asked for.** Matches go to the first N usable claws in
  `placement.order`, spread by free room (`rules.ts` `inUse`). Any other claw takes matches,
  in order, once those are full.
- **hokon is emergency-only, by fleet-manager's rule** (the operator, 2026-11-04: "fleet-manager
  decides how that works"). hokon takes a match only when no claw can: it is promoted at once
  then, and stands down as soon as one claw can again. Fewer claws than `slices.min` is the
  converger's shortfall to replace, not a trigger. cardtable computes this from its own bars until
  fleet-manager reports the decision itself in `hosting-demand`'s `backstop` object.
- **Keeps using a slice that §3 says breaks a rule.** The newcomer is fleet-manager's to remove.
  Moving players to a slower box would make them pay for it.
- **Asks with `hosting-demand` only.** It never declares or ends a slice itself.

## Where it stands

**Kept** since 2026-11-04 19:37Z: `contract-check.ts` exits 0, and claw-8 and claw-9 are serving.

**What happened that day.** watchparty's standby went onto claw-8 at 14:19Z, and archivebot's onto
claw-9 at 18:10Z. Each service unit reads `MemoryMax=infinity`, but runs inside a bounded slice:
`hosting-watchparty.slice` at 1536 MiB, `hosting-archivebot.slice` at 1024 MiB. fleet-manager read
the unit, judged our slices on claw-8 and claw-9 unplaceable under §3, and declared claw-10
(12:11Z) and claw-5 (18:14Z) to make up the count. That left 4 slices for our demand of 2, a §1
breach. cardtable's first diagnosis read the unit the same way and called the services unbounded;
they never were.

fleet-manager 3ebf625 (0.34.340, live about 19:20Z) reads the effective ceiling instead. Its
converger then ended claw-10 and claw-5, with our 15 min notice, at 19:47:41Z. Placement that also
checks the rules of the tenants already on a node is fleet-manager's to land
([request §12](requests/FLEET_MANAGER_FORGE_HOSTING.md#12-keep-the-contract-added-2026-11-04)).
