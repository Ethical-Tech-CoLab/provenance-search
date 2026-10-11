# Decision-model recommendation: provenance search

Date: 2026-10-11. Status: proposed offline experiment; no API calls or measured
savings. Scope: this repository only. Public evidence only.

## Observed workflow

Reviewed revision: `b9a0304c4a502c90a50ef44d0436ed40a56b25ad`.
The [README](https://github.com/Ethical-Tech-CoLab/provenance-search/blob/b9a0304c4a502c90a50ef44d0436ed40a56b25ad/README.md)
describes an Express service combining Tavily and public museum/encyclopedia
sources with Gemini vision and synthesis. The initial server setup was also
inspected; this is not a full audit of the scoring pipeline.

The documented confidence score is an intentional deterministic formula over
custody gaps, source counts, severity flags and valuation anomalies. A
general-knowledge fallback is unverified and flagged. Neither should be
overwritten by a decision model's output.

## Recommendation

Insert a bounded source-to-object relevance assessment **after retrieval and
before synthesis**. Use the query object, hit text, source identity/date and
known IDs. Return relevant / related-not-identical / irrelevant / insufficient
evidence. Optionally add a separately defined relevance rubric for sorting.
Keep original source records and their provenance.

A second experiment can check whether a proposed cited claim is supported,
contradicted or not established by the exact retrieved span. Validate quote
presence in code first. "Model-assessed support" is not verified authenticity.

Do not ask the model to invent missing custody links, perform arithmetic,
verify a source never retrieved, or increase confidence on general knowledge.
Keep server-side keys and existing permission boundaries.

## Alternatives

Compare unchanged retrieval and Gemini, lexical/embedding reranking, Jev,
Microsoft-Decision-1 through an approved Foundry endpoint, and Sage. Run only
providers permitted for the actual input. Jev has directly relevant
[reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md) and
[citation](https://docs.typesafe.ai/cookbooks/citation_check.md) starter recipes.
Provider demos do not establish quality on artwork provenance.

Local options are lexical search, fuzzy matching, and licensed local
cross-encoders/classifiers. They are alternatives, not local copies of the
three proprietary models.

## Test contract

Freeze artwork/query-disjoint examples covering same-name works, editions,
reproductions, sparse records, contradictory dates, stale sources, unavailable
registers and general-knowledge fallback. Have reviewers label both retrieval
relevance and individual claim support.

Report candidate recall before reranking, NDCG/MRR, retained relevant-source
recall, unsupported-claim false acceptance, coverage, calibration, latency and
cost per accepted sourced answer. Vary option order and source presentation.
Measure all additional and removed Gemini calls rather than assuming savings.

Release only after the existing deterministic confidence and fallback labels
remain unchanged on regression fixtures, the held-out evidence-support error
limit is owner-approved, and the full query-level cost is acceptable. Until
then, shadow mode only, with no source discarded from the audit record.

## First implementation step

Build an off-by-default server-side adapter that logs only approved metadata,
model/version and source IDs. Set candidate caps, timeouts, explicit failures
and a fallback to the current path. Add no browser API secrets.
