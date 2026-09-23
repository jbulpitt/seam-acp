# LLM Industry Watch

- **last_sweep:** 2026-09-23
- **one_line:** Opus 5.5 leads the public Intelligence Index at 58; GPT-6 Sol and Luna shipped at half the 5.6 price; open-weight lead MiMo-V2.6 stays at 46, so the closed gap is 12.

## Frontier snapshot

Public methodology is still **v4.3.2**. Seam AA source snapshot **126 → 138** (generation 689 → 782). No ≥1.0 rescore of a model already in yesterday’s selected set.

Selected cache, unique SKUs: Fable 5.1 **53.4 / 81.6 Coding**, Astra **52.7 / 76.9**, Opus 5 **50.8 / 78**, Fable 5 **49.6 / 76.5**, GPT-5.6 Sol **47.0 / 77.4**, Grok 4.7 **46.4**, Grok 4.6 **44.2 / 75.9**, Terra **42.1 / 76.7**. Those match yesterday.

Public changelog integers, 22 Sept, not in the Seam cache: Opus 5.5 (max) **58** (xhigh 56, high 54, medium 51, low 42), GPT-6 Sol (max) **48**, GPT-6 Luna (max) **37**, MiMo-V2.6-Pro **46**, GLM-5.3 **45**, Kimi K3 **44**, Step 5 Preview **44**. Open-weight gap is **12** (MiMo 46 vs Opus 5.5 58). Yesterday it was 7 against the 53 tie. `nameContains` for `opus-5-5`, `gpt-6-sol`, and `mimo` returned 0.

## Live storylines

### Claude Opus 5.5 — GA, confirmed

First AA score **58**. Anthropic: “It performs at the level of Claude Fable 5.1 on most work and costs 40% less to run than Opus 5.” $4/$20. “Claude Sonnet 5.5 and Claude Haiku 5.5 will follow in the coming weeks.” Seam cache: no row.

### GPT-6 Sol and Luna — GA, confirmed

Altman: “half the price per token, and even less per task.” AA’s article says Intelligence Index scores “remain level with GPT-5.6”; the changelog lists Sol (max) **48** and Luna (max) **37**. Prior public GPT-5.6 Sol (max) was 47. In Work and Codex for paid plans; Luna also on Free/Go desktop. Arena: scores coming soon.

### Grok 4.7 — GA, confirmed

AA **46**. Arena, 22 Sep: Code Arena WebDev **#10 at 1632** (+16 vs 4.6 High at 1616, #16). No quoted 4.8 window. Twelve points behind Opus 5.5.

### Xiaomi MiMo-V2.6 — GA, confirmed

MIT weights and AA **46** still stand. A 9B Qwen distill is a research SFT, not a new flagship score. No Flash row on the AA changelog.

### StepFun Step 5 Preview — shipping, confirmed

API and public AA **44** still stand. Quoted weight drop remains 15 Oct.

### Anthropic Mythos / LSVP — shipping, confirmed

Opus 5.5 ships with Fable-class cyber and biology safeguards. LSVP is open for its biology use. Official: Cyber Verification expansion “in the coming weeks,” with tiers “including access to Claude Mythos models.” The 17 Sep high-risk limit is not stated as lifted.

### Anthropic pacing — training, confirmed

Opus 5.5 is “our first release since we called for pacing the frontier,” pre-tested by Frontier Design and METR. Accenture / Faculty is still the only named embedded evaluator. “we expect to share more details on these efforts soon.”

### Other live rows, no new signal

Astra Plus/Business completion unstated. Gemini still has no Pro artifact. DeepSeek still has no V4.1 Pro timing. Mistral still has no flagship-run proof. The distillation cluster has no new restriction. OpenAI’s unnamed internal model is still unnamed. Nex still has no AA row.

## New this sweep

- **Claude Opus 5.5** — first AA score 58 and an official GA post.
- **GPT-6 Sol and Luna** — official half-price ship plus first changelog scores 48 and 37.

## Calendar / expected

- Sonnet 5.5 and Haiku 5.5: official “in the coming weeks.”
- Cyber Verification expansion, including Mythos tiers: official “in the coming weeks.”
- Further pacing details: official “soon.”
- Step 5 Preview weights: official “Open weights on Oct 15.”
- V4.1 Pro, Astra Plus completion, Gemini Pro, a next Grok SKU, K4, non-preview Hy4, Mistral’s flagship run, and OpenAI’s unnamed internal model: unspecified.

## Quiet

- **gpt-6-astra:** Sol/Luna is a different SKU. No Plus/Business completion for Astra.
- **google-gemini-flagship-gap:** no Pro artifact. Hassabis, DeepMind, Pichai, and Dean silent.
- **deepseek-v4-1-flash:** no V4.1 Pro timing.
- **mistral-frontier-bid:** no flagship-run proof.
- **china-distillation-policy-cluster:** no new restriction or direct lab response. Opus 5.5 adds the existing preserved-thinking control.
- **openai-next-internal-training:** Sol/Luna does not name the internal trainer.
- **nex-n2-5:** no AA row.
- **step-5-preview:** no 15 Oct weights.
- **Stale after 14 quiet sweeps:** Muse Spark, Kimi K3, GLM-5.3, Hy4 preview, Qwen3.8 Max. Kimi’s Bedrock listing and browser extension, Qwen-Audio-3.1, and Hy Image 3.5 are product surfaces, not new text flagships.
