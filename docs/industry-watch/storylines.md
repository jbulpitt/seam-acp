# Storylines

Persistent topics **after** discovery. Do not pre-load headlines.

Copy the schema from `runbook.md` §5 when a sweep creates a row.
Promote only if §4's inclusion bar hits. After 14 quiet daily sweeps, set
`status: stale` rather than deleting.

## Live

### `gpt-6-astra`
- **title:** GPT-6 Astra ships in slices after a safety pause
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-05
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Altman 2026-09-01: “we are also going to be launching our next model soon.” Official 2026-09-03: “rolling out today to a limited set of organizations and over the coming days will become available to all ChatGPT Plus, Pro, Business, and Enterprise users.” Do not invent a free-tier date.
- **why_it_matters:** Phased frontier access plus a unilateral RL pause is the GPT-6 pattern, not a single “the model is out” headline.
- **latest:**
  - 2026-09-03 limited orgs / Daybreak; 2026-09-04 Pro, Enterprise, Business Premium in Work/Codex + API (`gpt-6-astra`). Plus/Business “next.”
  - Altman 2026-09-01: “Astra has been done training for a while now and is a significant step forward in both capabilities and alignment.” 2026-08-18: “We have paused some frontier RL training to ensure that we can meet the appropriate alignment, security and monitoring standards.”
  - Vendor benches (FrontierMath T4 98%, ARC-AGI-3 99.9%, ExploitBench 100%) are official memos, not the headline. No Seam AA row yet.
  - CNET: model “approved by the White House” under a voluntary review framework. Cyber PoC / exploit work refused for general users; Daybreak gets the looser tool.
- **search:** from:sama; from:OpenAI GPT-6 OR Astra; "GPT-6 Astra"; site:openai.com/index/gpt-6-astra; AA `nameContains: astra` / `gpt-6`
- **sources:**
  - 2026-09-03 · official · https://openai.com/index/gpt-6-astra/
  - 2026-09-04 · exec-x · https://x.com/sama/status/2095973658867171733
  - 2026-09-01 · exec-x · https://x.com/sama/status/2094934592062959832
  - 2026-08-18 · exec-x · https://x.com/sama/status/2089787807611195475
  - 2026-09-03 · journalist · https://www.wired.com/story/openai-says-gpt-6-can-use-a-computer-better-than-a-human/
  - 2026-09-03 · journalist · https://www.cnet.com/tech/services-and-software/openai-gpt-6-astra-release-ai-agi-chatgpt/
- **open_questions:** When does AA post a first Intelligence Index? Does Plus finish rolling this week? Does the White House review become a standing gate for the next slice?

### `google-gemini-flagship-gap`
- **title:** Google Flash cadence hiding a missing Pro
- **status:** delayed
- **confidence:** credible
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Hassabis 2026-05-19 on 3.5 Flash: “And Pro to come…” Pichai at I/O: Pro “next month” (June). SemiAnalysis/OfficeChai (2026-08-10) say 3.5 Pro was silently cancelled. Official now points at Gemini 4 pretrain, not a Pro GA date. Do not invent one.
- **why_it_matters:** Same-week (Aug 5) leadership change + talent exit + rank drop + Flash-only shipping is one lab-in-crisis story, not a happy startup plus three Flash upgrades.
- **latest:**
  - 2026-09-02 Gemini 3.8 Flash + 3.8 Flash Cyber. Official: “our third updated Flash model in only 6 weeks.” Hassabis: “Relentless progress.” Cyber via Fairwind (governments / trusted partners), not GA.
  - AA cache still has no 3.5/3.7/3.8 Pro. Best Google row is 3.7 Flash at 45.2 (rank ~14). Latest Pro is 3.1 Pro Preview (Feb, 36.7).
  - 3.5 Pro appeared on Arena then vanished (IT之家 2026-07-31: ~30 minutes). OfficeChai recap of SemiAnalysis: cancelled, Gemini 4 already on the cluster.
  - 2026-08-05 Jeff Dean, Sanjay Ghemawat, Oriol Vinyals, Quoc Le left to found Discovery Loop (PBC). Hassabis left day-to-day DeepMind CEO → chair / Alphabet chief scientist; Koray Kavukcuoglu owns model shipping. Treat Discovery Loop as a symptom of Gemini, not a separate win, until it has a frontier artifact.
- **search:** from:demishassabis; from:GoogleDeepMind; from:sundarpichai; from:JeffDean; "Gemini 3.5 Pro"; "Gemini 3.8"; Fairwind; Discovery Loop; SemiAnalysis Gemini cooked
- **sources:**
  - 2026-09-02 · official · https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/
  - 2026-09-02 · exec-x · https://x.com/demishassabis/status/2095191106665284046
  - 2026-05-19 · exec-x · https://x.com/demishassabis/status/2056904067406860545
  - 2026-08-05 · exec-x · https://x.com/JeffDean/status/2085034604172603724
  - 2026-08-10 · journalist · https://officechai.com/ai/google-has-silently-canceled-gemini-3-5-pro-says-semi-analysis-report/
  - 2026-08-07 · journalist · https://newsletter.semianalysis.com/p/gemini-is-cooked-but-gcp-is-cooking
  - 2026-07-31 · leak · https://www.ithome.com/0/984/155.htm
- **open_questions:** Does 3.8 Flash get an AA row that moves ≥1.0 vs 3.7? Any Pro (3.5/3.8/4) on Arena that stays? Discovery Loop training-run or cluster signal?

### `anthropic-fable-mythos-gates`
- **title:** Fable 5.1 GA / Mythos 5.1 trusted-access — same model, two gates
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-01
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Mythos still “US organizations only for now”; biology LSVP “we expect to open enrollment for scientists soon.” EFS “beginning later this fall.”
- **why_it_matters:** Government constraint on a lab’s best model is now a standing product shape (GA twin + defender/life-science twin), not a one-off June outage.
- **latest:**
  - 2026-09-01 Fable 5.1 + Mythos 5.1. Official: “They’re the same model, but with different levels of safeguards.” Fable GA; Mythos through Cyber and Life Sciences verification programs, “developed in partnership with the US government.”
  - AA: Fable 5.1 Intelligence 56.8 / Coding 81.6 — first score, new #1, +3.6 vs Fable 5 (53.2). Cache-read price $0.25/MTok (−75%).
  - June 12 Commerce order took Fable 5 and Mythos 5 offline for foreign-national access; restored ~June 30 after Lutnick letter. 5.1 ships under that settlement, not as if the constraint vanished.
  - Mythos 5.1 protein-binder claim (~50% hit rate / 12 targets) is the unmuzzled twin; do not headline it as a Fable GA capability.
- **search:** from:AnthropicAI; from:darioamodei; Fable 5.1; Mythos 5.1; Glasswing; "trusted access"; site:anthropic.com/claude-fable-and-mythos-5-1
- **sources:**
  - 2026-09-01 · official · https://www.anthropic.com/claude-fable-and-mythos-5-1
  - 2026-06-09 · official · https://www.anthropic.com/news/claude-fable-5-mythos-5
  - 2026-06-12 · journalist · https://www.nytimes.com/2026/06/12/technology/anthropic-mythos-fable5-blocked.html
  - 2026-06-30 · journalist · https://www.politico.com/news/2026/06/30/anthropic-wh-lifting-export-limits-00980865
- **open_questions:** Will Mythos 5.1 leave US-only trusted access? Does AA ever score Mythos separately? Any new Commerce action on 5.1?

### `meta-muse-spark`
- **title:** Muse Spark 1.3 — Meta’s closed flagship, still missing from our AA cache
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** unspecified for `max` reasoning mode (“after further safety testing”). EU still reported on 1.1 in some recaps.
- **why_it_matters:** Meta is back on the closed frontier with a non-Llama line; journalist AA numbers are not in the Seam cache, so the rank claim is still unverified here.
- **latest:**
  - 2026-09-02 Muse Spark 1.3 in Muse Code + Meta Model API. Fourth Spark in five months. Alexandr Wang (Bloomberg via SiliconANGLE): “competitive” with Fable 5.1, “better than” GPT-5.6 Sol on code.
  - Arena posted 1.3 into Agent/Code arenas the same day. 1.2 already sat ~#8 on a 2026-09-02 Arena snapshot (BenchLM).
  - DataCamp / SiliconANGLE cite AA Intelligence 61 (xhigh) / 62 (limited-preview max). Seam `nameContains: muse` → 0 rows. Do not promote those scores to confirmed until they land in `snapshots/`.
- **search:** from:AIatMeta; "Muse Spark"; site:ai.meta.com; AA `nameContains: muse`; from:arena Muse Spark
- **sources:**
  - 2026-09-02 · official · https://ai.meta.com/blog/introducing-muse-spark-1-3 (research.meta.ai/blog/introducing-muse-spark-1-3)
  - 2026-09-02 · artifact · https://x.com/arena/status/2095249508452241633
  - 2026-09-03 · journalist · https://siliconangle.com/2026/09/02/meta-says-it-has-caught-up-with-anthropic-and-openai-after-releasing-muse-spark-1-3-its-most-powerful-llm-so-far/
- **open_questions:** First Seam AA row? Open-weight Llama successor, or is Spark the closed path now?

### `kimi-k3`
- **title:** Kimi K3 — open-weight inside the closed top five
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-07-16
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** unspecified (no K4 timing found this sweep)
- **why_it_matters:** First non-US open-weight to sit in AA’s closed pack (50.2, #5, −6.6 vs Fable 5.1). License is not MIT: >$20M/yr needs a commercial deal.
- **latest:**
  - Released 2026-07-16 (2.8T MoE, 1M ctx). Weights followed ~2026-07-26. Databricks/Together/DO/Nebius day-0.
  - This sweep: no new Kimi model. AA rank held at #5 under Fable 5.1 / Opus 5 / Fable 5 / Sol.
  - Lambert (2026-07-27) on the license: “any company making over $20M/yr must get a specific commercial deal.”
- **search:** from:Kimi_Moonshot; "Kimi K3"; "Kimi K4"; site:artificialanalysis.ai kimi-k3
- **sources:**
  - 2026-07-17 · benchmark · https://artificialanalysis.ai/articles/kimi-k3-achieves-3-in-the-artificial-analysis-intelligence-index-comparable-to-opus-4-8-and-gpt-5-5
  - 2026-07-27 · exec-x · https://x.com/natolambert/status/2081760901020201086
- **open_questions:** K4 training signal? Does the gap to Fable 5.1 widen now that 5.1 is scored?

### `glm-5-3`
- **title:** GLM-5.3 open-weight + Flash (Ox Alpha) on Chinese silicon
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-08-28
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** unspecified
- **why_it_matters:** Non-flagship lab via HF/AA: 48.6 II (#7), Flash 46.2; weights dropped in-window; Flash previously ran as anonymous Ox Alpha on Chinese chips.
- **latest:**
  - API 2026-08-18; GLM-5.3-Flash 2026-08-26 (320B-A18B, MIT, “Previously previewed as Ox Alpha, running entirely on Chinese AI chips”); full 5.3 weights 2026-08-28 (HF `zai-org/GLM-5.3`).
  - Official: “Our most capable model for agentic coding and cyber defense.” Vendor: matches Mythos 5 on white-box review (cluster against Fable/Mythos gates, don’t take as independent SOTA).
  - Lambert 2026-08-14: “why we should stop being so surprised about these very strong Chinese models.”
- **search:** from:Zai_org; GLM-5.3; Ox Alpha; site:huggingface.co/zai-org/GLM-5.3
- **sources:**
  - 2026-08-28 · official · https://x.com/Zai_org/status/2093354097122455713
  - 2026-08-26 · official · https://x.com/Zai_org/status/2092616204787626030
  - 2026-08-14 · journalist · https://www.interconnects.ai/p/glm-53-how-chinese-labs-keep-stride
  - 2026-08-28 · artifact · https://huggingface.co/zai-org/GLM-5.3
- **open_questions:** GLM-5.4 / next Ox? License revenue-share trigger actually enforced?

### `grok-next`
- **title:** Musk talking a smarter Grok than 4.6
- **status:** rumored
- **confidence:** speculative
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** “soon” / “has a good chance” — unspecified. Do not turn into a date.
- **why_it_matters:** Exec speech about an unreleased model. 4.6 is already #6 on AA (49.3, 2026-08-12).
- **latest:**
  - 2026-08-15 Musk: “Grok 4.7 has a good chance of exceeding all current models in intelligence.” (That was vs Fable 5, before Fable 5.1 and Astra.)
  - 2026-09-02, replying to @grok missing a joke: “Indeed (sigh). Well, future version of you is coming soon.” Not a named SKU; do not equate with 4.7 without a second source.
  - This week’s xAI posts are Bot/Imagine product, not a model card.
- **search:** from:elonmusk Grok 4.7 OR "coming soon" OR "next Grok"; from:xai model; from:grok
- **sources:**
  - 2026-08-15 · exec-x · https://x.com/elonmusk/status/2088735708693602427
  - 2026-09-02 · exec-x · https://x.com/elonmusk/status/2095219119612412365
- **open_questions:** Named 4.7 vs 5? AA row?

## Resolved

_None yet._
