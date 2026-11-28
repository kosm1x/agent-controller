# November Assesment — dimension 6 (SECURITY AND PRIVACY): opening review and ruling list

> Opened 2026-11-28 and reviewed the same day (the second reading at `main` `3bf07de1`), live build `06794081`. Read-only: nothing in `src/`, `scripts/` or on the live host was changed. This file ends at the ruling list; the decisions on it are put to the operator one yes or no at a time.
> Parent: `docs/planning/november-assesment-2026-11-09.md` (§6, Security 6 and Privacy 5). Queue: 4kb. Opened ahead of dimensions 3 to 5 on the operator's instruction of 2026-11-26.
> This repository is public. What follows names categories and counts. Files, lines, mechanisms and the exact shape of each gap are kept off-repo with the review's working papers, and an exposure that is open today is named by category only until it is closed.

## Method

1. **Inventory first.** One reader collected every security or privacy item already on record since 2026-11-09 (the assessment, the code review, the build log, the queue): 92 items, each with its state (open, fixed, parked, ruled, closed) and sorted into six sub-dimensions, so that nothing known was lost and nothing already fixed was reviewed as new.
2. **Six sub-dimensions, six fresh reviewers** (no shared context), each with today's code, a pack of live measurements and the instruction to verify, extend and size — not to confirm: untrusted input to outward action · host privilege and containment · exposure and identity · secrets and detection · privacy of stored and sent data · the public repository and the supply chain.
3. **The orchestrating session ran every live count itself** (read-only: numbers, names, modes, flags) and re-read the lines behind the first ruling.
4. **Three separate second readers tried to break the 51 load-bearing claims:** 32 confirmed, 16 right in part (corrected below), 0 refuted, 3 open questions answered. They also found 15 items the reviewers had missed.
5. Only what survived is below. Where a reviewer and a second reader disagreed, the correction is stated.

No guard was tried against a real target, nothing was probed on the running service, and no setting of the live service was read; where a finding depends on a live setting it says so.

## Bottom line

**The strengths recorded on 2026-11-09 held where they were re-read.** The confirmation card is built from the stored arguments and their fingerprint is checked again at approval. Stored credentials are used by reference and scrubbed from chat task text before it is saved. The model SDK's helper process gets the service environment, but nothing the model controls can read it today. A pull request from a fork gets a read-only token and no secrets. The lockfile carries integrity values throughout (one dependency is pinned by commit instead), and nothing was installed into this tree while the host's package manager had fallen back to an older major version (2026-11-12 to 11-28).

**The weaknesses are structural, and four of them matter more than the rest.**

1. **Approval depends on a fixed label per tool, not on what the run has read.** The label is decided once, per tool. The tools that act outward most often carry the lowest label and are never asked about; ten further tools carry a confirmation flag that their label cancels; a run with nobody present is asked nothing, with two narrow exceptions. The run-level check that was meant to catch "read something untrusted, then act outward" records its verdict and stops nothing. In 30 days 96 of 830 tasks ran a reading tool followed by an outward one. No harm was found in them; the point is that nothing would have stood in the way.
2. **The area the agent may write to includes places whose content is executed later, outside the agent's own run.** The second readers confirmed several kinds. Work that runs later with nobody present can also be set up without anyone being asked: 4 of the 6 routines created in 30 days carry the command tool. The write rules hold against mistakes; they were not built to hold against a model that has been turned by what it read.
3. **One network exposure is open and one long-lived key guards everything behind it.** The key has no scopes and no expiry. This item was put to the operator first, alone, on 2026-11-27 (Mexico time). It is described here after it is closed.
4. **Copies are less protected than the originals.** Backups and the daily state bundle carry looser file permissions than the data they copy. The offsite copy is not encrypted. Credential and personal-data cleaning is uneven: there are four cleaners with different coverage and four lists of what counts as a secret name, and some stores and some log lines get less cleaning than their siblings.

**Privacy.** "Forget" is partial: it ends the fact in one store and leaves copies in others. One class of conversation memory has no age limit (12,915 rows, the oldest from March 2026). Every chat task keeps the full instruction text it was run with for the retention period: the task rows between 14 and 90 days old (4,438) hold 135.6 MB of such descriptions. Text sent to the embeddings provider gets the credential scrub but not the personal-data redaction that one memory layer applies to itself.

**The public repository and the supply chain.** At `HEAD` there is no live-looking credential: 20 credential-shaped strings in 6 test files, all fixtures by reading. The four groups of files that should not have been public hold 0 files at `HEAD`, but the history keeps them (248 paths by one reviewer's count), and one log file is still tracked. Running code and instruction text still carry the operator's contact details and private project names. The five image lines of the two compose files use moving tags, and no image anywhere is pinned by digest. The continuous-integration workflows have no permissions block and take their actions by tag. Dependency alerts are off.

### Where the record was wrong

| On record | Verdict | What is true |
| --- | --- | --- |
| "the confirmation card can show something other than what gets approved" | WRONG as recorded | The card is built from the stored arguments and the fingerprint is checked again at approval. What remains is a display limit on long values. |
| "four tools carry a confirmation flag that never fires" | UNDERSIZED | Ten. One of the ten was called in 30 days (25 times); the other nine were not. |
| "three lists of secret names that disagree" | UNDERSIZED | Four. |
| "seven container image lines on moving tags" | OVERSIZED | Five, all on moving tags. |
| "nothing was installed during the package-manager fallback" | RIGHT for this tree, not for the host | Two small tool packages were fetched elsewhere on the host by the package runner in that window. Neither they nor anything they pulled in has an install script. |
| "guard refusals reach only the journal" | PARTLY | Three kinds of refusal are recorded where they can be counted; the others reach only the journal. |
| "one monitoring scrape is probably failing" (a reviewer's inference) | REFUTED by the live read | All four scrape jobs were up. |
| "the content envelope is the only marking of outside text" | PARTLY | The envelope helper has no production caller, but outside text is also marked in three other ways (a banner, a delimiter and standing instructions). |
| 2026-11-09: "the repository tracks four groups of files that should not be public" | FIXED at `HEAD`, not in history | 0 files of the four groups at `HEAD`; one further log file is still tracked. |
| 2026-11-09: "operator values in running code" | PARTLY FIXED | The commit identity now comes from configuration. One contact address is still written out in 7 source files, and instruction text still names private projects. |

### What 30 days of use look like (read-only counts, 2026-11-28)

| Measure | Value |
| --- | --- |
| Tool calls / tasks | 4,686 in 830 tasks |
| Tasks with a reading tool followed by an outward tool | 96 (75 with a mail send, 25 with the command tool, 3 with a push) |
| Calls of the command tool | 978 |
| Mail sends | 130 (16 with a copy recipient) |
| Routines created | 6 (4 carry the command tool); 5 of the 15 active routines carry it |
| Tasks that look like a bare call of the task route from outside | 0 |
| Tasks through the agent-to-agent route or the pull route | 0 and 0 |
| Calls of the external-tool server | 0 (its one token is revoked, last used in April) |
| Capabilities above autonomy level 1 | 1 |
| Tasks older than the 90-day limit | 13 (7 at the edge, 5 still waiting, 1 cancelled): retention works |
| Conversation memory with no age limit | 12,915 rows |

## The ruling list

Twelve decisions. Each is put alone, as one yes or no, in this order. Everything in "Work ahead" needs no ruling: it changes nothing the operator sees in daily use and nothing the model sees.

| # | Decision | Recommended | Why | What it costs in daily use |
| --- | --- | --- | --- | --- |
| 1 | Close the open network exposure | YES (put 2026-11-27) | Nothing in code or committed configuration needs it from outside, and no task in 30 days came that way. | One thing stops; the operator was told which. |
| 2 | Creating a routine that carries the command tool or an outward tool asks first | YES | A routine runs with nobody present, so the moment it is created is the last moment anyone can be asked. | One question per such routine: 4 in the last 30 days. |
| 3 | A run with nobody present sends mail only to the operator's own addresses, unless its routine was approved with other recipients | YES | 75 of the 96 read-then-act tasks ended in a mail send. With fixed recipients, text read from outside cannot choose where mail goes. | None for today's routines if their recipients are the operator's; a new outside recipient is approved once, with the routine. |
| 4 | In chat, ask before an outward action when the run has first read outside content | YES, after one week of counting | Replaces the fixed label for the case that matters. It is first built to count only, so the ruling comes with the real number of questions it would have asked. | Unknown until counted; the upper bound from traces is about 3 a day. |
| 5 | The ten tools whose confirmation flag never fires: the flag is honoured, except for image generation | YES | Nine were not called in 30 days, so honouring the flag costs nothing today; image generation is the one in use (25 calls) and would only add questions. | None today. |
| 6 | A new repository is private unless the request says public | YES | Today the default is public. | None; say "public" when wanted. |
| 7 | The everyday class of conversation memory gets an age limit of 12 months | YES | It is the only class that never expires. The oldest row is 8 months old, so nothing is removed on the day this lands. | From March 2027, conversation text older than a year is no longer recalled; facts drawn from it stay. |
| 8 | The full instruction text stored with each chat task is blanked after 14 days | YES, after an inventory of every reader of that text | It is the largest stock of personal text on the host (135.6 MB) and it rides into every backup. | None expected; the inventory decides. |
| 9 | An operator-only "forget" that removes every copy of a fact | YES | Today's forget ends the fact in one store only. | None; a new command. |
| 10 | Contact details and private names move out of code and instruction text into configuration | YES, with the one paid evaluation run already planned for the Code descriptions bundle | The instruction text is model-visible, so the change is judged by the evaluation. | None. |
| 11 | Personal-data redaction of the text sent for embeddings | MEASURE FIRST | It may lower recall quality; the ruling comes back with numbers. | Unknown. |
| 12 | The public history: leave it, make the repository private, or rewrite it | OPERATOR'S CHOICE | The history keeps the removed paths and the values in use before the fixes. Making the repository private is immediate and reversible. A rewrite touches the whole history (2,665 commits), leaves several thousand short commit references in the docs pointing nowhere (about 4,500 by one reviewer's count), and does not reach copies already taken. | Depends on the choice. |

Considered and **not** recommended: asking before every call of the command tool (978 calls in 30 days; it would be answered without reading); removing a tool or a route because it was not called (ruling: never-called is not removable); encrypting the offsite copy from the host side (the copy is pulled by the operator's own machine; the place to encrypt is there).

## Work ahead

No ruling needed. Each batch goes through the usual sequence: builder, separate review, docs, commit, CI.

### Batch S-A — Copies as protected as the originals
Backup and bundle scripts write files that only the owner can read; the existing files are tightened by one operator line. The offsite pull logs in as the owner, so it is not affected (established by reading who collects the files). Status 2026-11-28: the scripts part landed as `4437ea29`.

### Batch S-B — What the agent may write and what runs later
The write rules are extended to the places whose content is executed later; files the approval and credential logic hinges on join the protected list; one limit that is stated to the model but not enforced is settled either way. Status 2026-11-28: the batch is split into pieces built one at a time; the first landed as `296802d3`. Two of its items need a decision each; they are put after the ruling list.

### Batch S-C — Outward plumbing
How stored credentials travel with outward requests (bound to the destinations they were stored for); the same checks on mail fields on both model paths; what the confirmation card shows of long values.

### Batch S-D — One cleaning policy
One shared definition of what a secret name is; the stores and log lines that get less cleaning than their siblings are brought level; the temporary spill files and the prompt-capture aid get an age limit that is enforced.

### Batch S-E — Detection
Counters and alerts for access attempts and for guard refusals; a reader for the audit trail of project records.

### Batch S-F — Supply chain and the public tree
Workflows get a read-only permissions block and take actions by commit; container images are taken by digest (the operator recreates the containers); a default value is removed from one configuration file (its service is not running); the container image build and the package runner are tightened; dependency alerts are turned on (operator, on the hosting site); the last tracked log file is untracked; public text that describes what a guard still lets through is trimmed.

## What this review did not answer

- **Live settings.** The running service's environment was not read. Not established: which optional routes are enabled, which provider path is primary by setting (the cost ledger shows only one provider family in 30 days, so two findings that live on the other path are counted as dormant), whether one administrative secret is set, whether the mail channel is on.
- Whether the operator's own session tooling asks before it loads changed project settings; the severity of one item in batch S-B depends on it.
- Counts in the search database: the read-only account's login is broken (on record).
- Repository rules and the scope of the agent's token on the hosting site.
- A count of one person's name in code (the operator can run it; the name is not written into a review file).
- A scan of the full history for credential shapes: no scanner is installed on the host.

## Next

Ruling 1 is with the operator. The scripts part of batch S-A is landed (`4437ea29`); the first piece of batch S-B is landed (`296802d3`), and its other pieces follow; two items of that batch wait for a decision each. The other rulings follow one at a time. The dimension is re-scored when its batches are built.
