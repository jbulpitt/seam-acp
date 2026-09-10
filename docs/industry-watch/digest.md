# LLM Industry Watch

- **last_sweep:** 2026-09-10
- **one_line:** DeepSeek just shipped MIT-licensed V4.1 Flash; Astra’s Plus/Business rollout is real but surface-gated; Anthropic now has a public safety rupture; and AA v4.3 resets the scoreboard rather than moving it point-for-point.

## Frontier snapshot

**AA v4.3 is a methodology reset, not a score move.** Artificial Analysis replaced Terminal-Bench 2.1 with v4 and replaced `τ³-Banking` with AutomationBench-AA on 2026-09-07. Its current public leaderboard has **Fable 5.1 and GPT-6 Astra tied at 53**, then Opus 5 (51), Fable 5 (50), Muse Spark 1.3 (48), and GPT-5.6 Sol (47). Do not compare these numbers directly with the Sep 6 v4.2/cache snapshot.

Seam AA cache refreshed at **2026-09-10T08:31:10.136Z** (generation 10). It now has the first matched rows for **GPT-6 Astra 52.8 / 76.9 coding** and **Gemini 3.8 Flash 41.2 / 76.3**. The surviving matched rows all rebased (Sol 51.3 → 47.1; Kimi K3 50.2 → 43.8; Grok 4.6 49.3 → 44.3), so none is an individual mover. Cache-covered Kimi trails Astra by 9.0; this is not an open-weight shock.

Coverage is incomplete: current Fable/Opus catalog entries report **`unresolved-effort`** against AA snapshot 8, and GLM, Qwen, Hy4, Muse, and DeepSeek have no matched cache row. That is a parser/matching or catalog-coverage diagnostic—not a leaderboard drop. **DeepSeek V4.1 Flash has no AA row yet.**

## Live storylines

### GPT-6 Astra — shipping, confirmed

Plus now has Astra in Work/Codex; GPT-6 Pro in Chat remains Pro/Business/Enterprise only. AA v4.3 ties Astra with Fable 5.1; the Seam cache has its first Astra row. The initial broad-rollout gate is over, but product-surface and allowance gates remain.

### Google Gemini flagship gap — delayed, credible

Gemini 3.8 Flash finally appears in the Seam cache, but Google’s current model-card list still has **3.1 Pro** as its latest Pro. New Flash evidence is not a Pro release.

### Anthropic Fable/Mythos gates — shipping, confirmed

Fable and trusted-access Mythos remain the same-model/two-gate design. The new signal is organizational: pretraining researcher Jacob Coxon quit, saying the labs are “racing straight to self-improving superintelligence and gambling with our lives”; alignment lead Evan Hubinger publicly echoed the core concern. Anthropic’s response says it favors a lawful, verifiable way to pace powerful releases. This is a safety-race fracture, not a new Mythos access tier.

### DeepSeek V4.1 Flash — GA, confirmed

New **552B-backbone**, multimodal MoE with a 1M context and MIT weights. DeepSeek says it activates 8B parameters during prefill / 16B during decode, exposes native multimodal API access, and will route retired V4 Flash names to it; V4 Pro routes to Flash after Sep 14 until V4.1 Pro. Vendor benchmarks need independent confirmation, but the public weights and API make this a real open-weight frontier event.

### Muse / Kimi / GLM / Hy4 / Qwen

No new model movement. Meta’s new Muse personal agent is a product rollout powered by existing Muse Spark, not a new Spark model. GLM 5.3 Flash, Hy4 preview, and Qwen 0902 remain artifact/Arena stories; Kimi has no K4 signal.

### Grok 4.7 — rumored, confirmed timing claim

Retrospective correction: Musk’s Sep 2 post explicitly said **“Grok 4.7 comes out in 10 days.”** That implies roughly Sep 12, but xAI has not published a model card, API identifier, price, or rollout plan. No post-Sep-6 ship signal.

## New this sweep

**DeepSeek V4.1 Flash** clears the bar on a primary artifact: official API release plus public MIT weights. It is now a live storyline; its first independent AA/Arena signal is open.

## Calendar / expected

- **Grok 4.7:** Musk Sep 2: “comes out in 10 days” (roughly Sep 12 by arithmetic; not a separately published launch date).
- **DeepSeek V4 Pro:** API requests route to V4.1 Flash after 12:00 Beijing Time on Sep 14, until V4.1 Pro ships.
- **Mythos biology enrollment:** “soon”; EFS “later this fall.”
- **Gemini Pro:** unspecified.

## Quiet

- Muse Spark — product rollout only; no 1.3 successor or AA cache match.
- Kimi K3 — no K4 training/release signal.
- GLM-5.3 / Hy4 / Qwen 0902 — no named successor or fresh independent separation.
