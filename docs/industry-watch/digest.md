# LLM Industry Watch

- **last_sweep:** 2026-09-19
- **one_line:** Anthropic named Accenture as its first embedded evaluator while keeping high-risk Mythos under a US-government gate; Xiaomi stopped the public MiMo-V2.6 Flash RL run and left Pro mid-flight; DeepSeek’s V4 Pro path stays live after the Flash-routing walk-back.

## Frontier snapshot

Seam’s AA-backed catalog advanced from source snapshot **90** to **98**. The selected leader set is unchanged—Astra **52.8 / 76.9 Coding**, Sol 47.1, Grok 4.6 44.3, Kimi K3 43.8, Terra 42.3, and Gemini 3.8 Flash **41.2 / 76.3 Coding**. Gemini 3.5 Flash (high) remains **33.0 II / 70.1 Coding** after the September 14 −6.7 cache movement. No ≥1.0 cache mover this sweep.

Public AA is still Intelligence Index **v4.3**; methodology **v4.3.1** (Opus 5 / Sol / Gemini 3.8 Flash pairwise judges). Newest public article remains Ling-3.0-flash-Fin (23). Live public scores: Fable 5.1 **53.4** vs Astra **52.8** (sub-1.0). Cache still lacks Fable / Opus / GLM / DeepSeek / Muse / MiMo as selected rows; `claude-fable-5` is **unresolved-effort** (matching diagnostic).

Best returned open-weight remains Kimi K3 **43.8**, 9 points behind cache-leader Astra. Public v4.3 still has GLM-5.3 (~45) and Kimi K3 (44) leading open weights.

## Live storylines

### Anthropic pacing / Accenture evaluator — training, confirmed

Official 18 Sep: “We’re partnering with Accenture on independent evaluation of frontier AI.” Faculty (Accenture’s AI unit) will evaluate, red-team, and test safeguards with “access comparable to an employee's.” Official: “Anthropic will fund Accenture's work directly.” “There are, as yet, no standards for what information embedded evaluators should have access to, or how they should report what they find.” METR and other nonprofits remain “in dialogue”; other evaluators “to be announced in the coming weeks.” This names the first evaluator; it does not appoint a shared pace or an independent funding source.

August snapshot measurements still stand: Claude “leads” **26%** of Anthropic AI R&D (none fully autonomous); ~**30,000** agents; ~**6%** of R&D compute to safety.

### Anthropic Mythos LSVP — shipping, confirmed

Applications remain open for the Life Sciences Verification Program. Standard Use grants give vetted teams **Mythos 5.1**, Opus 5, and Sonnet 5 with biology-permissive classifiers. High-risk Mythos: “We are working with the US government to make high-risk grants more broadly available for Claude Mythos, but at the time of this launch they will remain limited to a small set of entities with additional vetting.” Not a general trusted-access opening.

### Xiaomi MiMo-V2.6 — training, confirmed

Public dashboard 19 Sep: **Flash stopped** at step 30 (**$854k**; DeepSWE v1.1 **64.90**). **Pro still in progress** at step 23 (**$1.86M**; DeepSWE **67.46**). SemiAnalysis readout of the same livestream: Pro **1T / 42B active**, Flash **310B / 15B active**. Luo: details “over the coming weeks.” Same run, not a ship.

### DeepSeek V4 Pro routing — shipping, confirmed

Pricing page still lists `deepseek-v4-pro` as **DeepSeek-V4-Pro-0813** at Pro rates after walking back wholesale routing to V4.1 Flash. V4.1 Pro still unspecified; no first AA score.

### OpenAI unnamed post-Astra trainer — training, confirmed

The August 28 RL continuation is still unnamed. Misalignment reports (16 Sep) quote an unreleased Astra-family model in RL. Altman’s “next week instead” remains unnamed. Astra for Law (17 Sep) is a legal configuration of GPT-6 Astra for selected firms, not a new SKU and not Plus/Business completion.

### Google Flash cadence / missing Pro — delayed, credible

No 3.5/3.8/4 Pro artifact. DeepMind model cards still stop at 3.8 Flash (2 Sep). Unsourced “Gemini 4 Pro” leak tables on X/36Kr are not a primary.

### Arena / access color

Code Arena WebDev still ranks Astra Max **#1 (1800)** over Fable 5.1 Max (1758); head-to-head, users still prefer Fable. No new Arena post this window. Mythos is LSVP-gated for life science, not generally trusted-access.

### Open and non-U.S. frontier lines

Kimi, GLM, Hy4, Qwen Max, Mistral, Nex, and DeepSeek V4.1 still have no qualifying independent AA score or new flagship-training proof. Qwen3.8-LiveTranslate (19 Sep) is interpretation, not a text-frontier Max follow-up. Grok 4.7 remains without an xAI launch artifact. Nex-N2.5 Max weights (8 Sep) are still unbenchmarked on AA.

## New this sweep

None. Accenture and the MiMo Flash stop are movements on existing rows. Shanghai AI Lab’s Atria Dawn Preview (GLM-5.2-based 744B agentic overlay, MIT, self-reported benches) did not clear the inclusion bar.

## Calendar / expected

- V4.1 Pro: unspecified; V4 Pro service continues after September 14.
- Anthropic: individual Pro/Max LSVP “over time”; high-risk Mythos still US-government limited; additional evaluators “in the coming weeks”; METR still a dialogue, not an appointment.
- Luo: MiMo-V2.6 details “over the coming weeks.” Flash has stopped; no GA date.
- Altman: an unnamed launch “will be next week instead.” Not a model identifier.
- OpenAI’s unnamed internal model, Astra Plus completion, Gemini Pro, Mistral’s next flagship, K4, non-preview Hy4, Nex’s next release, and the next Qwen Max snapshot: unspecified.

## Quiet

- **gpt-6-astra:** Plus/Business still unfinished; Youth Safety Blueprint is not an access slice.
- **google-gemini-flagship-gap:** no Pro artifact; unsourced Gemini 4 Pro tables ignored.
- **anthropic-fable-mythos-gates:** LSVP unchanged; Accenture is the pacing row.
- **meta-muse-spark:** Muse product tweets, not a 1.3 follow-up or cache row.
- **kimi-k3:** no K4 artifact.
- **glm-5-3:** no successor SKU or AA restoration.
- **tencent-hy4:** still preview-only; no AA row.
- **qwen-3-8-max:** LiveTranslate is audio, not Max CI separation or AA.
- **grok-next:** no 4.7 release artifact (Voice Transcribe 2.0 is STT).
- **mistral-frontier-bid:** no flagship-run proof; Mozilla browsing is not a model event.
- **china-distillation-policy-cluster:** no direct lab response or new restriction this window.
- **openai-next-internal-training:** no identifier or window beyond Altman’s unnamed “next week.”
- **nex-n2-5:** no AA row or independent benchmark.
