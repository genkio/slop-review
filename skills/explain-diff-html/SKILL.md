---
name: explain-diff-html
description: "Create a rich, self-contained interactive HTML explanation of a current branch, remote branch, or GitHub PR diff without requiring checkout, with browser-rendered Mermaid diagrams and optional English plus user-requested languages. Use when the user wants to understand the background, intuition, implementation, data flow, state transitions, architecture, or quiz-based reinforcement for a code change, with the result saved as a dated HTML file outside the repository."
---

# explain-diff-html

Produce a single long-form HTML page that teaches a reader how a branch or PR's
changes work. Investigate the surrounding system before explaining the diff:
the page should make sense to a beginner while still giving an experienced
engineer a concise path to the changed behavior.

## Inputs (optional)

The skill runs with no arguments: it defaults to the current feature branch's
diff against its base (see Scope). Anything the user passes retargets or
enriches that:

- **PR URL or number** (e.g. `https://github.com/<owner>/<repo>/pull/<n>` or
  `#<n>`): pull the PR body, linked issues, and review threads for the intent
  the code alone can't show. An explicit PR is the target even when the current
  checkout is `main`/`master`; inspect it without switching branches by following
  [references/remote-targets.md](references/remote-targets.md). The diff stays
  the source of truth; fold description and discussion into Background and
  Intuition, never into the code walkthrough verbatim.
- **Remote branch/ref** (e.g. `origin/feature-x`): fetch and inspect its Git
  object tree without switching the current checkout. Follow
  [references/remote-targets.md](references/remote-targets.md).
- **Base branch override**: diff against a branch other than the detected base.
- **Focus paths/files**: narrow the walkthrough to specific files while still
  reading their surroundings for context.
- **Additional language(s)**: keep English as the source explanation and add
  each language the user requests. Follow the multilingual writing and UI rules
  below; never assume a particular second language.

## Target resolution and precedence

Resolve the target before inspecting code:

1. An explicit PR URL/number is authoritative.
2. Otherwise, an explicit remote branch/ref is authoritative.
3. Otherwise, use the current checked-out feature branch.

For an explicit PR or remote ref, do not stop because the current checkout is
the base branch or has an empty diff. Do not include unrelated local staged or
unstaged changes. Fetch commits into Git's object database and read target
content with `git show`, `git grep`, and `git diff`; never run `gh pr checkout`,
`git checkout`, or `git switch`. See
[references/remote-targets.md](references/remote-targets.md) for the complete
workflow and fallbacks.

### Current branch default

When no explicit target was supplied, use the current feature branch's diff
against the branch it forked from:

```bash
BASE=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@')
BASE=${BASE:-origin/main}          # fall back to origin/main if HEAD isn't set
BRANCH=$(git branch --show-current)

git diff "$BASE"...HEAD            # changes on this branch since it diverged from base
git log --oneline "$BASE"..HEAD    # the commits that make up the branch
git diff --stat "$BASE"...HEAD     # touched files at a glance
```

The three-dot `"$BASE"...HEAD` shows only what this branch introduced, ignoring
commits added to base after the fork. Also fold in uncommitted work (`git diff`
and `git diff --staged`) when it is part of the change under explanation.

Only in this no-explicit-target mode: if the branch is `main`/`master`/`BASE`
itself, or the diff is empty, say so and ask which change to explain rather than
guessing.

## Workflow

1. Resolve the target using the precedence above, then establish its diff and
   scope, enriched by any optional inputs (PR body, base override, focus paths).
   State any assumption you had to make about intent directly in the page.
2. Explore relevant surrounding code, tests, configuration, callers, data
   models, and documentation. Trace the old and new paths far enough to explain
   behavior, not merely file-by-file edits. Prefer checked-in examples and
   tests over speculation.
3. Build a narrative before writing HTML:
   - what problem or constraint motivated the change;
   - how the old system behaved;
   - the smallest useful mental model of the new behavior;
   - how the implementation realizes that model;
   - edge cases, trade-offs, and observable consequences.
4. Read [references/content-format.md](references/content-format.md). Write a
   content fragment and page-data JSON, using Mermaid only where the reference's
   decision rules say a diagram materially improves understanding. Build the
   page with `scripts/build_explanation.py`; do not recreate the template,
   language controls, quiz engine, or renderer in each output.
5. Validate the artifact before handing it off: confirm it exists, is a
   complete HTML document, contains no external asset dependencies, has working
   quiz interactions, and satisfies the code-block and quiz checks below. If
   practical, open it in a browser at desktop and phone widths to catch layout,
   overflow, language-control, or JavaScript errors.
6. After validation succeeds, print the absolute output path and open that exact
   file with the operating system's default browser. Do this automatically; do
   not wait for a separate user request.

## Template workflow

Use the bundled assets as the stable presentation/runtime layer:

- `assets/explanation-template.html`: editorial one-page CSS, language controls,
  quiz behavior, and in-browser diagram runtime;
- `assets/grok-mermaid.wasm`: Apache-2.0 Mermaid-to-Unicode renderer embedded by
  the builder so the final page remains one offline file;
- `scripts/build_explanation.py`: validates and combines the content fragment,
  page-data JSON, template, and renderer;
- `references/content-format.md`: input schema, semantic classes, diagram
  placeholders, and Mermaid selection guidance;
- `references/remote-targets.md`: no-checkout PR and remote-ref resolution,
  target-tree inspection, and fallback guidance.

Create temporary inputs outside the repository and retain the absolute output
path for validation and handoff:

```bash
OUTPUT=/tmp/YYYY-MM-DD-explanation-branch-slug.html
python3 /path/to/explain-diff-html/scripts/build_explanation.py \
  --content /tmp/explanation-content.html \
  --data /tmp/explanation-data.json \
  --output "$OUTPUT"
```

Keep the template unchanged during ordinary use. Change it only when improving
the skill itself. The generated page must not depend on external fonts, CDNs,
images, packages, or network access; ordinary source links are fine.

## Multilingual output

Default to English only. When the user requests one or more additional
languages:

- Write for a technically fluent native reader of each target language. Adapt
  sentence structure, emphasis, and examples so the prose feels authored in
  that language; do not translate word by word.
- Keep code identifiers and project-specific or established technical terms in
  English when translating them would be awkward or less precise. Explain an
  unfamiliar term in the target language on first use when useful.
- Translate the complete learning experience: summary, section prose, diagram
  labels or captions where practical, callouts, table headings, quiz questions,
  options, and feedback. Never translate code samples or identifiers.
- Present corresponding language blocks close together—side by side on wide
  screens and stacked on narrow screens—so readers can compare them without
  losing their place. Prefer coherent paragraph-level adaptation over alternating
  every sentence.
- Add a compact language display control with three choices when there is one
  target language: `English + <target>`, `English`, and `<target>`. For multiple
  target languages, offer `All` plus one choice per language. Implement this as
  a reading-mode control, not top-level page tabs; every mode must preserve the
  same continuous section order and work fully offline.
- Give the control an accessible group label, visible focus states, accurate
  `aria-pressed` state, and a usable stacked layout on phones.

## Required page structure

Include a clear title, a short summary, and a table of contents linking to
these sections in this order:

1. **Background**: Explain only the system needed for the change. Start with an
   optional beginner-friendly mental model, then narrow to the exact
   components, contracts, and prior behavior involved.
2. **Intuition**: Explain the core idea before implementation detail. Use small
   concrete toy inputs and outputs. Show the old and new behavior when
   comparison makes the change clearer.
3. **Code**: Walk through the changes in conceptual groups, ordered by
   execution or dependency flow rather than arbitrary file order. Include
   precise file and line references when available, but do not dump the whole
   diff.
4. **Quiz**: Include exactly five medium-difficulty, interactive
   multiple-choice questions. Clicking an option must immediately show whether
   it is correct and explain why, including the relevant behavior or code path.

Use smooth transitions, plain language, and precise systems-oriented prose.
Explain jargon on first use. Use callouts for definitions, invariants,
important edge cases, and practical consequences. Keep the page readable on
phones with responsive CSS. Do not use top-level tabs; make it one continuous
page.

## Visual direction

Aim for a polished editorial one-page explainer rather than generic generated
documentation. Adapt the visual identity to the subject, while keeping these
defaults:

- Use a strong conceptual title, short explanatory deck, and compact metadata
  for branch, base, head, and diff scope.
- Use system fonts, a restrained high-contrast palette, one or two accent
  colors, generous whitespace, soft borders, and a small reusable vocabulary of
  cards, tags, callouts, tables, and flow nodes.
- Make the table of contents visually scannable and keep the language control
  compact or sticky when useful. These controls support the page; they must not
  turn it into a tabbed application.
- Prefer information density and hierarchy over ornament. Every visual element
  should clarify scope, sequence, state, causality, or a decision.
- Let wide layouts use paired columns, but collapse cleanly on phones. Long file
  references and table cells must wrap; code and intentionally wide diagrams
  may scroll inside their own containers without causing page-level horizontal
  overflow.

## Diagrams and examples

Decide first what relationship the reader needs to see. Use Mermaid for
multi-actor sequences, branching control/data flow, state transitions,
type/entity relationships, or boundaries that are cumbersome to reconstruct
from prose. Use the selection guide in
[references/content-format.md](references/content-format.md); skip a diagram
when a sentence, two-step list, before/after panel, or compact table is clearer.

Prefer one to three high-signal diagrams rather than diagramming every section.
The bundled renderer supports flowcharts (including subgraphs), sequence, state,
class, and ER syntax. Keep source concise, use real domain terms and toy values,
and derive every node and edge from inspected code or tests. Never hand-write
ASCII art; write Mermaid source and let the embedded renderer produce the
styled Unicode diagram in the browser.

Place each diagram beside the prose that introduces its mental model. Provide
an accessible summary and a caption that explains the inference the reader
should draw. The template exposes the Mermaid source in a collapsed disclosure
and falls back to a source listing if WebAssembly is unavailable.

## Quiz quality rules

Treat quiz design as part of the explanation, not decoration. Before emitting
the page, inspect all five questions as a set.

- Randomize the option order independently for each question. Do not always
  place the correct answer first, second, or in any fixed position. A
  deterministic shuffle with a per-page seed is acceptable; the visible order
  must vary across questions.
- Balance correct-answer positions across the five questions as evenly as
  possible. Never let position, letter, punctuation, or a repeated pattern
  reveal the answer.
- Keep options comparable in length, grammar, specificity, and confidence. Do
  not make the correct option conspicuously longer, more qualified, or more
  technically precise than distractors. Shorten or enrich distractors as
  needed.
- Make every distractor plausible and tied to a real misunderstanding of the
  change. Avoid joke answers, obviously impossible claims, "all of the above" /
  "none of the above" options, and trivia that cannot be inferred from the
  page.
- Ask about behavior, causality, contracts, edge cases, or trade-offs. Avoid
  questions whose answer can be guessed from a single copied phrase.
- Keep the correct answer and explanation in the page's JavaScript data or DOM
  so the interaction works offline. Reveal feedback only after selection. Mark
  the selected option and explain both the right reasoning and, when useful, the
  misconception behind the distractors.
- Ensure the UI does not expose the answer through styling before selection,
  DOM labels, `title` attributes, source ordering, or accessibility text.
  Accessibility labels should describe the option, not its correctness.

## HTML and code-block constraints

- Escape user/code-derived text for HTML and JavaScript contexts. Preserve
  meaningful whitespace in code examples.
- Use `<pre><code>...</code></pre>` for code blocks. The CSS for `pre` must
  explicitly include `white-space: pre` or `white-space: pre-wrap`; verify
  every code block in the saved source before delivery.
- Keep content free of inline behavior. Let the bundled template own the small,
  namespaced, dependency-free JavaScript for language controls, diagrams, and
  repeated quiz cards.
- Include visible focus states and sufficient color contrast. Do not make
  correctness depend on color alone.
- Avoid claiming behavior that the inspected source does not support.
  Distinguish observed facts from reasonable interpretation.

## Browser validation

When browser tooling is available, validate the saved local page rather than
assuming source inspection is sufficient:

- load it at a desktop viewport and a representative phone viewport;
- confirm the required sections appear in order and exactly five quiz cards are
  rendered;
- confirm every Mermaid placeholder renders styled diagram output, exposes its
  source disclosure, and has no renderer-error fallback under normal conditions;
- answer the quiz programmatically and confirm immediate correct/incorrect
  feedback works;
- exercise every language display mode and verify its pressed/visible state;
- check for console errors, external resource requests, and page-level
  horizontal overflow;
- visually inspect at least one desktop and one phone screenshot.

Fix problems found during this pass before delivery. If browser tooling is not
available, run equivalent static checks and state that limitation in the handoff.

## Automatic open and path output

After all validation and fixes, print the absolute path in the command output,
then open the file with the platform's default browser:

```bash
printf 'Explanation HTML: %s\n' "$OUTPUT"
open "$OUTPUT"         # macOS
```

Use `xdg-open "$OUTPUT"` on Linux or the equivalent default-file opener on
Windows. This final open is separate from any Playwright/WebKit validation
session: it is the reader-facing result in the user's normal browser. If the
environment is headless or the opener fails, keep the successfully generated
artifact, print its path, and report the open limitation instead of treating
the explanation itself as failed.

## Final handoff

Return the exact absolute path to the generated HTML file as a clickable
local-file link. Briefly state which target commit/ref and base were compared,
what was inspected, whether the working tree was left untouched, and any
assumptions, validation limitations, and whether the automatic browser open
succeeded. The path must appear both in command output and in the final response.
Do not place the deliverable inside the code repository unless the user
explicitly requests it.
