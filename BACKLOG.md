# Backlog

Known gaps, in the order they would mislead a reader.

---

## Credibility review — 2026-07-27

A hostile-but-fair peer-review sweep of the report copy (canonical in
[Provenance-Search-Paper.md](Provenance-Search-Paper.md), mirrored on the site
in `website/src/content/publications/provenance-search.ts`). Fix in both places.

### 1. The "recompute by hand" score does not add up

§05 (variables) is the section whose selling point is "the score can be
recomputed by hand." With a 100 base and 30 points deducted per custody gap,
"Three take the score to zero on their own" is false: 3 × 30 = 90, leaving 10;
four gaps are needed to reach zero. In the one place the report invites the
reader to check the arithmetic, the arithmetic is wrong. Fix: change to "Three
leave the score at 10" or "Four take the score to zero."

### 2. (Lower priority) "Free public source" describes a commercial service

§01/§07 call Tavily a "free public source," though it is a commercial keyed
service; the text elsewhere discloses this, so reconcile the wording.
