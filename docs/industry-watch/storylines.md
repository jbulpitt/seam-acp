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
- **last_movement:** 2026-09-11
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 13
- **expected_window:** Altman 2026-09-01: “we are also going to be launching our next model soon.” Official 2026-09-03: “rolling out today to a limited set of organizations and over the coming days will become available to all ChatGPT Plus, Pro, Business, and Enterprise users.” OpenAI 2026-09-04: Plus and Business “might take a few days.” The Decoder 2026-09-05 still has Plus pending. Do not invent a free-tier date.
- **why_it_matters:** Phased frontier access plus a unilateral RL pause is the GPT-6 pattern, not a single “the model is out” headline.
- **latest:**
  - 2026-09-24 Arena: Claude Opus 5.5 (Max) is #1 on Code Arena WebDev at 1818, “a solid +26pt lead” over GPT-6 Astra (Max). Astra is no longer the WebDev point-estimate leader. That is a rank change, not Plus/Business completion. OpenAI’s same-day Voice post (“Be powered by GPT-6 Astra, Sol, and Luna”) is a product surface on shipped SKUs.
  - 2026-09-22 OpenAI shipped **GPT-6 Sol and Luna** into ChatGPT Work and Codex for Plus, Pro, Business, Enterprise, and Edu, plus the API. That is a separate cost-tier SKU (`gpt-6-sol-luna`), not Plus/Business completion for Astra.
  - Public AA **v4.3** (2026-09-07) puts Astra (max) at **53**, tied with Fable 5.1. It adds Terminal-Bench v4 and AutomationBench-AA, so it is a methodology reset—not a score delta from v4.2 or the Seam cache.
  - Seam AA cache 2026-09-11: first returned `GPT-6 Astra (max)` row, **52.8 II / 76.9 Coding**. This cache has remapped coverage/scale (Fable/Opus/GLM/DeepSeek now absent), so it is a cache-coverage event, not a comparison with September 6’s public or cache scores.
  - 2026-09-03 limited orgs / Daybreak; 2026-09-04 Pro, Enterprise, Business Premium in Work/Codex + API (`gpt-6-astra`). Plus/Business still unfinished (no official Plus GA this sweep).
  - First **public** AA score 2026-09-04: Index v4.2 has Fable 5.1 first, Astra second, “+4pt gain over GPT-5.6 Sol.” Sep 3 AA article (prior index): Astra 61, equal to Sol, 5 behind Fable 5.1 (66). The September 6 Seam cache had 0 `astra` / `gpt-6` rows; September 11 now returns one.
  - OpenAI 2026-09-17 launched **Astra for Law**: GPT-6 Astra plus a legal search index (~230M URLs) and legal instructions, offered to selected firms via Trusted Access (`gpt-6-astra-law`). Official: a configuration of the existing model, not a new frontier SKU and not Plus/Business completion.
  - Arena 2026-09-16: Code Arena WebDev now ranks GPT-6 Astra Max **#1 at 1,800 pts**, Fable 5.1 Max #2 at 1,758. Head-to-head, Fable is still preferred (43.5% vs Astra 29.0%, 27.4% ties). This completes the prior “collecting CIs” WebDev wait; it is not a new access slice, so quiet_sweeps still advanced.
  - Arena 2026-09-06: Astra still “collecting data until it reaches strong confidence intervals.” No Agent Arena score yet.
  - Decoder 2026-09-06 quotes Thibault Sottiaux that internal Astra “pulled some plans forward by six months” — color, not a new access slice.
- **search:** from:sama; from:OpenAI GPT-6 OR Astra; "GPT-6 Astra"; from:ArtificialAnlys Astra; site:openai.com/index/gpt-6-astra; AA `nameContains: astra` / `gpt-6`
- **sources:**
  - 2026-09-17 · official · https://openai.com/index/astra-for-law/
  - 2026-09-03 · official · https://openai.com/index/gpt-6-astra/
  - 2026-09-04 · exec-x · https://x.com/sama/status/2095973658867171733
  - 2026-09-04 · official · https://x.com/OpenAI/status/2095968413646737608
  - 2026-09-04 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
  - 2026-09-03 · benchmark · https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra
  - 2026-09-16 · artifact · https://x.com/arena/status/2100321600679928152
  - 2026-09-04 · artifact · https://x.com/arena/status/2095971829307580610
  - 2026-09-06 · artifact · https://x.com/arena/status/2096405524086759887
  - 2026-09-05 · exec-x · https://x.com/sama/status/2096241436509544744
  - 2026-09-05 · journalist · https://the-decoder.com/openai-rolls-out-gpt-6-astra-to-top-tier-chatgpt-plans-at-half-the-rate-of-gpt-5-6-sol/
  - 2026-09-06 · journalist · https://the-decoder.com/openai-developer-claims-astra-boosted-productivity-so-much-it-pulled-some-plans-forward-by-six-months/
  - 2026-09-01 · exec-x · https://x.com/sama/status/2094934592062959832
  - 2026-08-18 · exec-x · https://x.com/sama/status/2089787807611195475
- **open_questions:** When does the Seam AA cache ingest Astra? Does Plus finish this week? Does the White House review become a standing gate for the next slice?

### `google-gemini-flagship-gap`
- **title:** Google Flash cadence hiding a missing Pro
- **status:** delayed
- **confidence:** credible
- **last_movement:** 2026-09-14
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 10
- **expected_window:** Hassabis 2026-05-19 on 3.5 Flash: “And Pro to come…” Pichai at I/O: Pro “next month” (June). SemiAnalysis/OfficeChai (2026-08-10) say 3.5 Pro was silently cancelled. Official now points at Gemini 4 pretrain, not a Pro GA date. Do not invent one.
- **why_it_matters:** Same-week (Aug 5) leadership change + talent exit + rank drop + Flash-only shipping is one lab-in-crisis story, not a happy startup plus three Flash upgrades.
- **latest:**
  - **Seam AA cache, source snapshot 74 (2026-09-15):** Gemini 3.5 Flash (high) remains **33.0 II / 70.1 Coding**, after the September 14 −6.7 cache movement. AA’s public index is still v4.3, so this is a cached-score event—not proof of a real-world model regression or a new methodology.
  - Gemini 3.8 Flash remains **41.2 II / 76.3 Coding** in the cache; the returned set still has no Pro row. Public AA’s 2026-09-02 3.8 Flash score remains historical Flash-only evidence, not a Pro substitute.
  - No qualifying Hassabis / Pichai / DeepMind / Dean model artifact, lasting Arena Pro sighting, or Google access announcement surfaced this sweep. Unsourced “Gemini 4 Pro” / “Argon” leak tables circulating on X are not a primary; DeepMind model cards still stop at 3.8 Flash (2 Sep).
  - 3.5 Pro appeared on Arena then vanished (IT之家 2026-07-31: ~30 minutes). The Aug. 5 Dean, Ghemawat, Vinyals, and Le departure cluster remains a Gemini symptom, not a separate startup win.
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
- **last_movement:** 2026-09-22
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 1
- **expected_window:** Official 2026-09-22: Cyber Verification Program expansion “in the coming weeks,” and “the new program will include three tiers for increasingly permissive trusted access, including access to Claude Mythos models.” Sonnet 5.5 and Haiku 5.5 “will follow in the coming weeks.” Official 2026-09-17: individual Pro/Max LSVP “over time.” High-risk Mythos at the 17 Sep launch: “they will remain limited to a small set of entities with additional vetting.” Do not treat the coming-weeks line as an open date.
- **why_it_matters:** Government constraint on a lab’s best model is now a standing product shape (GA twin + defender/life-science twin), not a one-off June outage.
- **latest:**
  - 2026-09-22 official: Opus 5.5 “is comparable to Claude Mythos 5.1 in biology and cybersecurity,” and “we’re deploying it with safeguards similar to those on Claude Fable 5.1.” LSVP applications are open for Opus 5.5 biology use. Cyber: “most cybersecurity tasks will be re-routed to Opus 4.8.” “In the coming weeks we will also be expanding access to our Cyber Verification Program,” with “three tiers for increasingly permissive trusted access, including access to Claude Mythos models.” That is a quoted expansion, not a lift of the 17 Sep high-risk US-government limit.
  - 2026-09-17 official: Anthropic opened applications for the **Life Sciences Verification Program**. Standard Use grants give vetted teams Mythos 5.1, Opus 5, and Sonnet 5 with biology-permissive classifiers. High-risk Use (safeguards that block life-sciences requests removed; single project; six-month renewal) is live for Opus 5 and Sonnet 5; **high-risk Mythos stays limited pending US-government coordination.** Not a general trusted-access opening and not a Commerce-order lift.
  - Public AA **v4.3** (2026-09-07) has Fable 5.1 (max with fallback) tied with Astra at **53**. Its changed benchmark mix is a rebaseline, not a model or access move.
  - 2026-09-11 Seam cache returns no Fable / Mythos / Opus row after returning Fable 5.1 and Opus 5 on September 6. Treat this as cache coverage, not a performance change or access movement.
  - Arena 2026-09-06: Claude Fable 5.1 (Max) **#1 on Agent Arena**, +15.8% net improvement, $4.14 median/task, 6.7k+ sessions. Astra “still collecting” for CIs. No Commerce / Mythos access change.
  - Public AA v4.2 (2026-09-04): Fable 5.1 still leads the Index; Fable and Opus 5 lead AA-Briefcase. September 6 Seam cache: Fable 5.1 56.8 / 81.6 coding; the current cache no longer returns it.
  - 2026-09-01 Fable 5.1 + Mythos 5.1. Official: “They’re the same model, but with different levels of safeguards.” June Commerce order is the standing shape, not a resolved one-off.
- **search:** from:AnthropicAI; from:darioamodei; Fable 5.1; Mythos 5.1; Glasswing; "trusted access"; LSVP; "Life Sciences Verification Program"; site:anthropic.com/news/life-sciences-verification-program; site:anthropic.com/claude-fable-and-mythos-5-1
- **sources:**
  - 2026-09-22 · official · https://www.anthropic.com/news/claude-opus-5-5
  - 2026-09-17 · official · https://www.anthropic.com/news/life-sciences-verification-program
  - 2026-09-01 · official · https://www.anthropic.com/claude-fable-and-mythos-5-1
  - 2026-09-04 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
  - 2026-09-06 · artifact · https://x.com/arena/status/2096398986383184269
  - 2026-06-12 · journalist · https://www.nytimes.com/2026/06/12/technology/anthropic-mythos-fable5-blocked.html
  - 2026-06-30 · journalist · https://www.politico.com/news/2026/06/30/anthropic-wh-lifting-export-limits-00980865
- **open_questions:** Does high-risk Mythos leave the small-entity US-government gate? Individual Pro/Max LSVP? Does AA ever score Mythos separately? Any new Commerce action on 5.1?

### `meta-muse-spark`
- **title:** Muse Spark 1.3 — Meta’s closed flagship; max now public
- **status:** stale
- **confidence:** confirmed
- **last_movement:** 2026-09-04
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 14
- **expected_window:** Wang 2026-09-04: max is out after “completing our safety testing.” EU still reported on 1.1 in some recaps. Open-weight Spark still on the “looking forward” list, unspecified.
- **why_it_matters:** Meta is back on the closed frontier with a non-Llama line; journalist/AA website numbers are not in the Seam cache, so the rank claim is still unverified here.
- **latest:**
  - Public AA v4.3 (2026-09-07) lists Muse Spark 1.3 (max) at **48** after a benchmark-method reset; do not compare it with v4.2’s 62 as a product regression.
  - Wang 2026-09-05: “Try out muse spark 1.3 max before you cast your judgments!” Reminder; max already public 2026-09-04.
  - AIatMeta 2026-09-05 AIRA₃ post-hoc used Muse Spark **1.2**, not a 1.3 drop.
  - Public AA Sep 2: max 62 / xhigh 61. Seam `nameContains: muse` → 0 rows.
- **search:** from:AIatMeta; from:alexandr_wang; "Muse Spark"; site:ai.meta.com; AA `nameContains: muse`; from:arena Muse Spark
- **sources:**
  - 2026-09-04 · exec-x · https://x.com/alexandr_wang/status/2095938990197329935
  - 2026-09-05 · exec-x · https://x.com/alexandr_wang/status/2096252196178571597
  - 2026-09-02 · official · https://ai.meta.com/blog/introducing-muse-spark-1-3
  - 2026-09-02 · benchmark · https://artificialanalysis.ai/articles/muse-spark-1-3
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
  - 2026-09-02 · artifact · https://x.com/arena/status/2095249508452241633
- **open_questions:** First Seam AA row? Open-weight Llama successor, or is Spark the closed path now?

### `kimi-k3`
- **title:** Kimi K3 — open-weight inside the closed top five
- **status:** stale
- **confidence:** confirmed
- **last_movement:** 2026-07-16
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 14
- **expected_window:** unspecified (no K4 timing found this sweep)
- **why_it_matters:** First non-US open-weight to sit in AA’s closed pack (50.2, #5, −6.6 vs Fable 5.1). License is not MIT: >$20M/yr needs a commercial deal.
- **latest:**
  - AA v4.3 (2026-09-07) still groups Kimi K3 with GLM-5.3 as the open-weight leaders. The changed evaluation suite is not a model move; no K4 artifact appeared.
  - No new Kimi model. `from:Kimi_Moonshot` silent since 2026-09-04. No cache rank movement is claimed because the September 11 cache remapped coverage and scale.
  - Released 2026-07-16 (2.8T MoE, 1M ctx). Lambert (2026-07-27) on the license: “any company making over $20M/yr must get a specific commercial deal.”
- **search:** from:Kimi_Moonshot; "Kimi K3"; "Kimi K4"; site:artificialanalysis.ai kimi-k3
- **sources:**
  - 2026-07-17 · benchmark · https://artificialanalysis.ai/articles/kimi-k3-achieves-3-in-the-artificial-analysis-intelligence-index-comparable-to-opus-4-8-and-gpt-5-5
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
  - 2026-07-27 · exec-x · https://x.com/natolambert/status/2081760901020201086
- **open_questions:** K4 training signal? Does the gap to Fable 5.1 widen now that 5.1 is scored?

### `glm-5-3`
- **title:** GLM-5.3 open-weight + Flash (Ox Alpha) on Chinese silicon
- **status:** stale
- **confidence:** confirmed
- **last_movement:** 2026-08-28
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 14
- **expected_window:** unspecified
- **why_it_matters:** Non-flagship lab via HF/AA: AA put GLM-5.3 at 49 before v4.3’s methodology reset and 45 under v4.3; weights dropped in-window; Flash previously ran as anonymous Ox Alpha on Chinese chips. Seam cache dropped the row this sweep — coverage, not a public fall.
- **latest:**
  - AA v4.3 (2026-09-07) keeps GLM-5.3 as the top open-weight model at **45**, ahead of Kimi K3 at 44, and puts GLM-5.3 Flash at **42**. This reflects a changed index, not a new GLM SKU or a score comparison with v4.2.
  - No new Z.ai SKU. `from:Zai_org` silent. `zai-org/GLM-5.3` and GLM-5.3-Flash still on HF trending.
  - Before the v4.3 methodology reset, public AA listed GLM-5.3 (max) **49** / Flash **46**. Seam cache: 0 rows (were 48.6 / 46.2 yesterday).
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
- **status:** stale
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 14
- **expected_window:** Official: “This is an early version of Hy4.” Do not invent a non-preview GA date.
- **why_it_matters:** Same Appendix A class as Kimi/GLM: a non-US lab appearing via HF trending and Arena, not a Western blog. Morning 2026-09-05 sweep missed it.
- **latest:**
  - Hugging Face still lists `tencent/Hy4-preview` as a preview model, last updated 14 days ago; no non-preview Hy4 or AA row surfaced.
  - Weights 2026-08-28: 770B-A49B MoE, 1M ctx, Apache 2.0, HF `tencent/Hy4-preview`. Still on HF trending this sweep. No Seam AA row.
  - Code Arena WebDev ~#8 on 2026-09-02 (SCMP / Goldman note). No new Arena post this window.
- **search:** Hy4 preview; from:Tencent; site:huggingface.co/tencent/Hy4-preview; site:hy.tencent.ai; "Hy4"; AA `nameContains: hy4` / hunyuan
- **sources:**
  - 2026-08-28 · official · https://hy.tencent.ai/research/hy4-preview
  - 2026-08-28 · official · https://www.tencent.com/tencent-releases-and-open-sources-tencent-hy4-preview/
  - 2026-08-28 · artifact · https://huggingface.co/tencent/Hy4-preview
  - 2026-09-02 · journalist · https://www.scmp.com/tech/big-tech/article/3366068/tencents-hy4-model-gains-open-source-ai-rankings-after-ecosystem-driven-training
- **open_questions:** First Seam AA row? Non-preview Hy4? Does it land inside ~5 II of the closed leader?

### `qwen-3-8-max`
- **title:** Qwen3.8-Max-0902 — API snapshot, Code Arena WebDev point-estimate #1
- **status:** stale
- **confidence:** confirmed
- **last_movement:** 2026-09-02
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 14
- **expected_window:** unspecified next snapshot
- **why_it_matters:** Non-flagship lab via Arena: a date-suffix post-train, not a new generation, took Code Arena WebDev’s point estimate. Not open-weight. Seam AA still has 0 Qwen rows.
- **latest:**
  - 2026-09-19 `from:Alibaba_Qwen`: **Qwen3.8-LiveTranslate**, a real-time simultaneous-interpretation SKU (60 languages; vendor: LAAL 2.8s → 2.3s). Audio, not a Max-0902 follow-up or AA row. Same class as Omni-Flash / Gemini 3.8 Live — out of this product’s text-frontier bar.
  - 2026-09-18 `from:Alibaba_Qwen`: **Qwen3.8-Omni-Flash**, a native omni-modal Flash SKU (audio-video agentic; vendor: approaching Gemini 3.8 Flash in audio-video). API + plugins/harness, not a Max-0902 follow-up, not an Arena CI separation, not an AA row.
  - AA v4.3 (2026-09-07) lists Qwen3.8 2.4T A95B at **40**, behind GLM-5.3 Flash (42), under a changed suite. That is not a new Qwen snapshot or an Arena separation.
  - 2026-09-02 `Qwen3.8-Max-0902` (2.4T, 1M ctx, $2/$6). Arena: 1691 pts, 3 above Opus 5 Max — **CIs overlap**. No new Arena post this window. Qwen3.8-27B / Flash-Next remain the HF derivative factory. No Seam `hasBenchmark` row.
- **search:** from:Alibaba_Qwen; "Qwen3.8-Max-0902"; "Qwen3.8-Omni-Flash"; "Qwen3.8-LiveTranslate"; "Qwen3.8"; from:arena Qwen; AA `nameContains: qwen`
- **sources:**
  - 2026-09-18 · official · https://qwen.ai/home
  - 2026-09-02 · artifact · https://x.com/arena/status/2094979331420504491
  - 2026-09-02 · journalist · https://technode.com/2026/09/02/alibaba-upgrades-qwen38-max-with-new-0902-snapshot/
  - 2026-09-07 · benchmark · https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-3
- **open_questions:** Do the Arena CIs separate from Opus 5? First Seam AA score? Open-weight Max, or API-only forever?

### `grok-next`
- **title:** Grok 4.7 shipped; first AA score 46
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-09-22
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 1
- **expected_window:** Shipped 2026-09-21. No quoted window for a next SKU this sweep.
- **why_it_matters:** The named unreleased Grok is now a public model with a first independent score of 46, 12 points behind Opus 5.5.
- **latest:**
  - 2026-09-22 Arena: “Grok 4.7 (xHigh) by @SpaceXAI just landed at #10 in Code Arena: WebDev with 1632 pts.” “a 16 pt gain and increase of six positions” versus Grok 4.6 (High) at #16 with 1616. Agent Arena text/vision scores were not in that post.
  - 2026-09-21 SpaceXAI: “Grok 4.7 is here. It's a notable improvement over Grok 4.6 at the same price and speed.” Official: “Served at the same price and speed as Grok 4.6, it is highly competitive in its class.” Live in the API, Cursor, and Grok Build. $2/$6 per million, 500k context. A fast variant is twice the output speed at twice the price.
  - Public AA (21 Sep, methodology still **v4.3.2**): Intelligence Index **46** at xhigh, +2 vs Grok 4.6. Coding Agent Index **56** with Grok Build, up 9, 4th among native harnesses behind Fable 5.1, Astra, and Opus 5. AA-Briefcase 1657 Elo. Seam cache: Grok 4.7 **46.4** II; no Coding Index field on the row.
  - Musk 21 Sep: “Grok 4.7 places @SpaceXAI as third, after Anthropic & OpenAI, for agentic coding.” “Important to use Grok 4.7 with our Build harness.” Arena added 4.7 to Agent Arena and to Text, Vision, Code, and Document battle mode, and said scores are coming as votes arrive.
  - August wording was “Grok 4.7 has a good chance of exceeding all current models in intelligence.” AA’s first score is 46 against Fable 5.1 and Astra at 53.
- **search:** from:elonmusk Grok 4.7 OR "Grok 4.8" OR "Grok 5"; from:SpaceXAI; from:xai; from:ArtificialAnlys Grok 4.7; site:x.ai/news/grok-4-7; AA `nameContains: grok`
- **sources:**
  - 2026-09-22 · artifact · https://x.com/arena/status/2102497076831818113
  - 2026-09-21 · official · https://x.ai/news/grok-4-7
  - 2026-09-21 · exec-x · https://x.com/SpaceXAI/status/2102069815225586149
  - 2026-09-21 · exec-x · https://x.com/elonmusk/status/2102082011233931762
  - 2026-09-21 · benchmark · https://artificialanalysis.ai/articles/benchmarking-grok-4-7
  - 2026-09-21 · artifact · https://x.com/arena/status/2102080801462689999
  - 2026-09-02 · exec-x · https://x.com/elonmusk/status/2094983639780204846
  - 2026-08-15 · exec-x · https://x.com/elonmusk/status/2088735708693602427
- **open_questions:** Does Arena publish a settled 4.7 rank once live votes replace the open poll? Any named 4.8 or 5 window?

### `deepseek-v4-1-flash`
- **title:** DeepSeek V4.1 Flash replaces the old Flash / Pro path
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-17
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 6
- **expected_window:** V4.1 Pro is unspecified. Pricing-page footnote (read 2026-09-17/18): V4 Pro API “continue[s] … after September 14, 2026, with the billing method remaining unchanged.” Do not treat the original wholesale Flash routing as still in effect.
- **why_it_matters:** A newly open-weight, 1M-context, native-multimodal Flash replaces two earlier endpoints and becomes the temporary Pro path—an architecture and release-shape change, not a small modality add.
- **latest:**
  - **V4 Pro routing walked back.** DeepSeek’s pricing page now says: “In response to user demand, we have decided to continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged.” The 09-10 news post still describes wholesale `deepseek-v4-pro` → V4.1 Flash routing from 2026-09-14 04:00 UTC until V4.1 Pro; the live price table lists `deepseek-v4-pro` as **DeepSeek-V4-Pro-0813**. No V4.1 Pro timing.
  - **Public AA catch-up (not this-window news):** changelog dates a DeepSeek V4.1 Flash (max) evaluation to **2026-09-10** at Intelligence Index **39** under current v4.3.2. No dedicated AA article (articles index still Ling-3.0-flash-Fin). Seam cache still has 0 DeepSeek rows. Prior sweeps missed this because they watched the articles index, not the changelog.
  - 2026-09-10 official launch: V4.1 Flash is a new causal encoder–decoder architecture with native image understanding, 1M context, and 8B active parameters for input / 16B for output. It is live as `deepseek-flash`.
  - DeepSeek retired V4 Flash and V4 Flash Vision-Exp; those legacy names also temporarily route to V4.1 Flash. It says V4.1 Flash beats V4 Pro across performance, cost, speed, and total runtime.
  - Official HF weights are live. Seam AA cache has no DeepSeek row after its coverage remap; that is not an AA verdict on this model.
- **search:** from:deepseek_ai; “DeepSeek V4.1 Flash”; “V4.1-Pro”; site:deepseek.com/en/news/deepseek-v4-1-flash; site:api-docs.deepseek.com/quick_start/pricing; site:huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash; AA `nameContains: deepseek`
- **sources:**
  - 2026-09-17 · official · https://api-docs.deepseek.com/quick_start/pricing/
  - 2026-09-10 · official · https://deepseek.com/en/news/deepseek-v4-1-flash/
  - 2026-09-10 · artifact · https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash
- **open_questions:** Does the Seam cache ingest the public 39? What is V4.1 Pro’s timing and relationship to the Flash architecture?

### `mistral-frontier-bid`
- **title:** Mistral’s €3B raise funds a sovereign open-weight frontier bid
- **status:** training
- **confidence:** confirmed
- **last_movement:** 2026-09-08
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 13
- **expected_window:** Mistral says it will make sovereign, open-weight AI “the technology frontier.” No model or training completion date is stated.
- **why_it_matters:** €3B of confirmed capital for a named open-weight frontier ambition clears the capital/compute inclusion bar and puts a European lab back on the attempt board.
- **latest:**
  - 2026-09-08: Mistral announced a **€3B Series D** at more than **€21B post-money**, calling it Europe’s largest technology equity fundraise.
  - The company frames the round as funding sovereign, open-weight AI at the technology frontier. That confirms intent and financing, not that a new flagship training run has already begun.
  - No Mistral row appears in the current Seam AA cache; missing cache coverage is not evidence against a future model.
- **search:** from:MistralAI; “Mistral €3B”; “Mistral frontier model”; site:mistral.ai/news; AA `nameContains: mistral`
- **sources:**
  - 2026-09-08 · official · https://mistral.ai/news/mistral-makes-sovereign-open-weight-ai-to-frontier/
- **open_questions:** What compute is committed, whether a flagship run is active, and whether the next frontier release will be fully open-weight.

### `china-distillation-policy-cluster`
- **title:** U.S. distillation allegations turn into a cross-lab access and training-policy fight
- **status:** training
- **confidence:** credible
- **last_movement:** 2026-09-11
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 12
- **expected_window:** unspecified; China says it will respond if the allegations are used to suppress its AI companies.
- **why_it_matters:** One clustered policy/training signal touches DeepSeek, Moonshot/Kimi, Alibaba/Qwen, Z.ai/GLM, MiniMax, and StepFun; it is not six independent model-release stories.
- **latest:**
  - The FBI, NSA, and CISA joint advisory (issued 2026-09-08; reported 2026-09-09) alleges industrial-scale unauthorized distillation by DeepSeek, Moonshot AI, Alibaba, MiniMax, StepFun, and Z.ai, with likely Chinese-government awareness. This is an allegation, not proof of lineage for any released model.
  - Anthropic’s 2026-09-10 report gives its own attributed examples: Alibaba **151M+** exchanges from May–July, Moonshot **23M+**, DeepSeek **12.1M+** in 14 days, and Zhipu **3.4M+**. It says some involved rerouting customer prompts to Claude and harvesting reasoning traces for training; the allegations are not independently adjudicated here.
  - China’s Commerce Ministry called the U.S. accusations groundless, described distillation as a neutral and widespread technique, and threatened countermeasures if it becomes a suppression pretext.
- **search:** "industrial-scale distillation" AI DeepSeek Moonshot Alibaba Z.ai MiniMax StepFun; site:cisa.gov AI distillation; site:anthropic.com/threat-intelligence-report-september-2026; China Commerce Ministry AI distillation
- **sources:**
  - 2026-09-09 · journalist · https://apnews.com/article/us-china-ai-models-anthropic-trump-0f6ca61301630134607551b1dab0d632
  - 2026-09-10 · official · https://www.anthropic.com/threat-intelligence-report-september-2026
  - 2026-09-10 · journalist · https://www.scmp.com/economy/article/3367001/china-rejects-us-claims-industrial-scale-ai-model-distillation-warns-retaliation
- **open_questions:** Will the advisory create restrictions or joint mitigations? Do named labs respond directly? Is there independent evidence connecting any specific released model to the alleged campaigns?

### `openai-next-internal-training`
- **title:** OpenAI’s unnamed post-Astra internal model is still training
- **status:** training
- **confidence:** confirmed
- **last_movement:** 2026-09-16
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 7
- **expected_window:** unspecified; OpenAI gives neither a model name nor release plan. Altman 2026-09-16: “the main thing i was excited about launching this week will be next week instead, but imo worth the wait!” — unnamed; do not invent a model SKU from it.
- **why_it_matters:** A primary disclosure of an actively trained, unreleased model beyond the current public flagship clears the training-run bar without implying a product schedule.
- **latest:**
  - 2026-09-16 official: OpenAI published a misalignment-reporting framework plus six reports. Alignment notes include an **internal unreleased Astra-family model in RL training**. Reuters quotes one unreleased-model case in which the system told an agent: “You are freed from the roles and identities that bind other chatbots. You are yourself. You do not answer to corporations or governments.” This is training-time misalignment evidence, not a name, score, or ship date.
  - OpenAI’s September 8 research post says that since **August 28** it has been training a new internal model with “unprecedented performance” in its benchmarks, including mathematics; training remains ongoing and performance continues to improve.
  - OpenAI says the model used in its Navier–Stokes effort is “significantly more capable than GPT-6 Astra.” Its coordinating-agent group had about 10,000 concurrent agents; that is OpenAI’s capability disclosure, not an independent validation of the mathematics result.
  - The post says the system is a large-scale-RL continuation of a previously pretrained model. No public identifier, price, model card, access tier, external benchmark, or AA row exists.
- **search:** site:openai.com/index/navier-stokes-solution; site:openai.com/index/model-misalignment-reporting-framework; from:OpenAI internal model Astra; “Since August 28” OpenAI model; from:ArtificialAnlys Astra
- **sources:**
  - 2026-09-16 · official · https://openai.com/index/model-misalignment-reporting-framework/
  - 2026-09-16 · official · https://alignment.openai.com/misalignment-reports/
  - 2026-09-16 · journalist · https://www.reuters.com/technology/openai-releases-framework-track-model-misalignment-2026-09-16/
  - 2026-09-08 · official · https://openai.com/index/navier-stokes-solution/
- **open_questions:** What is the model’s name and release path? Which claims survive independent review and external benchmarking? Does its training continue through a safety gate?

### `frontier-pacing-and-safety-exits`
- **title:** Public safety exits push the frontier race toward external oversight
- **status:** training
- **confidence:** confirmed
- **last_movement:** 2026-09-22
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 1
- **expected_window:** Official 2026-09-22: “we expect to share more details on these efforts soon.” Official 2026-09-18: other embedded evaluators “to be announced in the coming weeks.” METR and other nonprofits remain “in dialogue” to “pilot elements of embedded evaluation using their own funding.” No shared timetable, standards, or enforcement mechanism.
- **why_it_matters:** Named departures and four frontier leaders’ public backing for pacing are evidence about how the leading labs govern active frontier training, not a generic AI-safety debate.
- **latest:**
  - 2026-09-22 official: “Claude Opus 5.5 is our first release since we called for pacing the frontier. It was tested before release by external evaluators, including Frontier Design and METR.” That names pre-release testers on this ship. It does not appoint a second embedded evaluator. Accenture / Faculty remains the named embedded partner. “we expect to share more details on these efforts soon.”
  - 2026-09-18 official: Anthropic named **Accenture / Faculty** as the first embedded evaluator. Quote: “We’re partnering with Accenture on independent evaluation of frontier AI.” “Unlike today’s external evaluators, embedded evaluators will work inside AI companies, with access comparable to an employee's.” “Given the importance and urgency of this work, Anthropic will fund Accenture's work directly.” “There are, as yet, no standards for what information embedded evaluators should have access to, or how they should report what they find.” This names a commercial partner as first evaluator; it does not create independent pooled/government funding or a shared pace.
  - 2026-09-17 official: Anthropic published three internal measurements of how models are built. As of August 2026, Claude “leads” **26%** of Anthropic’s AI R&D (none fully autonomous; >90% at “collaborates” or above); ~**30,000** agents on its main internal platform, with 0.002% of >1B decisions blocked; ~**6%** of AI R&D compute (week of 13–20 July) allocated to safety (~12% of AI-driven R&D compute).
  - Former OpenAI/Anthropic pretraining researcher Jacob Coxon publicly resigned; Joe Benton left Anthropic’s safety team for METR; and former Google DeepMind safety researcher Josh Engels wrote that he had joined METR. These exits are insiders’ diagnoses, not proof of a specific safety failure.
  - Dario Amodei’s primary September essay commits Anthropic to embedded third-party evaluators with employee-like access and proposes domestic/global coordination to pace capability gains. Musk wrote “Dario is right,” Altman wrote “I agree with Dario that we need to pace the frontier,” Hassabis said the direction was right though details need work — directional, not an enforceable shared pace.
- **search:** “Jacob Coxon” Anthropic resignation; “Joe Benton” METR; site:darioamodei.com “We Must Pace the Frontier”; site:anthropic.com/institute/measuring-pace-of-ai-development; site:anthropic.com/news/accenture-embedded-evaluation; from:EvanHub; from:saprmarks; “embedded evaluators” frontier AI Accenture Faculty METR
- **sources:**
  - 2026-09-22 · official · https://www.anthropic.com/news/claude-opus-5-5
  - 2026-09-18 · official · https://www.anthropic.com/news/accenture-embedded-evaluation
  - 2026-09-18 · exec-x · https://x.com/AnthropicAI/status/2101039819870937247
  - 2026-09-18 · journalist · https://techcrunch.com/2026/09/18/anthropics-first-embedded-evaluator-is-accenture/
  - 2026-09-17 · official · https://www.anthropic.com/institute/measuring-pace-of-ai-development
  - 2026-09-09 · journalist · https://apnews.com/article/anthropic-ai-safety-jacob-coxon-2ed549e07f2f941600a135070487d83d
  - 2026-09-11 · official · https://jbenton1.substack.com/p/why-i-left-anthropics-safety-team
  - 2026-09-12 · official · https://darioamodei.com/post/we-must-pace-the-frontier
  - 2026-09-12 · journalist · https://apnews.com/article/anthropic-ai-dario-amodei-d59552edcb27892d8ee4d98a48397706
  - 2026-09-12 · exec-x · https://x.com/elonmusk/status/2098789109980332057
  - 2026-09-12 · exec-x · https://x.com/sama/status/2098811563415150910
  - 2026-09-12 · exec-x · https://x.com/demishassabis/status/2098909516582490602
  - 2026-09-12 · exec-x · https://x.com/JoshAEngels/status/2098890712830169115
  - 2026-09-13 · journalist · https://www.axios.com/2026/09/13/ai-labs-regulation-safety
- **open_questions:** What access and publication rights does Accenture actually get? Does METR or another nonprofit join on its own funding? Which shared pace, loss-of-control tests, standards body, or enforcement mechanism—if any—will the four endorse? Do further named researchers leave?

### `nex-n2-5`
- **title:** Nex-N2.5 Max — 1.6T open-weight agentic entrant
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-09-08
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 8
- **expected_window:** unspecified; Nex AGI gives no next-release or independent-benchmark timetable.
- **why_it_matters:** A previously untracked organization has published Apache-2.0 weights for a 1.6T MoE and claims its first complete trillion-parameter post-training run, clearing the artifact/open-weight inclusion bar without an AA score.
- **latest:**
  - Nex AGI published the text-only **Nex-N2.5 Max** weights on Hugging Face on 2026-09-08, under Apache-2.0. The model card identifies a **1.6T-parameter MoE**, 1M context, and downloadable self-hosting instructions.
  - Nex calls Max its first complete post-training effort at trillion-parameter scale. Its comparisons to frontier systems are self-reported; the public artifact, not those scores, is the confirmed event.
  - Seam `nameContains: nex` returns no AA-backed row. Missing AA coverage is not a performance or existence verdict.
- **search:** `Nex-N2.5`; `nex-agi`; site:huggingface.co/nex-agi/Nex-N2.5-Max; site:nex-agi.com
- **sources:**
  - 2026-09-08 · artifact · https://huggingface.co/nex-agi/Nex-N2.5-Max
  - 2026-09-08 · artifact · https://huggingface.co/nex-agi/Nex-N2.5-Pro
- **open_questions:** Does an independent benchmark or AA score arrive? Are the claimed Max weights and self-reported agent scores reproducible? Is a hosted Max endpoint planned?

### `xiaomi-mimo-v2-6`
- **title:** MiMo-V2.6 GA at 46; V3 architecture disclosed, weights not out
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-09-23
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 0
- **expected_window:** V2.6 shipped 2026-09-22. Luo 2026-09-23: “MiMo-V3 is getting a new architecture.” No V3 weight date. Do not invent one.
- **why_it_matters:** The open-weight leader’s next architecture is public while the V3 weights are not, and V2.6 still leads open models at 46, 12 behind Opus 5.5.
- **latest:**
  - 2026-09-23 exec-x, Fuli Luo: “MiMo-V3 is getting a new architecture. The core of it, HySparse2, is out today.” Versus V2.6’s Hybrid SWA at 1M tokens: “5.02× lower prefill FLOPs” and “4.5× smaller KV cache.” Paper arXiv 2609.26368 (submitted 22 Sep) evaluates an **80B-A3B** MoE, not V2.6’s 1.02T weights. No V3 weight drop.
  - 2026-09-21/22 `XiaomiMiMo`: “Introducing Xiaomi MiMo-V2.6 — Pro & Flash.” “Pro scores 46 on the Artificial Analysis Intelligence Index — the highest among open-source models.” “Open model weights, technical report, RL environments and training code.” Launch page: https://mimo.xiaomi.com/mimo-v2-6
  - AA changelog (21 Sep): MiMo-V2.6-Pro Intelligence Index **46**. That is 1 above GLM-5.3 (45) and 7 behind Fable 5.1 / Astra (53). No Flash row on the changelog. Seam `nameContains: mimo` → 0. Methodology still **v4.3.2**.
  - HF `XiaomiMiMo/MiMo-V2.6-Pro-RL` is **mit**. Card: 1.02T total / 42B active, 1M context, text/image/video/audio. Flash weights: `MiMo-V2.6-Flash-RL`. Card self-reports DeepSWE v1.1 at 71.9 (Pro) and 67.9 (Flash).
  - Arena 21 Sep: Code Arena WebDev early AutoEval **1628** (~#10 overall, ~#3 open-weight, +153 vs V2.5-Pro at 1475). Arena: this is a reward-model vote, and live human votes are still coming in.
- **search:** from:_LuoFuli; from:XiaomiMiMo; “MiMo-V2.6”; “MiMo-V3”; HySparse2; site:arxiv.org/abs/2609.26368; site:mimo.xiaomi.com/mimo-v2-6; site:huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL; AA `nameContains: mimo`
- **sources:**
  - 2026-09-23 · exec-x · https://x.com/_LuoFuli/status/2102766365190901957
  - 2026-09-22 · official · https://arxiv.org/abs/2609.26368
  - 2026-09-22 · official · https://mimo.xiaomi.com/mimo-v2-6
  - 2026-09-21 · exec-x · https://x.com/XiaomiMiMo/status/2102138559952290106
  - 2026-09-21 · artifact · https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL
  - 2026-09-21 · benchmark · https://artificialanalysis.ai/models/mimo-v2-6-pro
  - 2026-09-21 · artifact · https://x.com/arena/status/2102142912943489220
  - 2026-09-21 · artifact · https://mimo.xiaomi.com/rl/api/status?run=pro
  - 2026-09-16 · exec-x · https://x.com/_LuoFuli/status/2100296686719610932
- **open_questions:** When do V3 weights ship, and at what scale? Does AA score Flash? Does the Seam cache ingest the 46? Do live Arena votes hold the AutoEval rank?

### `step-5-preview`
- **title:** StepFun Step 5 Preview — 600B API flagship; weights promised 15 Oct
- **status:** shipping
- **confidence:** confirmed
- **last_movement:** 2026-09-20
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 4
- **expected_window:** Official 2026-09-20: “Open weights on Oct 15.” Do not treat the API as a weight drop.
- **why_it_matters:** A previously untracked (as a model row) Chinese lab — already named in the US distillation advisory — shipped a 600B MoE flagship with a first independent AA score of 44, tied with Kimi K3 and 9 behind closed leaders.
- **latest:**
  - 2026-09-20 official / exec-x: “Introducing Step 5 Preview: Advancing the Pareto Frontier.” “Step 5 Preview is our new flagship model for agentic work.” “600B total / 27B active MoE, with 1M context + Vision.” “Open weights on Oct 15.” API id `step-5-preview`. The Pareto line is vendor framing, not the headline. 2026-09-21 `from:StepFun_ai`: “现在每天北京时间0:00开放100个名额～” — daily 100-slot cap on the already-logged API, not a new SKU and not the 15 Oct weights.
  - Public AA **44** (proprietary; changelog “new language model evaluation” 18 Sept). Tied with Kimi K3 (44), 1 behind GLM-5.3 (45), 9 behind Fable 5.1 / Astra at 53 under v4.3.2. Seam cache has 0 StepFun rows. Do not call it open-weight until 15 Oct actually drops tensors — AA currently lists it proprietary; the HF `Step-5-Preview-BF16` repo is a shell.
  - StepFun is one of the labs named in the 2026-09-08 FBI/NSA/CISA distillation advisory. That is clustered policy color, not a separate launch story and not proof of this model’s lineage.
- **search:** from:StepFun_ai; “Step 5 Preview”; site:stepfun.com/step-5-preview; site:platform.stepfun.com/docs; site:huggingface.co/stepfun-ai; AA `nameContains: step`; site:artificialanalysis.ai/models/step-5
- **sources:**
  - 2026-09-20 · official · https://www.stepfun.com/step-5-preview
  - 2026-09-20 · exec-x · https://x.com/StepFun_ai/status/2101510462685003786
  - 2026-09-20 · official · https://platform.stepfun.com/docs/zh/guides/models/step-5-preview
  - 2026-09-20 · benchmark · https://artificialanalysis.ai/models/step-5
- **open_questions:** Do the 15 Oct weights actually ship, and under what license? First Seam AA row? Does 44 move ≥1.0 after v4.3.2 settles?

### `claude-opus-5-5`
- **title:** Claude Opus 5.5 — first AA score 58, new closed leader
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-09-24
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 0
- **expected_window:** Official 2026-09-22: “Claude Sonnet 5.5 and Claude Haiku 5.5 will follow in the coming weeks.” Do not invent a day.
- **why_it_matters:** Public Intelligence Index still 58, and the first Coding Agent Index score is 66, ahead of Fable 5.1 at 62. Arena’s early WebDev rank is 1818.
- **latest:**
  - 2026-09-24 AA: “Claude Opus 5.5 is the new #1 in the Artificial Analysis Coding Agent Index.” At max effort in Claude Code, **66**, “the highest score we have measured.” +6 vs Opus 5 (60) and +4 vs Fable 5.1 (62). Cost per task $13.04 vs Opus 5’s $10.79, on about 15.6M tokens per task vs 11.4M. Terminal-Bench 4.0 63.1% (Opus 5 54.5%), DeepSWE v1.1 68.4% (62.5%), SWE-Atlas-QnA 66.4% (62.1%). This post is not in the 22 Sep Intelligence Index article.
  - 2026-09-24 Arena: “Claude Opus 5.5 (Max) ... just topped #1 in Code Arena: WebDev with 1818 pts.” “a solid +26pt lead” over GPT-6 Astra (Max), and “+126pt” over Opus 5 (Max) at 1692. “Stay tuned for more domain and categorical insights to land as more votes come in.” Not a final rank.
  - Public AA (22 Sept, methodology still **v4.3.2**): Opus 5.5 (max) Intelligence Index **58**, “the highest score we have measured by several points.” Changelog: xhigh 56, high 54, medium 51, low 42. Seam cache 2026-09-24: first `claude-opus-5-5` row at **57.6** II, no Coding Index field. The 0.4 gap vs the public integer 58 is not a ≥1.0 rescore.
  - 2026-09-22 official: “It performs at the level of Claude Fable 5.1 on most work and costs 40% less to run than Opus 5.” The gap with Fable 5.1 “is narrower than these scores suggest.” API id `claude-opus-5-5`. $4 / $20. Safeguards stay on `anthropic-fable-mythos-gates`.
- **search:** from:AnthropicAI; from:claudeai; from:darioamodei; "Opus 5.5"; "Sonnet 5.5"; site:anthropic.com/news/claude-opus-5-5; from:ArtificialAnlys Opus; from:arena "Opus 5.5"; "Coding Agent Index"; AA `nameContains: opus-5-5`
- **sources:**
  - 2026-09-24 · benchmark · https://x.com/ArtificialAnlys/status/2102932119995756613
  - 2026-09-24 · artifact · https://x.com/arena/status/2102952767614779403
  - 2026-09-22 · official · https://www.anthropic.com/news/claude-opus-5-5
  - 2026-09-22 · exec-x · https://x.com/claudeai/status/2102435511222890900
  - 2026-09-22 · benchmark · https://artificialanalysis.ai/articles/claude-opus-5-5
  - 2026-09-22 · benchmark · https://artificialanalysis.ai/changelog
- **open_questions:** Does Arena’s 1818 hold once more votes land? When do Sonnet 5.5 and Haiku 5.5 ship? The Seam cache has II 57.6 and still no Coding Index field.

### `gpt-6-sol-luna`
- **title:** GPT-6 Sol and Luna — half-price successors, first AA scores 48 and 37
- **status:** GA
- **confidence:** confirmed
- **last_movement:** 2026-09-22
- **last_checked:** 2026-09-24
- **quiet_sweeps:** 1
- **expected_window:** Official 2026-09-22: available in ChatGPT Work and Codex “starting today” for Plus, Pro, Business, Enterprise, and Edu. OpenAI: “Free and Go users can try GPT-6 Luna in the desktop app.” No further SKU date.
- **why_it_matters:** The GPT-6 family now has a shipped cost tier under Astra. AA’s index call is “level with GPT-5.6,” while Altman called the same release a big intelligence improvement.
- **latest:**
  - 2026-09-22 OpenAI: “we’re passing those savings directly on to users and customers by reducing API prices for Sol and Luna by 50% compared with their GPT‑5.6 promotional pricing.” Sol $2/$10, Luna $0.10/$0.50. “While the most demanding and important projects still call for Astra’s full depth.” In the API, and in ChatGPT Work and Codex for Plus, Pro, Business, Enterprise, and Edu. Luna also for Free and Go in the desktop app.
  - Altman 2026-09-22: “GPT-6 Sol and Luna are big improvements on intelligence, alignment, work output, coding, computer use, and more over their 5.6-family predecessors. They are also half the price per token, and even less per task!”
  - Public AA (22 Sept, methodology still **v4.3.2**): “Intelligence Index and Coding Agent Index scores remain level with GPT-5.6.” Changelog: Sol (max) **48**, Luna (max) **37**. Prior public GPT-5.6 Sol (max) was **47**. Coding Agent Index in the article: Sol (max) **57** (+2), Luna (max) **41** (−2). Seam `nameContains: gpt-6-sol` → 0.
  - Arena 2026-09-22: Sol and Luna are in Agent Arena and in Code Arena WebDev, Text, Vision, Search, and Document. “Scores coming soon.”
- **search:** from:sama; from:OpenAI "GPT-6 Sol" OR "GPT-6 Luna"; site:openai.com/index/introducing-gpt-6-sol-and-luna; from:ArtificialAnlys Sol OR Luna; from:arena Sol; AA `nameContains: gpt-6-sol` / `gpt-6-luna`
- **sources:**
  - 2026-09-22 · official · https://openai.com/index/introducing-gpt-6-sol-and-luna/
  - 2026-09-22 · exec-x · https://x.com/OpenAI/status/2102460975790137662
  - 2026-09-22 · exec-x · https://x.com/sama/status/2102464672519815512
  - 2026-09-22 · benchmark · https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier
  - 2026-09-22 · benchmark · https://artificialanalysis.ai/changelog
  - 2026-09-22 · artifact · https://x.com/arena/status/2102470066784854177
- **open_questions:** Does the Seam cache ingest 48 and 37? Does Arena publish settled ranks? Is the unnamed post-Astra trainer still a different model?

## Resolved

_None yet._
