# Reproducing the preview fixes

Before: upstream commit `1de3864bfa36d6c58d1e42542eb5e310c77d3752`. After: integration commit `d998d0786983a4a06d33f9ed658f9ad8af30a593`, containing the seven preview fixes. All examples use synthetic data.

| PR                                         | Trigger                                         | Before                                           | After                                        |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| [#1](https://github.com/VaitaR/nao/pull/1) | Open a long dialog or submenu on a short screen | Actions or final options extend off-screen       | Scrolling reaches them                       |
| [#2](https://github.com/VaitaR/nao/pull/2) | Submit an upvote for a live agent message       | Cache saves the vote; live message keeps no vote | Cache and live message both contain the vote |
| [#3](https://github.com/VaitaR/nao/pull/3) | Switch from running Chat A to saved Chat B      | B loses its cached history                       | B keeps its own messages                     |
| [#6](https://github.com/VaitaR/nao/pull/6) | Render the same counts and daily usage          | Awkward axis steps and crowded dates             | Round axis steps and fewer complete dates    |

The dialog and chart captures import the original components and styles. The feedback reproduction imports `AssistantMessageActions`; its agent, cache and network response are controlled by the fixture. The chat reproduction imports `useSyncMessages`; its agent lifecycle and cache are controlled by the fixture. The synchronization code under test is not reimplemented. Each before/after pair uses one shared fixture; only the imported source revision changes.

These are component and hook reproductions, not complete application workflows. No LLM or external provider requests are made. The chat fixture reproduces the running-to-idle switch covered by the regression tests; it does not exercise real streaming transport.

New recordings show the bug before the patch and the same actions after it, with reading pauses and explicit captions. Screenshot comparisons show the failure and result directly. Earlier `part-2-feedback` and `part-3-navigation` recordings only cover idle application smoke scenarios and are not evidence of the synchronization bugs. Their separate SQLite checks remain in [verification.json](verification.json).

See [reproduction measurements](reproductions/results.json) for preconditions, actual state and media timing, and [fixture replay notes](reproductions/report.md) for the command and mocked boundaries.
