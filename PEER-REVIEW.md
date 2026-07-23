# Peer Review — Provenance Search: An Automated Ownership-History Check for Artworks and Cultural Objects

**Reviewed as:** Referee for a masters-level research report / applied-computing venue in cultural-heritage informatics and ethical technology (Ethical Tech CoLab, NYU Center for Global Affairs).

**Recommendation:** Major revisions

**Date:** 22 July 2026

**Overall assessment:** This is an unusually honest, well-organised description of a working prototype, and its central design instincts — deterministic scoring, a rule-based watchlist the model cannot override, and treating gaps as findings — are the right ones for this domain. But as a *research* report rather than a technical README, it has two structural gaps that block acceptance: it never evaluates whether the tool actually works (no test cases with known ground truth, no error analysis), and it never situates its contribution against prior work in computational provenance. A closely related third problem is that the paper's headline claim — a score that "cannot drift with the mood of a language model" — is overstated, because the score's inputs are produced by exactly that language model and are never checked.

---

## Summary of the submission

The report documents *Provenance Search*, a deployed web prototype that automates the first-pass assembly of an artwork's ownership history from free, public sources. A user supplies a title and artist (or a photograph, which Gemini identifies); the system queries seven public sources in parallel — a restricted commercial web search (Tavily, confined to thirteen institutional and market domains), three museum catalogues (Met, Art Institute of Chicago, a bundled MoMA dataset), Wikipedia, Wikidata, and Europeana. Gemini assembles the returned material into a dated, source-attributed ownership timeline, explicitly inserting "custody gap" entries where a period is unaccounted for, and is permitted a narrowly fenced "general knowledge" fallback for very well-documented works (labelled, unverified, and auto-flagged).

The system's distinctive move is to remove judgment from the model at the two most consequential points. A **deterministic watchlist rule** (§5.3) runs in server code after the model finishes: any result hosted on one of five registry domains (interpol.int, artloss.com, lostart.de, lootedart.com, fbi.gov) raises a high-severity flag the model cannot suppress or invent. A **fixed, published confidence score** (§5.4) starts at 100 and subtracts 30 per custody gap, 25 for thin corroboration (fewer than three of seven sources responding), 10 per high-severity flag, and 10 for a valuation anomaly. Each output ("passport") is signed and carries the attestation that it "attests to process, not to underlying truth" (§1.5, §6.5). The report is candid and legally literate: Section 8 grounds the watchlist in the Washington Principles, the UNESCO 1970 Convention, and related instruments, and Section 10 enumerates twelve limitations with real discipline. The steelman is strong: this is a well-engineered, self-aware tool whose documentation models the epistemic honesty the domain demands.

---

## Major issues

**1. No evaluation. The report describes the tool but never demonstrates that it works.**
*Location:* whole paper; most visible against §3 (Objectives), §10.4, §10.5, and §11.2.
The report sets concrete objectives — surface documented history (§3.1), report absence as a finding (§3.3), raise a high-severity alert on registry hits (§3.4), produce an auditable score (§3.5) — but offers no evidence that the system meets any of them at any measurable rate. There is no test set of objects with known ground truth, no measurement of how often the timeline attaches the wrong record, how often a genuine registry presence is caught or missed, or how often gaps are inserted correctly versus spuriously. The only concrete outputs shown (§11.2) are three cherry-picked stored snapshots — Salvator Mundi, The Starry Night, Portrait of Wally — explicitly labelled "teaching material," i.e. demonstrations, not evaluations. Section 10.4 concedes the weights were never "validated against known cases," and §10.5 concedes "nothing in the system checks its assembly against the retrieved material after the fact." *Why it matters:* a demanding referee cannot distinguish a tool that reliably does first-pass provenance from one that produces plausible-looking passports for the wrong object. Every claim in Section 13 ("names its gaps," "shows silences") is an assertion about behaviour that is never measured. *Path forward:* build a modest labelled benchmark — even 30–50 objects — spanning (a) works with clean, well-documented provenance, (b) works with known looted/stolen status present in the registries, (c) obscure works, and (d) antiquities/non-Western objects without a titled-artist form. Report, for each: did the correct object get identified; did known registry presence produce a watchlist flag (true/false positives and negatives); did expert-known gaps get inserted and spurious gaps avoided; and how the score ordered the cases against an expert ranking. This single addition converts the paper from a spec into a research contribution.

**2. The determinism claim is overstated: the score's inputs come from the unchecked language model.**
*Location:* §1.4, §3.5, §9.1 versus §5.4, §10.5.
The paper's headline selling point is that the score "is not produced by the artificial-intelligence model" (§1.4), "cannot drift with the mood of a language model" (§3.5), and is "the strongest design decision in the project" (§9.1). But the arithmetic in §5.4 is deterministic only in its *last step*. Its two dominant inputs — the count of custody gaps (−30 each; three gaps zero the score) and the count of model-raised high-severity flags (−10 each) — are produced by Gemini, and §10.5 states plainly that "nothing in the system checks its assembly against the retrieved material after the fact." So the score is deterministic arithmetic over non-deterministic, unvalidated inputs. Two runs "producing the same findings produce the same score" (§9.1) is true but nearly vacuous, since whether the findings are the same is exactly what the model does not guarantee. *Why it matters:* the property the reader is told to rely on — auditability, reproducibility, immunity to model drift — holds for the watchlist rule (genuinely deterministic, §5.3) but not for the numeric score, which is where a user will actually look. Presenting them as equally "auditable" misleads. *Path forward:* (i) rewrite §1.4/§3.5/§9.1 to distinguish sharply between the *watchlist rule* (fully deterministic) and the *score* (deterministic aggregation of model-derived counts); (ii) state that the score's reproducibility is bounded by the model's gap/flag stability, and quantify that stability empirically (rerun the same inputs N times, report variance in gap counts and resulting scores); (iii) consider a post-hoc check that at least verifies each model-asserted gap and flag against the retrieved text before it enters the arithmetic.

**3. The contribution is not positioned against any prior work, so novelty is unestablished.**
*Location:* §2.3, §2.5.
The "gap in tooling" (§2.3) is asserted rather than demonstrated: the report claims existing public resources are "good but fragmented" and that assembling across them is unautomated, but cites no existing system, academic or commercial, that has attempted this — and there is a real literature to engage (computational provenance and the PROV/CIDOC-CRM data models, the Getty's own provenance tooling, art-crime and due-diligence platforms, prior work on automated cultural-heritage record linkage). The only relationship to prior work stated is to an internal sibling repository, "arts and artifacts" (§2.5), described so vaguely that a reader cannot tell what is new here versus inherited. *Why it matters:* without positioning, the report cannot claim novelty, and a reader cannot judge whether the design choices in Sections 5 and 9 improve on or merely restate existing practice. *Path forward:* add a short related-work section that names the closest comparators (systems and data standards), states what each does and does not do, and locates this tool's specific novelty — plausibly the *combination* of deterministic scoring plus rule-based registry flagging plus gap-as-finding, which is a defensible framing once made explicit; and specify concretely what this deployed version adds over the "arts and artifacts" sibling.

**4. The silent watchlist failure is the tool's most dangerous behaviour and is buried in a sub-clause.**
*Location:* §10.10 (versus §1, §5.3, §13).
Section 10.10 notes that if the web-search key is absent, "the watchlist rule cannot fire at all, which removes its single most consequential signal without any visible change in the shape of the output." For a tool whose stated purpose (§3.4) is to raise a high-severity alert on registry hits, a degradation mode that silently removes exactly that capability while still emitting a fully-formed, scored, signed passport is the single most consequential failure the system can have — a false sense of clearance. Yet it appears only as the tenth of twelve caveats, absent from the Executive Summary, the score discussion (§5.3 mentions the dependency but not the invisibility), and the Conclusion. *Why it matters:* a user who runs the tool with a misconfigured key receives output indistinguishable from a clean check, which is precisely the "incomplete chain presented as complete" harm the paper elsewhere (§13.1) makes its central concern. *Path forward:* (i) at the design level, render an explicit "watchlist NOT checked" state in the passport whenever the search key is absent, and suppress or grey the confidence score in that mode; (ii) at the reporting level, promote this failure mode into the Executive Summary and Conclusion as a named limitation, not a buried caveat.

---

## Minor issues

- **m1.** §5.4 — A "flagged" (stolen/looted) result counts toward corroboration exactly as a "clear" result does, so a registry hit *reduces* the −25 thin-corroboration penalty. The stated reasoning (the object "is known to the record") is defensible but counterintuitive; give it a sentence of explicit justification or reconsider, since it means the most alarming finding partly raises the score.
- **m2.** §5.6 — The red/amber/green display bands are said to "carry no legal or institutional meaning," yet colour-coding a risk output is precisely how users read a verdict. The disclaimer and the UX pull against each other; either defend the bands as intentional triage cues or tone down the colour semantics.
- **m3.** §5.5 / §10.3 — The report candidly notes the score "conflates two different situations" (a well-documented wartime seizure and an unknown object both score low). This is honestly flagged but left unresolved; consider whether a second axis (e.g., a separate "documentation density" indicator distinct from "risk") would fix the conflation rather than only warning about it.
- **m4.** §1.2 / §5.3 / §7.1 — Three different counts appear close together (seven sources; thirteen restricted domains within one source; five watchlist domains). All are internally consistent, but easy to conflate; a single summary table (source, type, key required, can it flag) would prevent misreading.
- **m5.** §8.4 — "around 150 states parties" to the 1970 UNESCO Convention is slightly high; the figure is roughly 145 as of 2024. Tighten or cite. **[Verification Required]** — confirm the current count against the UNESCO treaty registry.
- **m6.** §7.5 / §9.5 / §10.9 — The bundled MoMA dataset (~159,000 works) and the fixed domain list both age silently, and §10.9 notes ifar.org's 2024 wind-down. State a concrete review/refresh cadence rather than only naming the staleness risk.
- **m7.** §10.5 — Reproducibility of a research prototype would be materially improved by including, in an appendix, the exact model version and the verbatim timeline-assembly prompt (temperature is mentioned but the prompt is not shown).
- **m8.** §11.3 — The factual claims (Portrait of Wally settling July 2010 for $19M; Salvator Mundi $450.3M, Christie's, Nov 2017) check out and are well chosen; consider a one-line citation for each so a policy reader can follow them.

---

## Things the report gets right

- **Section 10 is a model of candour.** Twelve enumerated, located limitations — including the ones most authors bury (Western-weighting §10.8, title-and-artist dependence excluding antiquities §10.7, the rationale-versus-arithmetic gap §10.11). This self-awareness is the report's strongest feature and should be protected in revision.
- **The watchlist-rule reasoning (§5.3) is exactly right:** the single most consequential signal is the one the language model is not permitted to suppress or invent. This is genuinely good safety engineering and is cleanly explained.
- **Treating gaps as findings (§3.3, §9.3)** is the correct epistemics for provenance, where "the incomplete chain is the finding," and the design follows through in the timeline and the score.
- **The legal-ethical grounding (§8)** is accurate, well-integrated, and does real work: it shows the watchlist domains are "the public faces of the institutional infrastructure" built by the Washington Principles and UNESCO 1970, rather than an arbitrary list.
- **The attestation "attests to process, not to underlying truth" (§1.5, §6.5)** is the right framing and is used consistently to govern the rest of the output.
- **The general-knowledge fallback is genuinely well-fenced (§4.3, §9.4):** labelled, tagged, never verified, never overriding a live source, and auto-flagged. The report also correctly identifies this as the hardest place for a non-specialist to catch an error.

---

## Verdict

**Major revisions.** The engineering is sound and the documentation is admirably honest, but the submission is currently a high-quality technical description rather than a research contribution: it neither demonstrates that the tool works nor situates what is new. The single highest-value revision is **Major Issue 1 — an empirical evaluation on a small labelled benchmark of known cases** (clean, looted/registry-known, obscure, and non-Western/untitled objects), reporting where the tool's identifications, gap insertions, watchlist flags, and score orderings agree and disagree with expert ground truth. That one addition would also supply the evidence needed to repair the overstated determinism claim (Issue 2) and to make the novelty in Issue 3 concrete.

---

## References

1. Washington Conference Principles on Nazi-Confiscated Art, 3 December 1998.
2. Terezín Declaration on Holocaust Era Assets and Related Issues, June 2009.
3. UNESCO Convention on the Means of Prohibiting and Preventing the Illicit Import, Export and Transfer of Ownership of Cultural Property (Paris, 1970; in force 1972).
4. UNIDROIT Convention on Stolen or Illegally Exported Cultural Objects (1995; in force 1998).

*Note on format: per the delivery environment, references are collected here and cited inline as [n] rather than as Word footnotes.*
