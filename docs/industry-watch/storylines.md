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
- **last_movement:** 2026-09-04
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Altman 2026-09-01: “we are also going to be launching our next model soon.” Official 2026-09-03: “rolling out today to a limited set of organizations and over the coming days will become available to all ChatGPT Plus, Pro, Business, and Enterprise users.” OpenAI 2026-09-04: Plus and Business “might take a few days.” The Decoder 2026-09-05 still has Plus pending. Do not invent a free-tier date.
- **why_it_matters:** Phased frontier access plus a unilateral RL pause is the GPT-6 pattern, not a single “the model is out” headline.
- **latest:**
  - 2026-09-03 limited orgs / Daybreak; 2026-09-04 Pro, Enterprise, Business Premium in Work/Codex + API (`gpt-6-astra`). Plus/Business still unfinished.
  - First **public** AA score 2026-09-04: Index v4.2 has Fable 5.1 first, Astra second, “+4pt gain over GPT-5.6 Sol.” Sep 3 AA article (prior index): Astra 61, equal to Sol, 5 behind Fable 5.1 (66). **Seam cache still 0 rows** for `astra` / `gpt-6`.
  - Arena 2026-09-04: Astra live in Agent Arena and Code Arena. “Scores coming soon.”
  - Altman 2026-09-05: “astra can make me whatever fun little game i can imagine” — color, not a new access slice. Vendor benches remain official memos.
- **search:** from:sama; from:OpenAI GPT-6 OR Astra; "GPT-6 Astra"; from:ArtificialAnlys Astra; site:openai.com/index/gpt-6-astra; AA `nameContains: astra` / `gpt-6`
- **sources:**
  - 2026-09-03 · official · https://openai.com/index/gpt-6-astra/
  - 2026-09-04 · exec-x · https://x.com/sama/status/2095973658867171733
  - 2026-09-04 · official · https://x.com/OpenAI/status/2095968413646737608
  - 2026-09-04 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2
  - 2026-09-03 · benchmark · https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra
  - 2026-09-04 · artifact · https://x.com/arena/status/2095971829307580610
  - 2026-09-05 · exec-x · https://x.com/sama/status/2096241436509544744
  - 2026-09-05 · journalist · https://the-decoder.com/openai-rolls-out-gpt-6-astra-to-top-tier-chatgpt-plans-at-half-the-rate-of-gpt-5-6-sol/
  - 2026-09-01 · exec-x · https://x.com/sama/status/2094934592062959832
  - 2026-08-18 · exec-x · https://x.com/sama/status/2089787807611195475
- **open_questions:** When does the Seam AA cache ingest Astra? Does Plus finish this week? Does the White House review become a standing gate for the next slice?

### `google-gemini-flagship-gap`
- **title:** Google Flash cadence hiding a missing Pro
- **status:** delayed
- **confidence:** credible
- **last_movement:** 2026-09-04
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Hassabis 2026-05-19 on 3.5 Flash: “And Pro to come…” Pichai at I/O: Pro “next month” (June). SemiAnalysis/OfficeChai (2026-08-10) say 3.5 Pro was silently cancelled. Official now points at Gemini 4 pretrain, not a Pro GA date. Do not invent one.
- **why_it_matters:** Same-week (Aug 5) leadership change + talent exit + rank drop + Flash-only shipping is one lab-in-crisis story, not a happy startup plus three Flash upgrades.
- **latest:**
  - Public AA (2026-09-02 article): Gemini 3.8 Flash (high) **59**, +3 vs 3.7 Flash (56). Cluster as Flash-only evidence, not a Pro substitute. Seam cache still stops at 3.7 Flash 45.2; no 3.8 row.
  - 2026-09-02 Gemini 3.8 Flash + 3.8 Flash Cyber. Official: “our third updated Flash model in only 6 weeks.” Hassabis: “Relentless progress.” Cyber via Fairwind (governments / trusted partners), not GA.
  - No Hassabis / Pichai / DeepMind model posts since 2026-09-04. Latest Pro row remains Gemini 3.1 Pro Preview (Feb, 36.7).
  - 3.5 Pro appeared on Arena then vanished (IT之家 2026-07-31: ~30 minutes). 2026-08-05 Dean, Ghemawat, Vinyals, Le → Discovery Loop. Treat that as a symptom of Gemini, not a separate win.
- **search:** from:demishassabis; from:GoogleDeepMind; from:sundarpichai; from:JeffDean; "Gemini 3.5 Pro"; "Gemini 3.8"; Fairwind; Discovery Loop; SemiAnalysis Gemini cooked
- **sources:**
  - 2026-09-02 · official · https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/
  - 2026-09-02 · benchmark · https://artificialanalysis.ai/articles/gemini-3-8-flash
  - 2026-09-02 · exec-x · https://x.com/demishassabis/status/2095191106665284046
  - 2026-05-19 · exec-x · https://x.com/demishassabis/status/2056904067406860545
  - 2026-08-05 · exec-x · https://x.com/JeffDean/status/2085034604172603724
  - 2026-08-10 · journalist · https://officechai.com/ai/google-has-silently-canceled-gemini-3-5-pro-says-semi-analysis-report/
  - 2026-07-31 · leak · https://www.ithome.com/0/984/155.htm
- **open_questions:** Does 3.8 Flash get a Seam AA row that moves ≥1.0 vs 3.7? Any Pro (3.5/3.8/4) on Arena that stays? Discovery Loop training-run or cluster signal?

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
  - No new Commerce action, Dario/Anthropic model post, or Mythos access change since 2026-09-04.
  - Public AA v4.2 (2026-09-04): Fable 5.1 still leads the Index; Fable and Opus 5 lead AA-Briefcase. Seam cache: Fable 5.1 56.8 / 81.6 coding, unchanged.
  - 2026-09-01 Fable 5.1 + Mythos 5.1. Official: “They’re the same model, but with different levels of safeguards.” June Commerce order is the standing shape, not a resolved one-off.
- **search:** from:AnthropicAI; from:darioamodei; Fable 5.1; Mythos 5.1; Glasswing; "trusted access"; site:anthropic.com/claude-fable-and-mythos-5-1
- **sources:**
  - 2026-09-01 · official · https://www.anthropic.com/claude-fable-and-mythos-5-1
  - 2026-09-04 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2
  - 2026-06-12 · journalist · https://www.nytimes.com/2026/06/12/technology/anthropic-mythos-fable5-blocked.html
  - 2026-06-30 · journalist · https://www.politico.com/news/2026/06/30/anthropic-wh-lifting-export-limits-00980865
- **open_questions:** Will Mythos 5.1 leave US-only trusted access? Does AA ever score Mythos separately? Any new Commerce action on 5.1?

### `meta-muse-spark`
- **title:** Muse Spark 1.3 — Meta’s closed flagship; max now public
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-04
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Wang 2026-09-04: max is out after “completing our safety testing.” EU still reported on 1.1 in some recaps. Open-weight Spark still on the “looking forward” list, unspecified.
- **why_it_matters:** Meta is back on the closed frontier with a non-Llama line; journalist/AA website numbers are not in the Seam cache, so the rank claim is still unverified here.
- **latest:**
  - Wang 2026-09-04: “we just publicly released Muse Spark 1.3 max!” “as a reminder, we are launching this after completing our safety testing.” Set reasoning to max, or Muse Code. OpenRouter: “Just set reasoning effort to Max.”
  - 2026-09-02 Muse Spark 1.3 in Muse Code + Meta Model API. Fourth Spark in five months. Arena Code WebDev: 1.3 xHigh ~#10 early AutoEval.
  - Public AA Sep 2: max 62 / xhigh 61. v4.2: Meta third-ranked lab; Muse 1.3 on AA-Briefcase behind Fable/Opus/Astra. Seam `nameContains: muse` → 0 rows.
- **search:** from:AIatMeta; from:alexandr_wang; "Muse Spark"; site:ai.meta.com; AA `nameContains: muse`; from:arena Muse Spark
- **sources:**
  - 2026-09-04 · exec-x · https://x.com/alexandr_wang/status/2095938990197329935
  - 2026-09-02 · official · https://ai.meta.com/blog/introducing-muse-spark-1-3
  - 2026-09-02 · benchmark · https://artificialanalysis.ai/articles/muse-spark-1-3
  - 2026-09-02 · artifact · https://x.com/arena/status/2095249508452241633
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
  - No new Kimi model. `from:Kimi_Moonshot` silent since 2026-09-04. Cache rank held at #5.
  - Released 2026-07-16 (2.8T MoE, 1M ctx). Lambert (2026-07-27) on the license: “any company making over $20M/yr must get a specific commercial deal.”
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
  - No new Z.ai SKU. `from:Zai_org` silent since 2026-09-04. `zai-org/GLM-5.3` and GLM-5.3-Flash still on HF trending.
  - API 2026-08-18; Flash 2026-08-26 (Ox Alpha on Chinese chips); full weights 2026-08-28.
- **search:** from:Zai_org; GLM-5.3; Ox Alpha; site:huggingface.co/zai-org/GLM-5.3
- **sources:**
  - 2026-08-28 · official · https://x.com/Zai_org/status/2093354097122455713
  - 2026-08-26 · official · https://x.com/Zai_org/status/2092616204787626030
  - 2026-08-28 · artifact · https://huggingface.co/zai-org/GLM-5.3
- **open_questions:** GLM-5.4 / next Ox? License revenue-share trigger actually enforced?

### `tencent-hy4`
- **title:** Tencent Hy4 preview — 770B Apache-2.0 via HF/Arena
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** Official: “This is an early version of Hy4.” Do not invent a non-preview GA date.
- **why_it_matters:** Same Appendix A class as Kimi/GLM: a non-US lab appearing via HF trending and Arena, not a Western blog. Morning 2026-09-05 sweep missed it.
- **latest:**
  - Weights 2026-08-28: 770B-A49B MoE, 1M ctx, Apache 2.0, HF `tencent/Hy4-preview` (~1.56 TB). FP8 sibling. Still on HF trending this sweep.
  - Code Arena WebDev ~#8 on 2026-09-02 (SCMP / Goldman note; Hy3 was ~#34). DeepSWE vendor/press: 64.3 vs Qwen-3.8 Max 56.6 and DeepSeek-V4 Pro 62.7.
  - Tencent internal blind eval (163 experts, 203 tasks): 2.99 vs GLM-5.3 2.92 / Kimi K3 2.94 — official memo, not the headline. No Seam AA row (`hy4` / `hunyuan` / creator Tencent = 0).
- **search:** Hy4 preview; from:Tencent; site:huggingface.co/tencent/Hy4-preview; site:hy.tencent.ai; "Hy4"; AA `nameContains: hy4` / hunyuan
- **sources:**
  - 2026-08-28 · official · https://hy.tencent.ai/research/hy4-preview
  - 2026-08-28 · official · https://www.tencent.com/tencent-releases-and-open-sources-tencent-hy4-preview/
  - 2026-08-28 · artifact · https://huggingface.co/tencent/Hy4-preview
  - 2026-09-02 · journalist · https://www.scmp.com/tech/big-tech/article/3366068/tencents-hy4-model-gains-open-source-ai-rankings-after-ecosystem-driven-training
- **open_questions:** First Seam AA row? Non-preview Hy4? Does it land inside ~5 II of the closed leader?

### `qwen-3-8-max`
- **title:** Qwen3.8-Max-0902 — API snapshot, Code Arena WebDev point-estimate #1
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-05
- **quiet_sweeps:** 0
- **expected_window:** unspecified next snapshot
- **why_it_matters:** Non-flagship lab via Arena: a date-suffix post-train, not a new generation, took Code Arena WebDev’s point estimate. Not open-weight. Seam AA still has 0 Qwen rows.
- **latest:**
  - 2026-09-02 `Qwen3.8-Max-0902` (2.4T, 1M ctx, $2/$6). Arena: 1691 pts, 3 above Opus 5 Max — **CIs overlap**; Habr/early votes caveat. Pareto at blended $5/MTok.
  - Official benches still have Opus 5 ahead on most SWE/terminal rows Qwen published. Cluster against vendor “#1” framing.
  - Qwen3.8-27B / Flash-Next remain the HF derivative factory. No Seam `hasBenchmark` row.
- **search:** from:Alibaba_Qwen; "Qwen3.8-Max-0902"; "Qwen3.8"; from:arena Qwen; AA `nameContains: qwen`
- **sources:**
  - 2026-09-02 · artifact · https://x.com/arena/status/2094979331420504491
  - 2026-09-02 · journalist · https://technode.com/2026/09/02/alibaba-upgrades-qwen38-max-with-new-0902-snapshot/
- **open_questions:** Do the Arena CIs separate from Opus 5? First Seam AA score? Open-weight Max, or API-only forever?

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
  - No named 4.7 / 5 this window. Musk 2026-09-04 posts are Grok Bot Enterprise, templates, iPad, Imagine contest.
  - 2026-08-15 Musk: “Grok 4.7 has a good chance of exceeding all current models in intelligence.” 2026-09-02: “future version of you is coming soon.” Not a named SKU.
- **search:** from:elonmusk Grok 4.7 OR "coming soon" OR "next Grok"; from:xai model; from:grok
- **sources:**
  - 2026-08-15 · exec-x · https://x.com/elonmusk/status/2088735708693602427
  - 2026-09-02 · exec-x · https://x.com/elonmusk/status/2095219119612412365
- **open_questions:** Named 4.7 vs 5? AA row?

## Resolved

_None yet._
