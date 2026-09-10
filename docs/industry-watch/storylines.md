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
- **last_movement:** 2026-09-10
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 0
- **expected_window:** Plus now has Astra in Work/Codex. GPT-6 Pro in Chat is for eligible Pro, Business, and Enterprise plans; no free-tier date is stated.
- **why_it_matters:** Phased frontier access plus a unilateral RL pause is the GPT-6 pattern, not a single “the model is out” headline.
- **latest:**
  - 2026-09-10 OpenAI support: Plus includes Astra in Work/Codex; the GPT-6 Pro Chat surface is separate and remains Pro/Business/Enterprise. Sep 7’s automatic reset explicitly covered the broader launch delay.
  - AA v4.3 (Sep 7) ties Astra (max) with Fable 5.1 at **53**. The newer Seam cache has its first Astra row: **52.8 / 76.9 coding**. The cache score is v4.3-era; do not compare it with the prior v4.2 snapshot point-for-point.
  - Agent Arena was still collecting data for strong confidence intervals at the last check (Sep 6); no newer Arena result found.
- **search:** from:sama; from:OpenAI GPT-6 OR Astra; "GPT-6 Astra"; from:ArtificialAnlys Astra; site:openai.com/index/gpt-6-astra; AA `nameContains: astra` / `gpt-6`
- **sources:**
  - 2026-09-03 · official · https://openai.com/index/gpt-6-astra/
  - 2026-09-04 · exec-x · https://x.com/sama/status/2095973658867171733
  - 2026-09-04 · official · https://x.com/OpenAI/status/2095968413646737608
  - 2026-09-04 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2
  - 2026-09-09 · benchmark · https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra
  - 2026-09-04 · artifact · https://x.com/arena/status/2095971829307580610
  - 2026-09-06 · artifact · https://x.com/arena/status/2096405524086759887
  - 2026-09-05 · exec-x · https://x.com/sama/status/2096241436509544744
  - 2026-09-05 · journalist · https://the-decoder.com/openai-rolls-out-gpt-6-astra-to-top-tier-chatgpt-plans-at-half-the-rate-of-gpt-5-6-sol/
  - 2026-09-06 · journalist · https://the-decoder.com/openai-developer-claims-astra-boosted-productivity-so-much-it-pulled-some-plans-forward-by-six-months/
  - 2026-09-10 · official · https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
  - 2026-09-01 · exec-x · https://x.com/sama/status/2094934592062959832
  - 2026-08-18 · exec-x · https://x.com/sama/status/2089787807611195475
- **open_questions:** How quickly does the Chat surface expand beyond Pro/Business/Enterprise? Does the White House review become a standing gate for the next slice?

### `google-gemini-flagship-gap`
- **title:** Google Flash cadence hiding a missing Pro
- **status:** delayed
- **confidence:** credible
- **last_movement:** 2026-09-10
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 0
- **expected_window:** Hassabis 2026-05-19 on 3.5 Flash: “And Pro to come…” Pichai at I/O: Pro “next month” (June). SemiAnalysis/OfficeChai (2026-08-10) say 3.5 Pro was silently cancelled. Official now points at Gemini 4 pretrain, not a Pro GA date. Do not invent one.
- **why_it_matters:** Same-week (Aug 5) leadership change + talent exit + rank drop + Flash-only shipping is one lab-in-crisis story, not a happy startup plus three Flash upgrades.
- **latest:**
  - AA v4.3-era Seam cache now has its first Gemini 3.8 Flash row: **41.2 / 76.3 coding**. This is coverage finally arriving, not a Pro substitute or an apples-to-apples move against the Sep 6 cache.
  - Google’s current model-card list still ends Pro at Gemini 3.1 Pro (updated Feb 19); all newer language cards are Flash-family variants.
  - No new Hassabis / Pichai / DeepMind / Dean flagship-model signal found after Sep 6.
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
  - 2026-09-10 · official · https://deepmind.google/models/model-cards/
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
- **open_questions:** Any Pro (3.5/3.8/4) on Arena that stays? Discovery Loop training-run or cluster signal?

### `anthropic-fable-mythos-gates`
- **title:** Fable 5.1 GA / Mythos 5.1 trusted-access — same model, two gates
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-09
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 0
- **expected_window:** Mythos still “US organizations only for now”; biology LSVP “we expect to open enrollment for scientists soon.” EFS “beginning later this fall.”
- **why_it_matters:** Government constraint on a lab’s best model is now a standing product shape (GA twin + defender/life-science twin), not a one-off June outage.
- **latest:**
  - 2026-09-09: Jacob Coxon, a pretraining researcher who worked at OpenAI and Anthropic, resigned publicly: “They are racing straight to self-improving superintelligence and gambling with our lives.” He says he left before Anthropic equity vested.
  - Alignment lead Evan Hubinger publicly echoed the core concern; Anthropic told WIRED it favors a “lawful, verifiable way” for industry to pace powerful releases. This is a safety-race fracture, not evidence of a new model or access gate.
  - AA v4.3 ties Fable 5.1 with Astra at **53**. Seam’s current Fable/Opus catalog rows show `unresolved-effort` against AA snapshot 8, so their cache absence is a matching diagnostic, not a score drop.
  - Mythos remains trusted access; Fable remains the safeguarded general-access twin. No Commerce or Mythos eligibility change found.
- **search:** from:AnthropicAI; from:darioamodei; Fable 5.1; Mythos 5.1; Glasswing; "trusted access"; site:anthropic.com/claude-fable-and-mythos-5-1
- **sources:**
  - 2026-09-01 · official · https://www.anthropic.com/claude-fable-and-mythos-5-1
  - 2026-09-04 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2
  - 2026-09-06 · artifact · https://x.com/arena/status/2096398986383184269
  - 2026-06-12 · journalist · https://www.nytimes.com/2026/06/12/technology/anthropic-mythos-fable5-blocked.html
  - 2026-06-30 · journalist · https://www.politico.com/news/2026/06/30/anthropic-wh-lifting-export-limits-00980865
  - 2026-09-09 · exec-x · https://x.com/hilbertspaess/status/2097476196791709843
  - 2026-09-09 · journalist · https://www.wired.com/story/anthropic-researcher-quits-jacob-coxon-ai-fears-humanity/
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
- **open_questions:** Will Mythos 5.1 leave US-only trusted access? Does AA ever score Mythos separately? Does the public internal-safety dispute produce a concrete pacing or governance change?

### `meta-muse-spark`
- **title:** Muse Spark 1.3 — Meta’s closed flagship; max now public
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-04
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 2
- **expected_window:** Wang 2026-09-04: max is out after “completing our safety testing.” EU still reported on 1.1 in some recaps. Open-weight Spark still on the “looking forward” list, unspecified.
- **why_it_matters:** Meta is back on the closed frontier with a non-Llama line; journalist/AA website numbers are not in the Seam cache, so the rank claim is still unverified here.
- **latest:**
  - Meta launched the consumer Muse personal agent on Sep 8, powered by existing Muse Spark. That is a product rollout, not a new Spark model or open-weight release.
  - AA v4.3 lists Muse Spark 1.3 (max) at **48**; Seam `nameContains: muse` still has no matched row.
  - No 1.3 successor, Llama successor, or Arena movement found.
- **search:** from:AIatMeta; from:alexandr_wang; "Muse Spark"; site:ai.meta.com; AA `nameContains: muse`; from:arena Muse Spark
- **sources:**
  - 2026-09-04 · exec-x · https://x.com/alexandr_wang/status/2095938990197329935
  - 2026-09-05 · exec-x · https://x.com/alexandr_wang/status/2096252196178571597
  - 2026-09-02 · official · https://ai.meta.com/blog/introducing-muse-spark-1-3
  - 2026-09-02 · benchmark · https://artificialanalysis.ai/articles/muse-spark-1-3
  - 2026-09-02 · artifact · https://x.com/arena/status/2095249508452241633
  - 2026-09-08 · official · https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
- **open_questions:** First Seam AA row? Open-weight Llama successor, or is Spark the closed path now?

### `kimi-k3`
- **title:** Kimi K3 — open-weight inside the closed top five
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-07-16
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 2
- **expected_window:** unspecified (no K4 timing found this sweep)
- **why_it_matters:** A frontier-scale non-US open-weight. Current matched Seam cache puts K3 at 43.8, but AA v4.3 changed the composite methodology; keep versioned comparisons separate. License is not MIT: >$20M/yr needs a commercial deal.
- **latest:**
  - No new Kimi model or K4 training signal found. Current matched Seam cache value is 43.8; it is not comparable with the Sep 6 50.2 cache snapshot because AA v4.3 reset the composite.
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
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 2
- **expected_window:** unspecified
- **why_it_matters:** Non-flagship lab via HF/AA: v4.3 puts GLM-5.3 Flash at 42; weights are public; Flash previously ran as anonymous Ox Alpha. Seam cache has no current GLM row — coverage, not a public fall.
- **latest:**
  - No new Z.ai SKU. `zai-org/GLM-5.3` and GLM-5.3-Flash remain active on HF; Flash was updated recently, not replaced.
  - AA v4.3 lists GLM-5.3 Flash at **42**. Seam cache remains 0 GLM rows; the older numbers and current index are not comparable across v4.2/v4.3.
  - OpenCode “Omen Alpha” (2026-09-04) has a similar failure fingerprint to Ox Alpha / GLM-5.3-Flash in one private bench — speculative, not a named 5.4.
- **search:** from:Zai_org; GLM-5.3; Ox Alpha; Omen Alpha; site:huggingface.co/zai-org/GLM-5.3
- **sources:**
  - 2026-08-28 · official · https://x.com/Zai_org/status/2093354097122455713
  - 2026-08-26 · official · https://x.com/Zai_org/status/2092616204787626030
  - 2026-08-28 · artifact · https://huggingface.co/zai-org/GLM-5.3
  - 2026-09-06 · benchmark · https://artificialanalysis.ai/models/glm-5-3
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
- **open_questions:** GLM-5.4 / next Ox? Does Seam cache restore the GLM row? Is Omen Alpha a Z.ai stealth?

### `tencent-hy4`
- **title:** Tencent Hy4 preview — 770B Apache-2.0 via HF/Arena
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 2
- **expected_window:** Official: “This is an early version of Hy4.” Do not invent a non-preview GA date.
- **why_it_matters:** Same Appendix A class as Kimi/GLM: a non-US lab appearing via HF trending and Arena, not a Western blog. Morning 2026-09-05 sweep missed it.
- **latest:**
  - Weights: 770B-A49B MoE, 1M ctx, Apache 2.0, HF `tencent/Hy4-preview`. Still an early preview; no Seam AA row.
  - No new Arena post or non-preview Hy4 found.
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
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 2
- **expected_window:** unspecified next snapshot
- **why_it_matters:** Non-flagship lab via Arena: a date-suffix post-train, not a new generation, took Code Arena WebDev’s point estimate. Not open-weight. Seam AA still has 0 Qwen rows.
- **latest:**
  - 2026-09-02 `Qwen3.8-Max-0902` (2.4T, 1M ctx, $2/$6). Arena: 1691 pts, 3 above Opus 5 Max — **CIs overlap**. No new Arena post this window.
  - AA v4.3 scores a `Qwen3.8 2.4T A95B` at 40, but the Seam cache has no Qwen row and the public version mapping does not establish that it is the 0902 API snapshot. Do not attribute the score to 0902 yet.
- **search:** from:Alibaba_Qwen; "Qwen3.8-Max-0902"; "Qwen3.8"; from:arena Qwen; AA `nameContains: qwen`
- **sources:**
  - 2026-09-02 · artifact · https://x.com/arena/status/2094979331420504491
  - 2026-09-02 · journalist · https://technode.com/2026/09/02/alibaba-upgrades-qwen38-max-with-new-0902-snapshot/
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
- **open_questions:** Do the Arena CIs separate from Opus 5? First Seam AA score? Open-weight Max, or API-only forever?

### `deepseek-v4-1-flash`
- **title:** DeepSeek V4.1 Flash — new multimodal, open-weight architecture
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-09-10
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 0
- **expected_window:** V4 Pro API calls route to V4.1 Flash after 12:00 Beijing Time on 2026-09-14, until V4.1 Pro releases. No V4.1 Pro date stated.
- **why_it_matters:** A newly shipped 552B-backbone, 1M-context MIT model with public weights is a real open-weight frontier attempt; the public cache has not yet independently scored it.
- **latest:**
  - DeepSeek officially released V4.1 Flash on 2026-09-10 with native multimodal API access. The old V4 Flash and V4 Flash Vision Exp API names now route to it; V4 Pro is slated to route to it on Sep 14 pending V4.1 Pro.
  - Official HF artifact: 552B backbone parameters, 8B activated during prefill / 16B during decode, 1M context, 45T-token multimodal pretraining, and MIT weights.
  - DeepSeek reports 90.6 on Terminal-Bench 2.1 and 74.2 on DeepSWE v1.1 at max reasoning. These are vendor figures; no AA/Arena score or Seam metadata row exists yet.
- **search:** from:deepseek_ai; "DeepSeek V4.1 Flash"; "deepseek-flash"; site:huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash; site:api-docs.deepseek.com/updates; AA `nameContains: deepseek` / `v4.1`
- **sources:**
  - 2026-09-10 · official · https://api-docs.deepseek.com/updates/
  - 2026-09-10 · artifact · https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash
- **open_questions:** First independent AA / Arena result? Does V4.1 Pro ship as a larger architecture sibling, and does the public cache obtain a catalog row?

### `grok-next`
- **title:** Grok 4.7 has an exec-stated near-term window
- **status:** rumored
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-10
- **quiet_sweeps:** 2
- **expected_window:** Musk Sep 2: “Grok 4.7 comes out in 10 days” — roughly Sep 12 by arithmetic, not a separately published xAI launch date.
- **why_it_matters:** An exec-stated named model window is stronger than a generic “soon,” but no model card, API identifier, price, or independent score exists yet.
- **latest:**
  - Retrospective correction: Musk’s Sep 2 post explicitly named **Grok 4.7** and said it “comes out in 10 days.” The previous sweep’s unnamed-reading was wrong; the date remains an inference, not a promised release calendar.
  - No post-Sep-6 ship signal. Musk’s newer Grok posts are Bot/Imagine/tutoring, not a model release. Grok 4.6 is the measurable production baseline.
- **search:** from:elonmusk Grok 4.7 OR "coming soon" OR "next Grok"; from:xai model; from:grok
- **sources:**
  - 2026-08-15 · exec-x · https://x.com/elonmusk/status/2088735708693602427
  - 2026-09-02 · exec-x · https://x.com/elonmusk/status/2095219119612412365
  - 2026-09-02 · exec-x · https://x.com/elonmusk/status/2094983639780204846
- **open_questions:** Does 4.7 ship on the implied window? What are its price, API identifier, and first independent AA/Arena signals?

## Resolved

_None yet._
