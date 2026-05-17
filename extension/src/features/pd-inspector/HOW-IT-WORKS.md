# PD Inspector — how it works

The PD Inspector answers one question: *for this published verifi/expertly
page, which Page Designer components are on it, and which one owns a given
piece of the UI?*

It does this in **two parts**, and they have very different reliability:

| Part | What it tells you | Reliability |
|---|---|---|
| **Component tree** | Which PD components the page embeds, and how they nest | **Exact** |
| **Inspect mode** | Which component owns the element you hover over | **Best-effort** (hence the confidence score) |

The rest of this doc explains why one is exact and the other is not.

---

## Part 1 — The component tree (exact)

A published page renders from a **compiled Page Designer config** — a JSON
tree of layout nodes. The deployable API serves it:

```
GET /rest/api/public/pagedesigner/deployable/pages?pageType=ALL&domain=…&path=…
   → { deployedPages: [ { compiledConfig, referencePageId, … } ] }
```

`compiledConfig.layout` is a tree of nodes. Most nodes are plain layout
(`exp-layout`, `exp-field`, …). Some nodes are **symbol references** — the
place where the page embeds a reusable PD component:

```
isSymbolRef(node)  ===  node.isSymbol && node.name && node has no children
```

A symbol reference is just a *name* and a placeholder — its actual content
lives in a separate compiled config. So the engine:

1. Reads the page config (`config.js → fetchPageConfig`).
2. Collects every symbol reference name (`collectSymbolNames`).
3. Fetches each component's config, and recurses into *its* symbol
   references (`fetchComponentGraph`).
4. Assembles the nesting tree (`componentTree.js → buildComponentTree`).

This is **100% exact** because it never looks at the rendered page. It is
pure config arithmetic — the config literally lists which components are
embedded and where. Nothing is inferred.

```
PAGE  ncdot-notice-and-storage/LT-260/paperFormdetails
├── COMP  n_s_staff_lt260_vehicle_detailsPaperForm
├── COMP  n_s_staff_lt260_vehicle_details_1_PaperForm
└── COMP  n_s_staff_edit_DMV_check
```

That tree is always right. The hard part is the *next* question.

---

## Part 2 — Inspect mode (best-effort)

Inspect mode is "hover over the page, get told which component that UI
belongs to." This is where the confidence score comes from.

### The core problem: the runtime leaves no marker

When the expertly/verifi runtime renders the page, it expands every
component **inline**. A component's content is dropped straight into the
DOM with **no wrapper, no `id`, no `data-*` attribute, no comment** marking
where it begins or ends.

The rendered page is a flat sea of generic custom elements:

```html
<exp-layout>
  <exp-layout>
    <exp-form-builder> … VIN field, Make field … </exp-form-builder>
  </exp-layout>
  <exp-layout>
    <exp-form-builder> … DMV check fields … </exp-form-builder>
  </exp-layout>
</exp-layout>
```

Nothing in that DOM says *"this `<exp-form-builder>` came from component
`n_s_staff_edit_DMV_check`."* The component boundary simply does not exist
in the rendered output. We confirmed this with live probing: no id, no
attribute, no scoped style, no Angular instance data (production builds are
minified) ties a rendered subtree back to its PD component.

So you cannot look at an element and *read off* its component. It has to be
**inferred**.

### The workaround: anchors + document order

Two element types are special: `exp-form-builder` and `exp-data-table`.
The runtime renders them **1:1 with their config node** and **in document
order**. They are the only stable landmarks — we call them **anchors**.

The trick (`correlate.js`):

1. **Expected sequence** — walk the *expanded* config (page + every
   embedded component, recursively) in document order. Every form-builder
   / data-table you pass becomes an expected anchor, tagged with the
   **component chain** that produced it — e.g.
   `[page, n_s_staff_edit_DMV_check]`.

2. **Actual sequence** — `document.querySelectorAll('exp-form-builder')`
   etc. gives the anchors actually on the page, in document order.

3. **Zip them** — the *i*-th DOM anchor corresponds to the *i*-th expected
   anchor, so it inherits that anchor's component chain.

When you hover, the engine climbs from the hovered element to the nearest
anchor, finds its index, and looks up the chain. The innermost name in the
chain is the owning component.

This works **only if the expected sequence and the DOM sequence line up
1:1**. Often they do not — and that is the whole reason for the confidence
score.

---

## Why it can't always be certain

### Reason 1 — conditional visibility

A config node can gate its own rendering on a runtime expression:

```
props["[isVisible]"]   // e.g.  visible if  vehicle.state == 'NC'
```

A conditionally-hidden node **is in the config but not in the DOM**. So the
DOM anchor sequence is a *subsequence* of the expected one — shorter, with
gaps.

Naive zipping then misaligns everything after the gap:

```
expected:  [ A , B , C , D ]      B is conditionally hidden
DOM:       [ A , C , D ]

naive zip:  A→A   C→B ✗   D→C ✗   (everything after the gap is wrong)
```

The aligner compensates by **dropping conditionally-gated anchors first**
to make the counts match. If the shortfall is fully explained by
conditional anchors, the result is probably right — but see Reason 2.

### Reason 2 — *which* conditional dropped is a guess

The config tells us a node *can* be hidden. It does **not** tell us whether
it *is* hidden right now — that depends on live data the inspector cannot
evaluate.

```
expected:  [ A , B(cond) , C(cond) , D ]      one of B/C is hidden
DOM:       [ A , ? , D ]                       (3 anchors)

shortfall = 1, and there are 2 conditional anchors.
The aligner drops the FIRST conditional → guesses  [A, C, D].
But reality might be  [A, B, D].
```

Both are consistent with what we can observe. We cannot distinguish them
without running the page's visibility logic. So the mapping *might* be off
by one component — and the inspector says so rather than lying.

### Reason 3 — loops and repeaters

A `exp-data-table`, or a region bound to a list, renders **once per row**.
The config predicts **one** node; the DOM shows **five**. Now the DOM has
*more* anchors than expected, and there is no clean way to align by count
at all.

```
expected:  [ table ]            (config: one data-table node)
DOM:       [ t , t , t , t , t ]  (five — one per row)
```

### Reason 4 — components with no anchor at all

A component built only from buttons, text, and layout — no form-builder,
no data-table — produces **zero anchors**. It is completely invisible to
the correlation, even though the component tree (Part 1) still lists it.
Hovering over its UI finds the nearest anchor belonging to *some other*
component.

---

## The confidence score

`createCorrelator` aligns the expected and DOM anchor sequences and reports
one honest label:

| Confidence | Meaning | Trust |
|---|---|---|
| **exact** | expected count == DOM count. Clean 1:1 zip, nothing dropped. | Reliable. |
| **approx** | There is a shortfall, but it is *fully explained* by conditional anchors. The dropped set is a reasonable guess. | Usually right; may be off by one when several conditionals compete (Reason 2). |
| **low** | The shortfall is **not** explained by conditionals, or the DOM has *more* anchors than predicted (Reason 3). The mapping is a guess. | Treat as a hint, not an answer. |

The panel surfaces it directly, e.g.:

```
Inspect map   low — page has hidden regions the map cannot place (1/3 anchors)
```

`1/3` means: 3 anchors expected from the config, only 1 found in the DOM.

The score is **not** a defect — it is the inspector being honest about how
much inference went into a given mapping, because the runtime gives it no
ground truth to check against.

---

## Worked examples

### Example A — exact

Page embeds 3 components, each with exactly one form-builder, none
conditional.

```
expected:  [ page , vehicleForm , dmvCheck ]    (3, 0 conditional)
DOM:       [ fb#0 , fb#1 , fb#2 ]               (3)

drop = 0  → zip 1:1 → confidence = exact
```

Hover a field in the 2nd form-builder → chain `[page, vehicleForm]` →
**owning component: `vehicleForm`**. Trustworthy.

### Example B — approx

Same page, but `dmvCheck` is wrapped in `[isVisible]` and the page is in a
state where it is hidden.

```
expected:  [ page , vehicleForm , dmvCheck(cond) ]   (3, 1 conditional)
DOM:       [ fb#0 , fb#1 ]                            (2)

drop = 1, and there is exactly 1 conditional anchor.
→ drop dmvCheck → kept [page, vehicleForm] zip to DOM → confidence = approx
```

Hover the 2nd form-builder → `vehicleForm`. Correct here. Labeled `approx`
because the moment two conditionals compete, the drop choice becomes a
guess (Reason 2).

### Example C — low (the LT-260 list page)

A list page whose body is a data-table plus two conditionally-rendered
detail regions that are not currently shown.

```
expected:  [ page , detailA(cond) , detailB(cond) ]   (3)
DOM:       [ fb#0 ]                                    (1)

drop = 2.  Conditionals can explain at most some of it, the alignment
of the remainder is unverifiable → confidence = low (1/3 anchors).
```

Inspect mode still works, but its component labels should be read as
"probably" — the component tree above it remains exact regardless.

---

## Summary

- The **component tree** is exact — it is computed from config alone, and
  config explicitly records which components a page embeds.
- **Inspect mode** is inference. The runtime erases component boundaries
  from the DOM, so identification leans on `exp-form-builder` /
  `exp-data-table` anchors and document order.
- Conditionals, loops, and anchor-less components break the 1:1 mapping,
  and the config cannot say which case applies at runtime.
- The **confidence score** (`exact` / `approx` / `low`) is the inspector
  reporting honestly how much of the mapping was inference versus fact.

To make inspect mode *exact*, the runtime would need to stamp a component
marker on the DOM (an `id` or `data-pd-component` attribute on each
component root). Until it does, `approx` / `low` are the truthful answer,
not a bug.
