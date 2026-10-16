# First production pointer-routing attempt

15 October 23:56 to 16 October 00:01 UTC, 2026. Same frozen Studio candidate/dist as the [stationary measurement](../studio-stationary/README.md). Original report/schema and every failure are preserved.

**Overall acceptance failed**, runner exit 1. All four initial five-second cold gates failed. Both first-person cases later completed board precedence (two clicks), actual floor travel through intermediate minimap positions to the selected reachable endpoint, stationary checks, and physical monitor opening/closing. The Office/Courtyard before/arrival images were visually reviewed: the clicked floor region is unobstructed and the endpoint view changes consistently with recorded movement. This verifies those functional cases, not performance or every camera mode.

Both third-person cases failed during initial settled-arrival observation, before board/floor interaction. Their 1.5-second sampling windows recorded only two observations, where the existing minimum is three. Office samples arrived at 14.725 ms and 2,279.469 ms; Courtyard at 5.222 ms and 2,187.667 ms. The late observations do not establish stability within the required window. This does not prove a navigation defect or isolate CDP delay from browser/event-loop stalls.

A proposed browser-local read-only public-minimap sampler will retain the same host-start deadline, 150 ms cadence, minimum three in-window samples and 0.035 m movement tolerance. It must keep late samples separate and fail on starvation, rather than extend the window or count late observations as a pass. It is not part of this preserved run.

No API/external/socket attempts or runtime errors occurred. All four contexts were attempted. Native duration was 272.333 seconds; owned children closed, native temporary profile removed and cleanup errors empty. Third-person physical-monitor coverage was outside the existing test scope. The original timing/action/assertion gates remain unchanged. No local runner logs are committed.
