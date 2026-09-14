# Embedding `GLM-5.2_8xB200.html` in Confluence

## Files
- `GLM-5.2_8xB200.html` — standalone report (open in a browser to preview). **Source of truth; edit this.**
- `GLM-5.2_8xB200.confluence.html` — the paste-ready extract (host `<div>` + `<script>` only). Regenerate after editing the source (see below).

## Platform
Confluence **Data Center** (self-hosted, `:8090`). The built-in inline **HTML** macro is enabled here.

## Paste steps
1. Edit the page → **`+`** (Insert) → **Other macros** → search **HTML** → pick **"HTML"** (not "HTML Include").
   - Shortcut: type `{html` in the editor body.
2. Click into the macro body and paste the **entire** contents of `GLM-5.2_8xB200.confluence.html`.
3. Save the macro → **Publish** the page.

## Why Shadow DOM
Pasting the plain `<style>`+markup did **not** work: the macro ran the `<script>` but our `<style>` never took effect, so Confluence's own CSS took over — huge full-width charts, navy headings, black dots, no lines/gridlines (the `var(--…)` colors never resolved).

Fix: the report builds itself inside a **Shadow DOM** at runtime.
- CSS is injected by JS into a shadow root → the macro can't strip it and Confluence's styles can't leak in.
- All chart colors are resolved to concrete **hex** (no `var()` inside SVG attributes).
- Result renders identically to the standalone file.

So the macro body is just `<div id="glmviz-host"></div>` + one `<script>`; everything else is generated.

## Regenerating the extract after editing the source
```bash
python3 - <<'EOF'
s=open('GLM-5.2_8xB200.html').read()
a=s.index('<div id="glmviz-host">'); b=s.index('</script>')+len('</script>')
open('GLM-5.2_8xB200.confluence.html','w').write(s[a:b]+"\n")
EOF
```
Then re-paste into the same macro (replacing the old body) and publish.

## `ccbb stats` reports
`ccbb stats` emits the same shape natively — no extraction script needed:

```bash
ccbb stats --confluence=ccbb-stats.confluence.html   # paste-ready macro body (host <div> + <script>)
ccbb stats -o ccbb-stats.html                        # standalone page (open in a browser)
```

No input file is needed — with no arguments the skeletons are built from the discoverable
sessions. Pass `*.json` to read saved `ccbb skel` output instead. `--confluence` changes
what the single output file holds; it never writes a second file.

The report builds itself in a Shadow DOM for the reasons above (`reportBlock()` in
`ccbb-stats.js` is the single source for both files, so they can't drift). Paste the
extract with the same steps as §"Paste steps". Its tooltip is a second shadow root on
`<body>` so `position:fixed` stays viewport-anchored even inside a transformed
Confluence container.

**Size.** Confluence rejects the publish if the macro body is large, so the chart data is
pre-aggregated at build time (bins, hour means, a sampled scatter) instead of shipping one
row per response — the page is ~50 KB for a small run and ~110 KB for 60k responses. The
scatter sample dominates what growth is left: `--points 500` (or `--points 0` for every
response, standalone only) moves it. Sizes are printed after `--confluence`.

## Notes
- Fully self-contained: inline CSS/JS/data, no external requests — works behind the firewall.
- Theme-aware (light/dark via `prefers-color-scheme`); responsive to `max-width:1120px`.
- Interactive: hover tooltips/crosshair + "Log y-axis" and "Show data tables" toggles.
- If a future Confluence upgrade sanitizes inline `<script>` in the HTML macro, the charts won't draw — fall back to static PNGs + the wiki-markup tables (`x.tables.txt`).
