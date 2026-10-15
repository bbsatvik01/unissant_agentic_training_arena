# Wide-screen staff conversation view

Source-only, no browser acceptance claimed. Add the authored `precinct-staff-view.css` import after staff-panel CSS (theme tokens remain intact). No JavaScript, dialog semantics, focus management, camera writer, movement rule or session boundary changes.

At both requested landscape desktop resolutions, the existing one native staff modal occupies the right-hand portion of the screen and removes its heavy backdrop blur. The real colleague remains visible near the existing staff-facing camera centre. The assignment and full exact subtitle remain in the same scrollable dialog. Actual local audio still requires the separate explicit speech control and tested Canvas active-playback invalidation. This stylesheet alone is not evidence of moving lips.

Narrow, short and large-text views retain the original full-width reading surface. Office/Studio colours and contrast controls remain inherited; no transparent text surfaces are introduced. Modal keyboard focus and input ownership are unchanged.

Required integrated browser review: reception and briefing in Office/Studio at 1440×900 and 1920×1080; verify visible colleague, readable full subtitle, real mouth/silence after audio integration, no footer clipping, scrolling, focus return, Escape, 150–200% zoom and large/high-contrast fallback. If the approach camera places the colleague behind the side panel, fix the actual composition rather than using a duplicate avatar or fake portrait.
