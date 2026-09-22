# LLM Industry Watch

- **last_sweep:** 2026-09-22
- **one_line:** Xiaomi open-sourced MiMo-V2.6 (AA 46, MIT) and SpaceXAI shipped Grok 4.7 (AA 46); closed leaders stay Fable 5.1 / Astra at 53.

## Frontier snapshot

Public methodology is still **v4.3.2**. Seam AA source snapshot **114 → 126** (generation 581 → 689). No ≥1.0 rescore of a model that was already selected yesterday.

Selected cache, unique SKUs: Fable 5.1 **53.4 / 81.6 Coding** (back in the returned set; public integer still 53), Astra **52.7 / 76.9**, Opus 5 **50.8 / 78**, Fable 5 **49.6 / 76.5**, Sol **47.0 / 77.4**, **Grok 4.7 46.4** (new; no Coding Index on the row), Grok 4.6 44.2 / 75.9, Terra 42.1 / 76.7. Astra, Sol, Grok 4.6, and Terra are unchanged. Fable / Opus / Fable 5 returning is coverage; the decimals sit within 0.4 of the public integers already on the board.

Public AA integers: Fable 5.1 **53**, Astra **53**, **MiMo-V2.6-Pro 46** (new), **Grok 4.7 46** (new), GLM-5.3 **45**, Kimi K3 **44**, Step 5 Preview **44** (proprietary), DeepSeek V4.1 Flash **39**. Open-weight gap is **7** (MiMo 46 vs closed 53). Yesterday it was 8 (GLM 45). Seam cache has Grok 4.7 and still has no MiMo row.

## Live storylines

### Xiaomi MiMo-V2.6 — GA, confirmed

Xiaomi shipped Pro and Flash. MIT weights are on Hugging Face. AA changelog scores Pro **46**, 1 above GLM-5.3. Xiaomi: “the highest among open-source models.” Code Arena WebDev early AutoEval **1628** (~#10); Arena says live votes are still coming in. No Flash score on the AA changelog. Seam cache: 0 MiMo rows.

### Grok 4.7 — GA, confirmed

SpaceXAI, 21 Sep: “It's a notable improvement over Grok 4.6 at the same price and speed.” AA **46** at xhigh, +2 vs 4.6. With Grok Build, Coding Agent Index **56**, 4th among native harnesses behind Fable 5.1, Astra, and Opus 5. $2/$6, 500k context. Arena has it in Agent Arena; scores not posted. August “exceed all current models” sits against a 46 vs 53.

### StepFun Step 5 Preview — shipping, confirmed

API and public AA **44** still stand. Quoted weight drop remains 15 Oct. Today’s parameter restatement is the same 600B / 27B SKU.

### Anthropic pacing / Accenture evaluator — training, confirmed

No second evaluator. Accenture/Faculty remains the named embedded evaluator; other evaluators “in the coming weeks.”

### Anthropic Mythos LSVP — shipping, confirmed

No gate change. High-risk Mythos still US-government limited.

### DeepSeek V4 Pro routing — shipping, confirmed

No V4.1 Pro timing. Public AA still has V4.1 Flash at **39**.

### OpenAI unnamed post-Astra trainer — training, confirmed

Still unnamed. OpenAI’s new post is an independent mathematics advisory group, not a model id or access slice.

### Google Flash cadence / missing Pro — delayed, credible

No Pro artifact. Dean’s note is a thank-you for a Discovery Loop conversation. Pichai’s post is a laptop, not a model.

### Arena / access color

Grok 4.7 is in Agent Arena with scores still open. MiMo-V2.6-Pro’s WebDev number is an early AutoEval, not a settled human leaderboard.

### Open and non-U.S. frontier lines

Kimi, GLM, Hy4, Qwen Max, Mistral, Nex, DeepSeek, and Step 5 still have no Seam-cache row. Hy4 remains preview-only. Kimi’s new browser extension is a product surface, not a K4.

## New this sweep

None. Both movers were already live rows.

## Calendar / expected

- Step 5 Preview weights: official “Open weights on Oct 15.”
- V4.1 Pro: unspecified.
- Anthropic: individual Pro/Max LSVP “over time”; high-risk Mythos still US-government limited; additional evaluators “in the coming weeks.”
- Grok 4.7 and MiMo-V2.6: shipped. No quoted next-SKU window.
- OpenAI’s unnamed internal model, Astra Plus completion, Gemini Pro, Mistral’s next flagship, K4, non-preview Hy4, Nex’s next release, and the next Qwen Max snapshot: unspecified.

## Quiet

- **gpt-6-astra:** no Plus/Business completion or new access slice.
- **google-gemini-flagship-gap:** no Pro artifact.
- **anthropic-fable-mythos-gates:** LSVP unchanged.
- **meta-muse-spark:** Wang’s post is the Muse ideas tab, not a new SKU.
- **kimi-k3:** browser extension only; no K4.
- **glm-5-3:** no successor.
- **tencent-hy4:** still preview-only.
- **qwen-3-8-max:** no new Max snapshot. Qwen3.8 Max (0902) at 45 has been on the AA changelog since 15 Sep.
- **deepseek-v4-1-flash:** no V4.1 Pro timing.
- **mistral-frontier-bid:** no flagship-run proof.
- **china-distillation-policy-cluster:** no new restriction or direct lab response.
- **openai-next-internal-training:** math advisory group; no identifier.
- **frontier-pacing-and-safety-exits:** no second evaluator.
- **nex-n2-5:** no AA row.
- **step-5-preview:** no 15 Oct weights.
