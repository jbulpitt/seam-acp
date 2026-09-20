# LLM Industry Watch

- **last_sweep:** 2026-09-20
- **one_line:** StepFun opened Step 5 Preview (600B/27B MoE, API today, weights promised 15 Oct) at public AA 44; Anthropic’s Accenture evaluator and Xiaomi’s ended-Flash / live-Pro run are unchanged; DeepSeek’s V4 Pro path stays live.

## Frontier snapshot

Seam’s AA-backed catalog advanced from source snapshot **98** to **106**. Public methodology **v4.3.1 → v4.3.2** (19 Sep: AA-Briefcase v1.1, GDPval-AA v2.1). Selected cache scores drifted **−0.1 to −0.4** — record the methodology change; this is not a ≥1.0 ranking event.

Returned leaders: Astra **52.7 / 76.9 Coding**, Sol 47.0, Grok 4.6 44.2, Kimi K3 43.6, Terra 42.1, Gemini 3.8 Flash **40.9 / 76.3 Coding**. Gemini 3.5 Flash (high) is **32.6 II / 70.1 Coding** after another sub-1.0 tick on the September 14 −6.7 cache movement.

Public AA integer scores: Fable 5.1 **53** vs Astra **53**. GLM-5.3 (max) **45**. Kimi K3 **44**. **Step 5 Preview 44** (proprietary). DeepSeek V4.1 Flash (max) **39** — changelog dates that evaluation to **10 Sep** (articles-index miss, not a today first score). Cache still lacks Fable / Opus / GLM / DeepSeek / Muse / MiMo / Step as selected rows; `claude-fable-5` remains **unresolved-effort**.

Best returned open-weight remains Kimi K3 **43.6**, ~9 points behind cache-leader Astra. Public v4.3 still has GLM-5.3 (~45) and Kimi K3 (44) leading open weights; Step 5 is scored but not open-weight yet.

## Live storylines

### StepFun Step 5 Preview — shipping, confirmed

Official 20 Sep: “Introducing Step 5 Preview: Advancing the Pareto Frontier.” “Step 5 Preview is our new flagship model for agentic work.” “600B total / 27B active MoE, with 1M context + Vision.” “Open weights on Oct 15.” API id `step-5-preview`. Public AA **44**, tied with Kimi K3, 9 behind Fable/Astra 53. AA lists it **proprietary**; the HF repo is a shell until 15 Oct. StepFun is already named in the US distillation advisory — policy color, not lineage.

### Anthropic pacing / Accenture evaluator — training, confirmed

No further evaluator named. Official 18 Sep still stands: Accenture/Faculty first embedded evaluator; Anthropic funds the work directly; METR remains “in dialogue”; other evaluators “in the coming weeks.” August measurements unchanged (Claude “leads” 26% of Anthropic AI R&D; ~30,000 agents; ~6% of R&D compute to safety).

### Anthropic Mythos LSVP — shipping, confirmed

Applications remain open. High-risk Mythos still US-government limited. Not a general trusted-access opening.

### Xiaomi MiMo-V2.6 — training, confirmed

Dashboard API 20 Sep: **Flash ended** at step 30 (**$854k**; DeepSWE v1.1 **65.68**). **Pro still live** at step 29 (**$2.48M**; DeepSWE **72.57** at step 26). Same run, not a ship. Luo: details “over the coming weeks.”

### DeepSeek V4 Pro routing — shipping, confirmed

Pricing page still lists `deepseek-v4-pro` as **DeepSeek-V4-Pro-0813** at Pro rates. Public AA has had V4.1 Flash (max) at **39** since a 10 Sep evaluation; no dedicated article; cache still uncovered. V4.1 Pro still unspecified.

### OpenAI unnamed post-Astra trainer — training, confirmed

The August 28 RL continuation is still unnamed. Altman’s “next week instead” remains unnamed. Astra for Law is a legal configuration of GPT-6 Astra, not a new SKU and not Plus/Business completion.

### Google Flash cadence / missing Pro — delayed, credible

No 3.5/3.8/4 Pro artifact. DeepMind model cards still stop at 3.8 Flash (2 Sep) plus 3.8 Live audio (15 Sep). Unsourced “Gemini 4 Pro” leak tables are not a primary.

### Arena / access color

No new Arena post this window. Code Arena WebDev last ranked Astra Max #1 (1800) over Fable 5.1 Max (1758); head-to-head, users still prefer Fable. Mythos is LSVP-gated for life science.

### Open and non-U.S. frontier lines

Kimi, GLM, Hy4, Qwen Max, Mistral, Nex, and DeepSeek V4.1 still have no Seam-cache row. Hy4 remains preview-only. Grok 4.7 remains without an xAI launch artifact. Nex-N2.5 Max weights (8 Sep) are still unbenchmarked on AA.

## New this sweep

- **StepFun / Step 5 Preview.** Official API + first public AA 44. Clears the first-score / frontier-scale bar. Not open-weight until the quoted 15 Oct drop.

XingChen-AGI Xing4.0-29B-A4B (China Telecom; 29B/4B; HF trending) did not clear the inclusion bar. Reuters’ unnamed “Anthropic considers a new model ahead of IPO” remains unsourced “reports suggest” — out.

## Calendar / expected

- Step 5 Preview weights: official “Open weights on Oct 15.”
- V4.1 Pro: unspecified; V4 Pro service continues after September 14.
- Anthropic: individual Pro/Max LSVP “over time”; high-risk Mythos still US-government limited; additional evaluators “in the coming weeks”; METR still a dialogue, not an appointment.
- Luo: MiMo-V2.6 details “over the coming weeks.” Flash has ended; no GA date.
- Altman: an unnamed launch “will be next week instead.” Not a model identifier.
- OpenAI’s unnamed internal model, Astra Plus completion, Gemini Pro, Mistral’s next flagship, K4, non-preview Hy4, Nex’s next release, and the next Qwen Max snapshot: unspecified.

## Quiet

- **gpt-6-astra:** Plus/Business still unfinished; no new official access slice.
- **google-gemini-flagship-gap:** no Pro artifact; unsourced Gemini 4 Pro tables ignored.
- **anthropic-fable-mythos-gates:** LSVP unchanged; Accenture is the pacing row.
- **meta-muse-spark:** Wang posts are Muse ads / product color, not a 1.3 follow-up or cache row.
- **kimi-k3:** no K4 artifact.
- **glm-5-3:** no successor SKU or AA restoration.
- **tencent-hy4:** still preview-only; no AA row.
- **qwen-3-8-max:** LiveTranslate remains audio, not Max CI separation or AA.
- **grok-next:** no 4.7 release artifact (Musk “Grok @Bot” is not a SKU).
- **mistral-frontier-bid:** no flagship-run proof.
- **china-distillation-policy-cluster:** no direct lab response or new restriction this window.
- **openai-next-internal-training:** no identifier or window beyond Altman’s unnamed “next week.”
- **nex-n2-5:** no AA row or independent benchmark.
- **frontier-pacing-and-safety-exits:** no second evaluator named.
- **xiaomi-mimo-v2-6:** Pro continuing is the same run; Flash halt already logged yesterday.
