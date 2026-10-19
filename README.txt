TERM-LLM — BEFORE / AFTER SCREENSHOTS

Before: upstream/main at 2b1d44f986fcfdae7936c9479c158b8822e8dc5f
After: complete codex/chat-appearance working tree (staged + unstaged + new theme sources).
Date: 2026-10-19

Open gallery.html to browse the comparisons; click a screenshot for its full-size original.
comparisons/ contains eight labeled PNG pairs, ready to upload to a PR.
images/ contains the sixteen full viewport originals plus detail captures.

Default light/dark colors are unchanged. The three palette showcases explicitly select optional themes.
Available options: Default (system light/dark), Sage Light, Sage Dark, Catppuccin Mocha, Dracula, Nord, Tokyo Night.

1. Desktop composer
Clearer attachment spacing and controls aligned with the last line of a multiline draft. Default light colors are unchanged.

2. Mobile composer
Consistent control alignment and more room below the composer. Default light colors are unchanged.

3. Native Settings controls
Select fields gain consistent inset arrows while retaining native keyboard behavior.

4. Theme picker in Extensions
A built-in Theme field is now available in Extensions. Default follows the device’s original light/dark appearance.

5. Readable review action
The Send comments action now has readable text in default dark mode.

6. Optional Catppuccin Mocha
An opt-in palette for chat, composer, and code. The after view has Catppuccin Mocha selected.

7. Optional Sage Light
A softer opt-in light palette. The after view has Sage Light selected.

8. Theme picker on mobile
The same picker applies immediately on mobile. The after view has Tokyo Night selected.

Capture notes:
- Actual production frontend snapshots; no application source edits for the screenshots.
- Deterministic mock API/sample content, identical per pair; no personal conversations or credentials.
- Desktop viewport: 1440x960. Mobile: 390x844 with touch emulation in Chrome.
- Detail comparisons focus on the changed controls; originals preserve the full viewport.
- Page errors: 0. Horizontal overflow: 0 across all sixteen captured states.
- Mobile Attach and Send were already 44px upstream; this batch improves consistency, alignment, and spacing.
- Default dark Send comments: before white text on #ececec; after #212121 text on #ececec.
- This batch covers core web chat. It does not port the full Personal Bot Home/Activity/Routines/Widgets shell.

Source file hashes are in source-manifest.json. Browser measurements are in capture-report.json.

Verification:
Both production frontend builds and the 16-state browser capture passed.
git diff --check HEAD and make complexity passed (existing Go baseline warnings remain).
Working-tree source hashes match the pre-capture manifest: no application source changes.
The full Go and frontend test suites were not rerun for this screenshots-only turn.
