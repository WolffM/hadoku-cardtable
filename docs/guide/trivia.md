# Card Table: trivia

Each fact names the commit it comes from.

## Trivia

- **The whole plan, one commit.** The first commit (`7a2108d`, 2026-09-11)
  scaffolded a Forge fork plus a browser room layer, with the full design
  argument already written, before a line of game logic existed.
- **445 commits in a day.** The busiest day in the repo's history is
  2026-10-21 (fact sheet, 2026-11-16).
- **The biggest single commit.** `f13ed39` rewrote 1.19 million lines in one
  go, moving the card library forward to Pro Tour 2025's summer — still the
  largest commit the repo has ever had.
- **Spike to live in 49 minutes.** A private companion repo's neural
  draft-rating service was measured for cost (`138e8f911`), re-measured on a
  lighter backend (`61ae017a2`), and wired into live drafts as the bots'
  first choice (`7b2be16fc`) — all three on the same morning, 2026-11-06.
- **Three commits, one tree reshaped.** Over two days, `6f0c583`,
  `1c1ee38a4` and `8793ca5` each moved hundreds of thousands of lines,
  relocating every Magic-specific package out of `apps/` and into its own
  home, to leave room for more than one game on the same room layer.
- **Free in three days.** The operator's decision to make the app free for
  any member (`8d25176d8`, 2026-10-30) was live in production
  (`b000d90f1`) by 2026-11-02.
- **The longest subject line.** `285e2c2`'s subject is 688 characters
  (`git show -s --format=%s 285e2c2 | wc -m`; fact sheet, 2026-11-16). It is
  one sentence specifying the exact physics of one punch animation: windup,
  exponential charge curve, and how it is journaled when it hits a
  planeswalker instead of a creature.
- **A miscounted enum.** An unanchored `grep -c 'Mode\.'` over Forge's
  network-protocol enum returns 59 methods; the real count is 57, because
  a `Mode.SERVER` and a `Mode.MACRO` sit inside method bodies, not the
  enum's own cases. Re-deriving the project's Forge counts for the
  2026-11-08 pin caught it (`0e638b5a4`).
