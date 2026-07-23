# Provenance Search: An Automated Ownership-History Check for Artworks and Cultural Objects

### A Research Report on a Prototype Tool for Screening the Ownership History of Art and Cultural Property

*Prepared as a plain-language review of the Provenance Search research prototype*
*based on the software and documentation contained in this repository*

---

## Foreword

Every object in a museum, a saleroom, or a private collection carries an
invisible second history alongside its artistic one: the record of who has
owned it, when, and how it passed from hand to hand. Curators and lawyers call
this record the provenance. It matters because an object with an unexplained
break in its ownership history may have been stolen, looted in war, taken from
a persecuted family under duress, or excavated illegally and smuggled across a
border.

The problem is not that this information does not exist. It is that it is
scattered. A museum holds part of the chain in its accession records. An
auction house holds another part in a sale catalogue. A police force holds a
report of a theft. A national foundation holds a claim filed by an heir. These
records sit in separate places, in different formats, and they rarely speak to
one another. A researcher who wants to assemble a picture must visit each one
in turn and then judge what the combination means.

Provenance Search is a research prototype, an experimental piece of software,
built to perform that first assembling step automatically. A user enters an
artwork's title and artist, or photographs the object. The tool queries a set
of free, publicly available sources, assembles what they say into a single
ownership timeline, marks the places where the timeline has holes, and issues
what it calls a provenance passport. This report explains in non-technical
language what the tool does, how each of its inputs and scoring rules works,
and, equally importantly, what it does not and cannot establish.

---

## 1. Executive Summary

1.1 Provenance Search is a small web application that takes a description of an
artwork and returns a structured summary of that artwork's documented ownership
history, together with a numerical confidence score and a list of risk flags.
It is published as a live public demonstration and is intended for academic and
demonstration purposes.

1.2 The tool queries seven free public information sources. One of them, a
commercial web-search service called Tavily, is treated as the primary research
engine and is deliberately restricted to a fixed list of authoritative websites,
including INTERPOL, UNESCO, the Getty, the German Lost Art Database, the
Central Registry of Information on Looted Cultural Property, the United States
Federal Bureau of Investigation, and major auction houses. The remaining six
sources, drawn from museum collections and encyclopedic and structured
reference data, are used to corroborate and to supply exact dates.

1.3 A general-purpose artificial-intelligence model, Google's Gemini, performs
two jobs: it can identify an artwork from a photograph, and it arranges the
retrieved facts into a chronological ownership timeline. It is instructed to
use only facts present in the retrieved material, and to mark any period of
ownership that the sources do not account for as an explicit gap.

1.4 The most important design decision in the project is that the confidence
score is not produced by the artificial-intelligence model. It is calculated by
a short, fixed, published arithmetic rule written into the server software. The
same set of findings will always produce the same score, and any reader can
check the arithmetic. Section 5 sets out every term in that calculation.

1.5 The tool is candid in its own output about the limits of what it has done.
The digital signature attached to each passport states that the record "attests
to process, not to underlying truth." That framing is accurate and is the right
way for a policy reader to understand the entire system.

1.6 Provenance Search does not query the restricted law-enforcement and
commercial databases that professional due diligence relies on. It reads the
public web pages of some of the organisations that maintain those databases.
The distinction is central to interpreting its output and is set out in full in
Section 10.

---

## 2. Background and Rationale

2.1 The problem. The trade in art and cultural objects is among the largest
asset markets with comparatively little mandatory disclosure. Ownership history
is held in records that were built for different purposes by institutions with
no obligation to share, and there is no single register that a buyer,
journalist, heir, or customs officer can consult to see the whole chain.

2.2 Why gaps matter. Provenance research does not usually produce a clean
finding of theft. It produces an absence. An object whose recorded ownership
jumps from 1932 to 1948 with nothing in between is not thereby proven to have
been looted, but the years between 1933 and 1945 are precisely the window in
which Jewish and other persecuted owners across continental Europe were
dispossessed by confiscation, forced sale, and sale under duress. An
unexplained gap in that period is what a suppressed transfer looks like from
the outside. The professional convention, reflected in museum guidance in both
the United States and Europe, is to treat such a gap as a trigger for further
research rather than as a verdict.

2.3 The gap in tooling. The public resources that do exist are good but
fragmented, and most require the researcher to know which one to consult and
what to type into it. Assembling a first-pass picture across all of them is
slow, repetitive clerical work. It is exactly the kind of work that software
can usefully do, provided the software is honest about the difference between
finding a record and establishing a fact.

2.4 The response. Provenance Search automates the first pass. It runs the same
query against several sources at once, gathers what comes back, arranges it in
date order, names the holes, and puts a transparent number on how much of the
picture is actually supported by retrieved evidence. It is presented by its own
interface as a tool that "flags what cannot be verified" rather than one that
confirms what can.

2.5 Relationship to related work. The repository's package metadata, its
earliest commit, and the identifier embedded in every passport signature all
carry the name "arts and artifacts," which is also the name of a sibling
repository in the same organisation. Provenance Search is best understood as
the deployed, publicly hosted web version of that line of work. This report
describes only what is present in this repository.

---

## 3. Objectives

The tool is designed to:

3.1 Assemble, from free and public sources only, whatever documented ownership
history exists for a named artwork, without requiring the user to hold a
subscription to any commercial database.

3.2 Present that history as a dated chronological timeline in which every entry
carries the source it came from, so that a reader can follow any claim back to
its origin.

3.3 Report the absence of information as a finding in its own right, rather
than presenting an incomplete chain as though it were complete.

3.4 Raise an explicit, high-severity alert when the search turns up material on
the public sites of the recognised stolen-art and looted-art registries.

3.5 Express overall reliability as a single number produced by a fixed
published rule, so that the score cannot drift with the mood of a language
model and can be audited by anyone.

3.6 Work in the setting where the question is most often asked, including on a
mobile telephone in a gallery, by allowing the object to be photographed rather
than described.

---

## 4. How the Tool Works

The system has four stages. A user's request passes through all of them in a
single operation that takes a few seconds.

### 4.1 Stage one: describing the object

The user supplies what they know through one of three routes:

- a text form with fields for title, artist, period or date, medium, and an
  optional last known sale price;
- an uploaded photograph of the object; or
- a photograph taken there and then with the device camera, which is the mode
  intended for use in a museum or a saleroom.

If a photograph is supplied, it is sent to Gemini's image-reading capability,
which returns its best guess at title, artist, period, and medium, together
with its own self-reported certainty about that identification and a short
note. Those values are written into the form, and the search then runs
automatically. Only the title and the artist are strictly required to proceed.
Large photographs are reduced in size before they are sent, so that a
high-resolution telephone image does not exceed the limits of the free service.

### 4.2 Stage two: querying the sources

The title and artist are combined into a search phrase and sent to seven
sources at the same time. Section 7 describes each source and what it is. Each
source returns one of three verdicts about the object: a hit was found and it
raises no alarm; a hit was found on a registry of lost or stolen property; or
nothing matching was found.

### 4.3 Stage three: assembling the timeline

Everything the seven sources returned is gathered into a single block of text
and passed to Gemini with a set of written instructions. The model is told that
the restricted web search is the primary basis for the timeline and that the
museum and reference sources are supplementary corroboration. It is told to use
only facts present in the material supplied. It is told that where the sources
leave a period of ownership unaccounted for, it must insert an entry marked as
a gap with a note explaining what is missing, on the stated principle that a
gap is itself a fact worth reporting.

The model is also given one narrow permission to go beyond the retrieved
material. For works it recognises as very well documented, where the live
sources returned little or nothing, it may fill in widely known ownership
history from its own training. Every such entry must be labelled as general
knowledge, must be marked unverified, must carry no source link, and may never
contradict what a live source actually said. Whenever this permission is used,
the software itself adds a medium-severity flag to the result, so the reader
sees that part of the timeline rests on the model's memory rather than on a
citation.

### 4.4 Stage four: scoring and signing

The assembled timeline and flag list are then handed back to the server's own
code, which does three things without any further involvement from the
artificial-intelligence model. It adds a high-severity flag for every hit on a
registry domain, independently of whether the model noticed it. It computes the
confidence score by fixed arithmetic. And it attaches a signature block
recording the time of the check and a digital fingerprint, a short string of
characters derived mathematically from the title, the artist, and the timestamp,
which allows a later reader to detect whether those details have been altered.

---

## 5. The Variables Explained

This section is the heart of the report. It sets out every input the tool
takes, every rule it applies, and how each one reaches the final result.

### 5.1 What the user supplies

Title and artist. These are the only required fields. They are combined into
the phrase sent to every source, so they determine everything that follows. A
misspelled artist name or a title in the wrong language will quietly produce a
thin result rather than an error, which is a real practical caution for users.

Period or date, and medium. These are optional and are not used to filter the
searches. They are passed to the model as descriptive context, helping it
distinguish between different works that share a title and helping it judge
whether a returned record is really the same object.

Last known sale price. This optional figure exists to support a single check.
If the user supplies a price, the model is asked whether that price is clearly
out of line with a comparable figure actually present in the retrieved sources.
If, and only if, such a comparable exists and the supplied price is
inconsistent with it, the valuation is marked anomalous. The instruction is
deliberately conservative: with no price supplied, or no comparable found, the
answer is always no. A price far above or below the plausible market level is a
recognised signal in art-market due diligence, since valuation is one of the
few numbers that has to be stated openly and is therefore one of the few that
can be checked against the record.

### 5.2 What each source contributes

Each of the seven sources returns one of three verdicts. Clear means the source
found at least one matching record and nothing alarming. Flagged means the
restricted web search returned a result hosted on one of the loss and
stolen-property registries. Not found means the source returned nothing, or was
skipped because no access key was configured, or failed.

Only the primary web search can return the flagged verdict. The museum and
reference sources can only ever say clear or not found, because they hold
collection catalogues rather than loss reports.

### 5.3 The watchlist rule

Five internet domains are designated as the watchlist: interpol.int,
artloss.com, lostart.de, lootedart.com, and fbi.gov. These correspond
respectively to INTERPOL's stolen works of art work, the Art Loss Register, the
German Lost Art Foundation's database, the Central Registry of Information on
Looted Cultural Property, and the FBI's stolen art file. If any result returned
by the primary web search is hosted on one of these five domains, the software
adds a risk flag of type "watchlist match" at high severity, records which
domain it came from, and links to the page.

This rule is deterministic. It runs in the server's own code after the model
has finished, it compares the address of each returned page against the list of
five, and it does not ask the model's opinion. That is a deliberate safeguard:
the single most consequential signal the tool can produce is the one signal
that a language model is not permitted to suppress or to invent. It is also the
one signal that disappears entirely if the web-search service is not configured,
a dependency the repository documents plainly.

### 5.4 The confidence score

The score begins at 100 per cent and is reduced by four penalties. It is then
held within the range of 0 to 100.

Minus 30 points for each custody gap. A custody gap is any timeline entry the
model marked as a period of unaccounted-for ownership. This is the heaviest
penalty in the calculation, and the weighting reflects the professional
convention described in Section 2.2: in provenance work, an unexplained break
in the chain is the primary warning sign, not a minor blemish. The severity of
the penalty also means the score falls very fast. Two gaps alone remove 60
points. Three take the score to zero on their own.

Minus 25 points if fewer than three of the seven sources returned anything at
all. This term measures corroboration rather than content. A finding supported
by one source is a lead; a finding that four independent sources recognise is
an established record. The threshold of three out of seven is a judgment call by
the developer rather than a derived figure, and the report should say so
plainly. Note also that the test counts any verdict other than not found, so a
flagged result counts towards corroboration in the same way a clear result
does, on the reasoning that a registry hit still demonstrates that the object is
known to the record.

Minus 10 points for each high-severity risk flag. This includes both the
automatic watchlist matches and any high-severity flag the model itself raised
from the retrieved material, such as a documented forced transfer or an
unresolved legal claim.

Minus 10 points if the valuation was marked anomalous, as described in 5.1.

The result is divided by 100 and reported as a proportion, which the interface
displays as a percentage.

### 5.5 How to read the score honestly

Two properties of this calculation deserve to be stated clearly, because they
shape how the number should be interpreted.

First, the score measures how well documented the ownership history is, not how
likely it is that the object is legitimate. A famous work with a complete and
well-known history that includes a documented wartime confiscation will score
very low, because that confiscation registers as a break in title and attracts
high-severity flags. An obscure object about which almost nothing is known may
also score low, because too few sources returned anything. The two cases are
very different in substance and can look similar in the number. The written
rationale that accompanies the score is intended to distinguish them, and a
reader should always read it.

Second, because the penalties are subtractive and large, the score reaches zero
easily and then stops. Once it is at zero, further findings do not change it.
Zero therefore means "at least this bad" rather than a measured floor. The
repository's own worked example, a demonstration record for Egon Schiele's
Portrait of Wally, scores zero for exactly this reason, with several custody
gaps and several high-severity flags in combination.

### 5.6 The display bands

The interface colours the score in three bands: below 40 per cent in red,
between 40 and 70 per cent in amber, and 70 per cent or above in green. These
are presentational thresholds only. Nothing in the software behaves differently
according to which band a score falls into, and the bands carry no legal or
institutional meaning.

---

## 6. Reading the Results

6.1 The passport. The output is a single structured record. It contains the
artwork's details as searched, the confidence score, a short written rationale
in plain language explaining what is and is not verified, the ownership
timeline, the risk flags, the valuation assessment, the list of sources
consulted with each one's verdict, and the signature block.

6.2 The timeline. Each entry gives a period, an owner, and where available a
note, a source link, and the name of the source authority. Entries that
represent gaps are shown with the owner field marked and tagged "custody gap"
in the interface. Entries drawn from the model's own knowledge rather than a
retrieved source are tagged "general knowledge." A reader can therefore see at
a glance which parts of the chain are cited and which are not.

6.3 The risk flags. Each flag has a type, a severity of high, medium, or low, a
plain-language detail sentence, and where applicable a link. Severity governs
the colour of the flag in the interface and, for high-severity flags only,
feeds the score.

6.4 The sources consulted panel. This lists all seven sources with their
verdicts, so that a reader can see not only what was found but where nothing
was found. This matters more than it might appear. A not-found verdict from a
museum collection means only that the museum does not hold the object. It is
not evidence of anything about the object's history.

6.5 The signature. Each passport records the identifier of the software version
that produced it, the exact time, a digital fingerprint, and an attestation
sentence. The attestation states that the passport records the results of
automated queries to free public sources and attests to process, not to
underlying truth. This is the single most important sentence in the output and
should be read as governing everything above it.

---

## 7. The Data Sources in Plain Terms

7.1 Tavily. A commercial web-search service designed to be used by software
rather than by a person browsing. In this project it is the primary research
engine, and it is restricted to a fixed list of thirteen websites so that it
cannot return results from the open web. The list is metmuseum.org, getty.edu,
interpol.int, unesco.org, artloss.com, lostart.de, lootedart.com, christies.com,
sothebys.com, artnet.com, fbi.gov, ifar.org, and wikipedia.org. The query sent
is the title and artist followed by the words provenance, ownership, history,
looting, theft, and restitution.

7.2 What those sites are. For a reader not familiar with the field: INTERPOL
maintains the only global database of police-certified records of stolen
cultural objects, publicly searchable since 2021 through its free ID-Art
application. The FBI's National Stolen Art File, established in 1997, is a
publicly searchable United States register of stolen art and cultural property,
populated only by law-enforcement agencies. The German Lost Art Foundation's
Lost Art Database records cultural assets seized between 1933 and 1945 as a
result of persecution, and objects whose history cannot exclude such a seizure;
it is free and public. lootedart.com is the Central Registry of Information on
Looted Cultural Property 1933 to 1945, established in 2001 by the Commission
for Looted Art in Europe, and holds both a documentary database and an object
database. The Art Loss Register is a private London-based commercial company
operating what it describes as the largest private database of stolen art;
its data is not publicly accessible and searches are a paid service. The Getty
Research Institute's Provenance Index is a large free scholarly resource built
from transcribed sale catalogues, dealer stock books, and household
inventories, weighted towards Western European art from the sixteenth to the
early twentieth century. IFAR, the International Foundation for Art Research,
was a New York non-profit founded in 1969 whose provenance guide has long been
a standard plain-language reference; it announced in 2024 that it was winding
down operations. Christie's, Sotheby's, and Artnet are commercial auction and
art-market sources whose catalogue entries frequently include provenance
statements.

7.3 The Metropolitan Museum of Art. The Met publishes an open interface to its
collection catalogue requiring no key. The tool retrieves up to three matching
objects and reads their title, artist, date, medium, credit line, and public
web address. The credit line is useful because it often names the donor or
bequest through which the museum acquired the work.

7.4 The Art Institute of Chicago. Also an open collection catalogue requiring no
key. This is the only museum source in the set that returns a dedicated
provenance text field, and it is therefore the most directly valuable of the
three museum sources for the tool's purpose.

7.5 The Museum of Modern Art. MoMA publishes no live search facility, and its
website blocks automated access, so the project takes a different approach.
MoMA's collection is published as an open static dataset on a public code-sharing
site. The repository includes a script that downloads that dataset, keeps six
fields for each work, and compresses it into a single file of roughly four
megabytes covering about 159,000 works. That file is loaded into the server's
memory when it starts, so a MoMA search happens instantly and involves no
network request at all. The matching rule is simple: every word of the title
must appear in the record and at least one word of the artist name longer than
two characters must also appear.

7.6 Wikipedia. The English-language encyclopedia's search facility, used for
general background. Up to three article summaries are returned.

7.7 Wikidata. A companion project to Wikipedia holding structured facts rather
than prose. The tool searches for the artwork, picks the best-matching entry by
looking for the artist's surname in the entry description, and then asks for
five specific categories of fact: when the work was made, where it is now,
which collections have held it and between which dates, who has owned it and
between which dates, and any significant events recorded against it. This is
the most precisely targeted of the supplementary sources, because those
categories map directly onto the shape of a provenance timeline.

7.8 Europeana. A European Union cultural-heritage aggregator that brings
together records from thousands of European galleries, libraries, archives, and
museums. It requires a free key, and the tool skips it if none is configured.

7.9 Gemini. Google's family of large language models, capable of reading images
as well as text. It is used for the photograph identification and for the
assembly of the timeline. It is not used for the score.

---

## 8. The Legal and Ethical Backdrop

8.1 The tool does not implement any legal test, and this report does not claim
that it does. But the reason its outputs matter is set by a body of
international commitments that a policy reader will recognise, and the
registries it searches exist because of them.

8.2 The Washington Conference Principles on Nazi-Confiscated Art, agreed in
December 1998 by 44 states, set out eleven principles including the
identification of art confiscated by the Nazis and not subsequently restituted,
the opening of archives to researchers, the publicising of unidentified works,
and the achievement of just and fair solutions for claims. They are explicitly
non-binding: a moral and political commitment rather than a treaty, with no
enforcement mechanism. The Terezin Declaration of June 2009 extended the same
approach to immovable property, Judaica, and archives, and in March 2024 a set
of Best Practices for the Washington Principles was issued for the twenty-fifth
anniversary, likewise non-binding, which among other things treats sales under
duress between 1933 and 1945 as equivalent to involuntary transfers.

8.3 lootedart.com, one of the five watchlist domains, was created specifically
to fulfil the sixth of the Washington Principles, which called for a central
repository of information. The German Lost Art Database serves the same
purpose within Germany's national framework. The tool's watchlist is thus not
an arbitrary list of websites; it is a list of the public faces of the
institutional infrastructure built in response to those commitments.

8.4 For objects other than Nazi-era losses, the governing instrument is the
1970 UNESCO Convention on the Means of Prohibiting and Preventing the Illicit
Import, Export and Transfer of Ownership of Cultural Property, which entered
into force in April 1972 and now has around 150 states parties. It obliges
states to maintain inventories, to operate export certification, to bar museums
from acquiring undocumented material, and to return stolen inventoried objects
on request. It is not retroactive, binding states only in respect of transfers
after it entered into force between the states concerned, which is why 1970
functions in practice as a due-diligence cut-off date for antiquities, and why
it does not reach the 1933 to 1945 period. The 1995 UNIDROIT Convention on
Stolen or Illegally Exported Cultural Objects, in force since July 1998, was
designed to address the private-law gaps the UNESCO Convention leaves open, but
has far fewer parties.

8.5 It should be stated plainly that the tool applies none of these
instruments. It does not determine title, assess a restitution claim, or decide
whether an export was lawful. What it does is surface the public traces that
the institutions created under these frameworks have left on the open web.
Deciding what any of it means remains a matter for lawyers, provenance
researchers, and the claims processes those frameworks established.

---

## 9. Design Choices

9.1 Why the score is not produced by the artificial-intelligence model. A
language model asked to rate its own confidence will produce a number that
sounds reasonable and cannot be reproduced or checked. The project instead
computes the score in ordinary code from countable facts: how many gaps, how
many sources responded, how many high-severity flags, whether the valuation was
anomalous. The result is that two runs producing the same findings produce the
same score, and a reader who disagrees with the score can identify exactly which
term they disagree with. This is the strongest design decision in the project.

9.2 Why the primary search is restricted to a fixed list of sites. An
unrestricted web search for the words looting and theft alongside a famous
artist's name would return a great deal of journalism, speculation, and
commercial content. Restricting the search to thirteen named institutional and
market domains means that the material the model reasons over comes from
sources with an identifiable custodian, at the cost of missing anything held
elsewhere.

9.3 Why gaps are recorded rather than smoothed over. The instruction given to
the model states that a gap is itself a fact worth reporting, and the interface
displays gaps prominently in red. A system that quietly produced an unbroken
chain wherever it lacked data would be worse than useless in this domain,
because the incomplete chain is the finding.

9.4 Why the general-knowledge fallback exists and why it is fenced. Without it,
the tool would return an almost empty result for the most famous works in the
world, since the free sources it uses may hold little ownership detail even for
a painting whose history is taught in schools. The fallback lets the model fill
those blanks, but it is constrained on four sides: every such entry is labelled
in the data, tagged in the display, never marked verified, and never allowed to
override a live source, and its use triggers an automatic medium-severity flag.
The constraint is well designed. It remains the part of the system where an
error is hardest for a non-specialist reader to detect.

9.5 Why the MoMA data is bundled rather than queried. Because MoMA offers no
live search and blocks automated access, the only lawful and reliable route to
its collection is its own published open dataset. Bundling a compressed copy
makes the search instant and removes a point of failure, at the cost that the
copy is only as current as the last time it was rebuilt.

9.6 Why everything runs on the server. The user's browser never contacts any
external service directly. It speaks only to this project's own server, which
holds the access keys. This keeps the keys out of the browser, where they would
be readable by anyone.

---

## 10. Limitations and Caveats

10.1 It does not search the restricted databases. This is the most important
limitation and the one most likely to be misread. The interface names INTERPOL,
the Art Loss Register, Lost Art, and the FBI among the sources it searches. What
it actually searches is the public web pages of those organisations, by way of a
general web-search service. The Art Loss Register's database is a paid
commercial service with no public access at all. A negative result from this
tool is therefore not a clearance against the Art Loss Register, and must never
be presented as one. INTERPOL and the FBI files are publicly searchable through
their own interfaces, but the tool does not query those interfaces directly
either.

10.2 An absence of findings is not a clean history. Every not-found verdict in
the panel means only that the source returned nothing for the phrase that was
searched. It carries no information about the object.

10.3 The score conflates two different situations. As set out in 5.5, a
well-documented history containing a wartime seizure and an obscure object with
no history at all can both produce a very low score. The number alone does not
distinguish them.

10.4 The weights are the developer's judgment. Thirty points for a gap,
twenty-five for thin corroboration, ten per high-severity flag, ten for a
valuation anomaly, three sources as the corroboration threshold: none of these
figures is derived from a study, an expert panel, or a validation exercise
against known cases. They are reasonable choices that produce sensible
orderings, and they should be described as such rather than as a measurement.

10.5 The timeline depends on a language model. The model is instructed to use
only retrieved facts, and its temperature setting is kept very low to make its
output as consistent as possible, but it is still a language model reading
messy source material. It can misread a date, attach a record to the wrong
object, or mistake a similarly titled work for the one being searched. Nothing
in the system checks its assembly against the retrieved material after the fact.

10.6 Identification from a photograph is a guess. The image step returns a
best-effort identification with a self-reported certainty figure. That figure is
the model's own estimate, it is not carried into the confidence score, and an
incorrect identification will produce a fully formed passport for the wrong
object.

10.7 The searches are simple text matches. The query is the title and artist as
typed. There is no handling of alternative titles, transliterations, works
known by different names in different languages, or the many objects for which
no single agreed title exists. This weighs most heavily against exactly the
categories of object where provenance questions are most acute, including
antiquities and non-Western material, which frequently have no title and no
named artist at all.

10.8 The source list is Western-weighted. Two of the three museum sources are
American, the aggregator is European, and the market sources are the two large
London and New York auction houses. Objects from collections and markets
outside that orbit will be under-represented, and this limitation compounds
10.7.

10.9 The sources change beneath the tool. The domain list is fixed in the
software. One of the thirteen domains, ifar.org, belongs to an organisation
that announced in 2024 that it was winding down. Domain lists of this kind
require periodic review, and nothing in the repository schedules one.

10.10 Dependencies and degradation. If the web-search key is absent, the tool
runs on the supplementary sources alone and the watchlist rule cannot fire at
all, which removes its single most consequential signal without any visible
change in the shape of the output. If the Europeana key is absent, that source
is silently skipped and counts as not found, which can push the corroboration
count below the threshold and cost 25 points for a reason unrelated to the
artwork.

10.11 The written rationale is not the arithmetic. The plain-language
explanation shown beside the score is composed by the language model and
describes the substance of the case. It does not narrate the calculation, and a
reader should not assume the two are saying the same thing.

10.12 Status. This is a research prototype by a single developer, deployed as a
public demonstration. It is not an accredited due-diligence service, it carries
no professional indemnity, and its passport is not a certificate. Its own
attestation says so.

---

## 11. Practical Nature and Deployment

11.1 The tool is a single web page backed by a small server program. A user
needs only a web browser and no installation. The public demonstration is
hosted on a commercial application-hosting platform, and the project's
repository page redirects visitors to it.

11.2 The repository also contains three stored example results, for Leonardo da
Vinci's Salvator Mundi, Vincent van Gogh's The Starry Night, and Egon Schiele's
Portrait of Wally. These are saved copies of earlier live runs, included so that
the output can be demonstrated without a working connection or a configured
key. Their signature blocks are marked as static snapshots. They are teaching
material and should not be read as current findings.

11.3 The choice of examples is apt. Portrait of Wally is the case that did more
than any other to establish that a loan to an American museum could expose an
unresolved Nazi-era claim: taken from the Jewish Viennese dealer Lea Bondi Jaray
around the time she fled Vienna in 1939, it was seized in New York in 1998 while
on loan to the Museum of Modern Art, and after some thirteen years of federal
forfeiture litigation the matter settled in July 2010 with the Leopold Museum
paying the Bondi estate 19 million United States dollars to retain the painting
and agreeing to display its true provenance permanently alongside it. Salvator
Mundi, sold at Christie's in November 2017 for 450.3 million dollars including
fees, is the case most associated with the opposite problem: a chain of
ownership with a long blank stretch, an attribution that remains contested, and
a present location that is not publicly confirmed.

11.4 All access keys are held in server configuration and are excluded from the
repository. The README notes explicitly that if any key file was ever committed
or shared, the keys should be rotated. That is the right instruction and it is
good practice to have written it down.

---

## 12. Intended Audience and Use

12.1 The tool is aimed at the person who needs a fast first look: a student
researcher, a journalist, a small institution without a provenance department,
a family beginning to trace an object, or a visitor standing in front of a work
with a question about it. For that audience it does something genuinely useful,
which is to run in seconds a set of searches that would otherwise take an
afternoon, and to say clearly which parts of the answer are cited and which are
not.

12.2 It is not aimed at, and should not be used for, the decision points where
the answer carries legal or commercial weight. An acquisition, a sale, a
restitution claim, an export licence, or a repatriation request all require
searches of the restricted registries, examination of physical and archival
evidence, and professional judgment. The right way to read a passport from this
tool is as a list of leads and of questions that have not been answered.

---

## 13. Conclusion

13.1 The value of Provenance Search lies less in what it finds than in how
carefully it reports what it did not find. Its timeline names its gaps. Its
source panel shows silences as well as answers. Its most consequential signal,
the registry match, is computed by rule rather than by a language model. Its
score can be recomputed by hand from four numbers. Its signature states that it
attests to process and not to truth. In a field where an incomplete chain
presented as a complete one is the characteristic harm, that discipline is the
substance of the contribution.

13.2 The prototype's weaknesses are the ones its own design invites. It reads
the public faces of registries rather than the registries themselves, and its
interface language does not make that distinction as sharply as its
documentation does. Its scoring weights are informed guesses. Its search
strategy assumes a world of titled works by named artists, which is not the
world in which most contested cultural property sits. These are addressable,
and naming them is more useful than the tool's current score would be to anyone
making a decision.

13.3 What the project demonstrates is a pattern worth carrying into other
domains: let the automated system gather and arrange, let fixed published rules
do the judging, mark every claim with its origin, and treat the absence of
evidence as a reportable finding rather than a blank to be filled.

---

## Attribution

Developed under the Ethical Tech CoLab at the NYU Center for Global Affairs as
part of masters research (2026). The repository's commit history records a
single contributor, working under the identifier yagorocha-web.

> Note: This report is a plain-language summary of a research prototype. The
> prototype is for academic demonstration only. Its outputs are indicative and
> are not a substitute for professional provenance research, legal advice, or a
> search of the restricted law-enforcement and commercial databases on which
> art-market due diligence relies. A result from this tool is not a clearance,
> a certificate of title, or a finding of any kind.
