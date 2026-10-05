# PR visual evidence

Synthetic QA data only. Captures use the upstream baseline and an integration checkout containing the seven preview PRs. Exact commits, runtime measurements and scenario limits are in [verification.json](verification.json).

| PR                                         | Evidence                                         | Scope                                                                                        |
| ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [#1](https://github.com/VaitaR/nao/pull/1) | Dialog and submenu screenshots, dialog recording | Actual imported components in a fixture; viewport bounds, overflow and actionability checked |
| [#2](https://github.com/VaitaR/nao/pull/2) | Feedback dialog, selected vote, recording        | Full app, idle feedback; mutation response and SQLite persistence checked                    |
| [#3](https://github.com/VaitaR/nao/pull/3) | Chat A/B screenshots and navigation recording    | Full app, ordinary SPA navigation A → B → A and reload                                       |
| [#6](https://github.com/VaitaR/nao/pull/6) | Bar axis and usage dates before/after            | Actual ChartDisplay and UsageChartCard components with identical synthetic datasets          |

The component fixtures import the original components, chart builders and styles from each source checkout. Tailwind receives the class literals from those source files. Unused application services and project date preferences are replaced by fixture defaults. Dialog and submenu captures do not exercise a complete product workflow.

Chat recordings do not exercise feedback during generation or the chat-switch/agent-recreation races; the regression tests in #2/#3 cover those cases. No model calls were made. Recordings include reading pauses and captions in a band below the original application viewport. GIF versions use fewer frames and reduced resolution; PNG screenshots are direct browser captures.

Luna prepared the capture scripts. Both worker runs failed their harness acceptance; the owner corrected the fixture tooling and executed all six browser scenarios independently. Only the verified final captures are published here.
