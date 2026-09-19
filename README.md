# save-token-jev

Portable, Jev-guided context compaction for coding agents.

Instead of asking another LLM to rewrite old context into a lossy summary, `save-token-jev` asks Jev which tool calls and results still matter. User and assistant text is kept verbatim. A tool call can be kept with its full result, kept with a bounded result, or removed together with its result.

The algorithm is implemented behind a normalized transcript model and host adapters so the same compaction policy works across multiple coding-agent runtimes.

## Supported hosts

| Host / format | Integration | Behavior |
| --- | --- | --- |
| Codex CLI/app | Codex plugin hooks | Scores before built-in compaction and restores retained verbatim context immediately afterward |
| OpenCode V2 | npm plugin | Replaces the compaction summary through `session.hook("compaction")` |
| Claude Code | function-hook plugin | Directly replaces compaction with the retained message list |
| Anthropic API | transcript adapter | Decodes `tool_use` / `tool_result` blocks for applications |
| OpenAI Responses | transcript adapter | Decodes messages, function calls, custom calls, and outputs |
| OpenAI Chat Completions | transcript adapter | Decodes assistant `tool_calls` and tool messages |
| Any agent | generic adapter / CLI | Accepts the normalized `{ role, parts }` format; custom adapters implement one small interface |

Codex currently does not expose a command-hook response that replaces its compacted transcript. Its integration therefore uses the documented `PreCompact` plus `SessionStart(source="compact")` lifecycle. OpenCode exposes a direct compaction-result hook, so its integration replaces the summary.

## Jev providers

The decisions can come from TypeSafe directly or from OpenRouter's Decisions API. Both speak the same `{ model, state, questions }` request and `{ answers }` response, so the compactor and every host integration are unchanged; only the endpoint, the key, and the model id differ.

| Provider | Endpoint | Key | Default model |
| --- | --- | --- | --- |
| TypeSafe (default) | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |

OpenRouter is selected when `JEV_PROVIDER=openrouter`, or automatically when `OPENROUTER_API_KEY` is set and neither `TYPESAFE_API_KEY`, `JEV_BASE_URL`, nor an explicit `apiKey` is. An explicit `provider` option wins over all of them. `JEV_MODEL` and `JEV_BASE_URL` still override the provider defaults, and a key is only ever read from the variable belonging to the selected provider.

```bash
export OPENROUTER_API_KEY="sk-or-..."
export JEV_PROVIDER=openrouter   # optional; the key alone selects OpenRouter
save-token-jev doctor            # prints the resolved provider, key variable, model, and endpoint
```

The OpenRouter transport also sends optional attribution headers. `OPENROUTER_APP_NAME` defaults to `save-token-jev` and `OPENROUTER_APP_URL` is unset unless you provide it; `x-title` and `http-referer` never change routing.

```ts
import { compactMessages } from 'save-token-jev';

const result = await compactMessages(messages, { provider: 'openrouter' });
```

## Install and build

```bash
npm install
npm run check
export TYPESAFE_API_KEY="..."   # or OPENROUTER_API_KEY
```

Node 20 or newer is required. The runtime package has no third-party dependencies.

## Codex

This repository is a Codex plugin (`.codex-plugin/plugin.json` and `hooks/hooks.json`). Build it before installing or linking it because the hook runs `dist/cli.js`.

For a project-local setup without a marketplace, copy the contents of `hooks/hooks.json` into `.codex/hooks.json`, replace `${PLUGIN_ROOT}` with this repository's absolute path, then open `/hooks` in Codex and trust the hook definition. Set `TYPESAFE_API_KEY` in the environment that launches Codex.

To enable it for every Codex project and session on your machine, copy the same hook definition to the user-level Codex configuration instead:

```bash
cp hooks/hooks.json ~/.codex/hooks.json
perl -0pi -e 's/\$\{PLUGIN_ROOT\}/\/absolute\/path\/to\/save-token-jev/g' ~/.codex/hooks.json
```

Replace `/absolute/path/to/save-token-jev` with the actual checkout path. Restart Codex after changing hooks and approve the hook if Codex asks you to trust it. User-level hooks are loaded independently of the current project, while project-local hooks require that project to be trusted.

The repository also includes a ready-to-use local configuration at `.codex/hooks.json` for this checkout. It points at the built `dist/cli.js`, so run `npm run build` after cloning or changing source files.

The flow is fail-open:

1. `PreCompact` reads the Codex rollout JSONL and asks Jev about completed tool calls.
2. If the reduction is worthwhile, it atomically stores the retained normalized context in the plugin data directory.
3. Codex performs its built-in compaction.
4. `SessionStart` for `source: compact` injects the retained context before the next model request.
5. Missing keys, malformed responses, unsupported transcript changes, and low reduction all fall back to Codex's built-in compaction.

Codex documents `transcript_path` as convenient but not stable. All parsing is isolated in `src/adapters/codex.ts` and covered by fixtures so a future rollout change only needs an adapter update.

## OpenCode

Install the package in the OpenCode config directory, then list it as a plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["save-token-jev"]
}
```

The package's default export is a V2 plugin object with `id` and `setup()`. It registers the compaction hook during setup. On a Jev error or insufficient reduction it leaves `event.result` unset, which lets OpenCode run its normal compaction.

## Claude Code

Claude Code's function hooks can directly replace the message list, so this integration has the same no-summary behavior as the reference project. Build first, opt into function hooks, and load the dedicated plugin directory:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export TYPESAFE_API_KEY="..."   # or OPENROUTER_API_KEY and JEV_PROVIDER=openrouter
claude --plugin-dir ./plugins/claude-save-token-jev
```

The Claude manifest is intentionally nested because Codex and Claude use incompatible `hooks/hooks.json` schemas.

## CLI

Compact a normalized, Anthropic, OpenAI, or OpenCode JSON transcript:

```bash
save-token-jev compact \
  --format anthropic \
  --input transcript.json \
  --output compacted.json
```

Read a Codex rollout JSONL:

```bash
save-token-jev compact --format codex-jsonl --input rollout.jsonl
```

Inspect environment readiness:

```bash
save-token-jev doctor
```

The CLI prints the compacted normalized transcript, decisions, and statistics as JSON. Diagnostics go to stderr, so stdout remains pipeable.

## Local savings dashboard

You can start the local dashboard manually:

```bash
node dist/cli.js dashboard
```

It prints a localhost URL such as `http://127.0.0.1:43127/`. Open that link to see total compactions, characters saved, estimated tokens saved, per-tool savings, and the individual compaction runs. The dashboard binds to loopback only and reads the Codex history stored under the same data directory as the hooks. Use `--port 43127` for a stable port or `--data-dir DIR` to inspect another hook data directory.

The Codex `PreCompact` and `SessionStart` hooks also start the dashboard automatically on port `43127` and include the link in their visible status/context. The link is `http://127.0.0.1:43127/`. Set `SAVE_TOKEN_JEV_DASHBOARD_PORT` to choose another port. Set `SAVE_TOKEN_JEV_DASHBOARD=off` only if you intentionally do not want the dashboard process started; hook messages still show the configured link.

## Library

```ts
import { compactMessages, type TranscriptMessage } from 'save-token-jev';

const messages: TranscriptMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: 'Fix the test. Never edit generated files.' }] },
  {
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'src/a.ts' } }],
  },
  {
    role: 'tool',
    parts: [{ type: 'tool_result', callId: 'call-1', output: 'file contents' }],
  },
];

const result = await compactMessages(messages, {
  preserveRecentMessages: 6,
  keepThreshold: 0.5,
});
```

Bring your own Jev-compatible transport for tests, gateways, or non-HTTP runtimes:

```ts
import { compact, type JevAsker } from 'save-token-jev';

const asker: JevAsker = {
  async ask(state, questions) {
    return myTransport(state, questions);
  },
};

const result = await compact(messages, asker);
```

To support another host, implement `TranscriptAdapter<T>` with `canDecode` and `decode`, then pass it to `decodeTranscript`. Unknown blocks should become `{ type: "opaque", value }`; opaque content is never selected for deletion.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required for the TypeSafe transport unless stored in macOS Keychain | TypeSafe/Jev API key |
| `OPENROUTER_API_KEY` | — | OpenRouter key; also selects the OpenRouter transport when no TypeSafe key or endpoint is set |
| `JEV_PROVIDER` | detected | `typesafe` or `openrouter`; overrides key-based detection and rejects unknown values |
| `JEV_MODEL` | provider default | Jev model (`jev-latest` or `typesafe/jev-1.13`) |
| `JEV_BASE_URL` | provider endpoint | Alternate compatible endpoint |
| `OPENROUTER_APP_NAME` | `save-token-jev` | OpenRouter `x-title` attribution header |
| `OPENROUTER_APP_URL` | unset | OpenRouter `http-referer` attribution header |
| `SAVE_TOKEN_JEV_KEEP_THRESHOLD` | `0.5` | Minimum keep probability |
| `SAVE_TOKEN_JEV_PRESERVE_RECENT` | `6` | Newest messages pinned from deletion |
| `SAVE_TOKEN_JEV_MIN_REDUCTION` | `0.15` | Minimum reduction for host integration takeover |
| `SAVE_TOKEN_JEV_MAX_STATE_TOKENS` | `25000` | Estimated state budget |
| `SAVE_TOKEN_JEV_MAX_REQUEST_TOKENS` | `30000` | Estimated state + question budget |
| `SAVE_TOKEN_JEV_TRUNCATE_HEAD_CHARS` | `300` | Result prefix retained when only the call matters |
| `SAVE_TOKEN_JEV_MAX_CONCURRENT_REQUESTS` | `4` | Jev requests allowed in flight at once |
| `SAVE_TOKEN_JEV_TIMEOUT_MS` | `30000` | Provider request timeout before fail-open fallback |

## Safety properties

- A tool result is paired by call ID and is never left behind when its call is removed.
- The first and newest configured messages are pinned.
- Text and opaque blocks are never summarized or selected for deletion.
- Untouched message and part objects retain their identity in the library result.
- Requests are batched concurrently and malformed or incomplete Jev answers fail the entire attempt.
- Host integrations fall back to native compaction rather than blocking the agent.
- A key is only read from the variable of the selected provider, so a TypeSafe key is never sent to OpenRouter and an OpenRouter key is never sent to TypeSafe. An explicitly passed `apiKey` keeps the TypeSafe default even when `OPENROUTER_API_KEY` is set in the surrounding environment.

Token counts are conservative estimates, not tokenizer-exact values. Jev probabilities are decisions, not proofs; use a higher threshold for sessions with expensive or irreproducible tool output.

On macOS, `save-token-jev` also checks Login Keychain for a generic password whose account is the current OS username, using the service `save-token-jev` for TypeSafe and `save-token-jev-openrouter` for OpenRouter. This keeps the API key out of repository configuration and shell startup files. Pass `useKeychain: false` to the library, or `resolveApiKey`, when the `security` subprocess should not run.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The test suite uses a fake Jev transport and never sends network requests.
