# Template content format

Use the bundled builder instead of recreating page CSS, language controls,
quiz JavaScript, or the Mermaid renderer for each explanation.

## Build command

Create two temporary inputs, then run:

```bash
python3 /path/to/explain-diff-html/scripts/build_explanation.py \
  --content /tmp/explanation-content.html \
  --data /tmp/explanation-data.json \
  --output /tmp/YYYY-MM-DD-explanation-branch.html
```

The builder embeds the content, JSON, and bundled WASM renderer into one HTML
file. It rejects mismatched diagram IDs, external content assets, and quizzes
that do not contain exactly five valid questions.

## Content fragment

Write an HTML fragment, not a complete document. Use the template's semantic
classes and keep the required sections in order:

```html
<header class="hero shell">
  <span class="eyebrow">PR #123 · FEATURE-42</span>
  <h1>A conceptual title</h1>
  <p class="hero-sub" data-language="en">English summary.</p>
  <p class="hero-sub" data-language="ja">日本語の要約。</p>
  <div class="meta-row">
    <span class="meta"><strong>Branch</strong> feature-42</span>
    <span class="meta"><strong>Base</strong> origin/main</span>
  </div>
</header>

<div id="language-controls" data-label="Reading mode · 表示言語"></div>

<nav class="toc shell" aria-label="Table of contents">
  <!-- links to background, intuition, code, quiz -->
</nav>

<main class="shell">
  <section id="background">...</section>
  <section id="intuition">...</section>
  <section id="code">...</section>
  <section id="quiz">
    <div id="quiz-list" class="quiz-list" aria-live="polite"></div>
  </section>
</main>
```

Mark language-specific blocks with `data-language="<id>"`. Use `.bilingual`
for paired wide-screen columns and `.lang-card` / `.lang-label` for their
contents. The runtime hides or shows these blocks from `languageModes`.

Useful supplied classes include `.callout`, `.warning`, `.danger`, `.cards`,
`.card`, `.before-after`, `.panel`, `.data-table`, `.tag`, `.code-step`,
`.step-num`, `.file-ref`, `.tests`, and `.scope-note`. Use only the patterns
the explanation needs.

## Mermaid placeholder

Put each diagram at the point where it resolves a reader's question:

```html
<figure class="diagram-card">
  <h3 class="diagram-heading">Who owns a redelivered upload?</h3>
  <div class="mermaid-render" data-diagram-id="claim-flow"></div>
  <figcaption>
    <span data-language="en">A fresh owner keeps working; a stale owner is recovered.</span>
    <span data-language="ja">owner が fresh なら継続し、stale なら recovery に入る。</span>
  </figcaption>
</figure>
```

Every `data-diagram-id` must have exactly one matching object in `diagrams`.
The runtime renders it as styled Unicode box art, shows the source in a
collapsed disclosure, rerenders to fit wide layouts, scrolls inside the card
on narrow screens, and falls back to a source listing if WebAssembly is
unavailable.

## Page data JSON

```json
{
  "title": "One upload, one owner",
  "description": "Atomic upload claims explained",
  "languageModes": [
    {"id": "both", "label": "EN + 日本語", "show": ["en", "ja"]},
    {"id": "en", "label": "English", "show": ["en"]},
    {"id": "ja", "label": "日本語", "show": ["ja"]}
  ],
  "diagrams": [
    {
      "id": "claim-flow",
      "ariaLabel": "Flowchart of atomic upload ownership and recovery",
      "sourceLabel": "Mermaid source",
      "source": "flowchart TD\n  Message --> Claim{Claim won?}\n  Claim -->|yes| Run[Process upload]\n  Claim -->|no| Alive{Owner alive?}\n  Alive -->|yes| Keep[Keep redelivery]\n  Alive -->|no| Recover[Settle stuck files]"
    }
  ],
  "quiz": [
    {
      "question": "Question text in the requested language presentation",
      "correct": "stable-id",
      "order": ["latest", "stable-id", "timeout", "file"],
      "options": {
        "stable-id": "Correct but not conspicuously longer option",
        "latest": "Plausible misconception of similar length",
        "timeout": "Plausible misconception of similar length",
        "file": "Plausible misconception of similar length"
      },
      "explanation": "Why the selected model follows the real code path."
    }
  ]
}
```

Supply exactly five quiz entries. Independently vary `order` and balance the
correct option's visible position across the set.

For English-only output, use an empty `languageModes` array and omit
`data-language` unless it helps structure the content. The language-control
host may remain in the fragment; the runtime hides it.

## Choosing a Mermaid diagram

Use Mermaid when it makes a relationship materially easier to understand than
the surrounding prose or an existing compact table. Prefer one to three
high-signal diagrams in a long explanation.

Choose the diagram from the reader's question:

- `sequenceDiagram`: Which actor calls whom, in what order, especially across
  retries, queues, callbacks, or shutdown.
- `stateDiagram-v2`: Which transitions are legal, terminal, recoverable, or
  timeout-driven.
- `flowchart`: Where control or data branches and why a path is selected.
- `classDiagram`: How changed types, interfaces, or ownership boundaries fit.
- `erDiagram`: How changed persisted entities relate and which key scopes an
  operation.
- Flowchart subgraphs: Which runtime, service, transaction, or trust boundary
  owns each step.

Skip Mermaid for a single fact, a linear two-step change, a file list, or a
diagram that merely repeats nearby prose. Keep nodes and edge labels concise,
use real domain terms and toy values, and derive every edge from inspected
source or tests. Put nuance, evidence, and multilingual adaptation in the
caption and prose rather than crowding the diagram.

The bundled renderer supports flowcharts/subgraphs, sequence, state, class,
and ER diagrams. Other Mermaid types render as a framed source fallback, so do
not use them for a required explanatory visual.
