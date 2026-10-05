# Replay the chat reproductions

Use the pinned before/after checkouts described in the parent README, each with its frontend dependencies installed, plus Playwright and Chromium. From a checkout with Node 22:

```sh
NAO_BEFORE_ROOT=/path/to/baseline \
NAO_AFTER_ROOT=/path/to/patched \
REPRO_OUTPUT_DIR=/tmp/nao-repro-output \
REPRO_CACHE_DIR=/tmp/nao-repro-cache \
node .github/images/pr-previews/2026-10-05/reproductions/scripts/capture.cjs
```

Set `PLAYWRIGHT_MODULE` or `CHROMIUM_EXECUTABLE` if those are installed outside the usual locations. The script starts and stops its own loopback servers on ports 3061 and 3062. It blocks external requests and replaces font requests with empty CSS.

The feedback fixture imports the real `AssistantMessageActions`, button, dialog and Lucide icons. It controls the agent store, React Query boundary and mutation response. The chat fixture imports the real `useSyncMessages` and controls chat ID, agent lifecycle and query cache. Unused transport, export, router and application services are stubbed. Both versions use the same frame and stores; only the imported source revision changes.

Both scenarios must reproduce the original failure and pass after the patch. The raw receipt retains each initial state, result, action timing and browser errors. The frame's messages and status text are derived from the actual stores. No backend, real stream transport or LLM request is exercised.
