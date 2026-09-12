# Copilot for llama-server LLMs

A VS Code extension that integrates [llama-server](https://github.com/ggml-org/llama.cpp) LLMs as language model chat providers, enabling local AI-powered coding assistance directly in VS Code.

> **Note**: This extension has no affiliation with llama.cpp or its maintainers. It is an independent third-party extension that provides integration with llama-server.

## Quick Start

This extension pack includes the [Server Manager](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot-ui), which can download and run llama-server for you automatically.

1. Open the Command Palette → **Llama Copilot: Run Setup**.
2. Choose **Managed** and follow the wizard (binary download → model selection → start).
3. Open a chat session — models appear as `model-name@managed`.

If you already run your own llama-server, choose **Advanced** in the wizard or configure `llamaCopilot.endpoints` in settings (see [Endpoints](#endpoints) below).

## Endpoints

Endpoints tell the extension where to find running llama-server instances. When the managed server is running, a `managed` endpoint is injected automatically — you only need to configure endpoints for additional or remote servers.

### Basic Configuration

```json
{
  "llamaCopilot.endpoints": {
    "remote": {
      "url": "http://192.168.1.100:8080"
    }
  }
}
```

### Endpoint Identifiers

Each key becomes an `@identifier` suffix on its models (e.g. `my-model@remote`). The managed server uses `@managed`.

### Multiple Endpoints

```json
{
  "llamaCopilot.endpoints": {
    "fast": {
      "url": "http://localhost:8013"
    },
    "remote": {
      "url": "http://192.168.1.100:8080",
      "apiToken": "your-api-token-here"
    }
  }
}
```

### API Token Authentication

```json
{
  "llamaCopilot.endpoints": {
    "secure": {
      "url": "https://api.example.com",
      "apiToken": "your-bearer-token-here"
    }
  }
}
```

The token is sent as `Authorization: Bearer <token>`.

### Custom Headers

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "headers": {
        "X-Custom-Header": "value"
      },
      "models": {
        "my-model": {
          "headers": {
            "X-Model-Specific": "value"
          }
        }
      }
    }
  }
}
```

Model-level headers override endpoint-level headers.

## Parameter Overrides

Generation parameters (`temperature`, `top_p`, etc.) can be set at the endpoint level or per model. These are merged into the request body sent to llama-server.

### Endpoint-Level

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "requestBody": {
        "temperature": 0.7,
        "top_p": 0.95,
        "top_k": 40,
        "min_p": 0.01,
        "repeat_penalty": 1.1,
        "max_tokens": 2048
      }
    }
  }
}
```

### Model-Level

Model `requestBody` properties override endpoint-level properties:

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "requestBody": {
        "temperature": 0.7,
        "top_p": 0.95
      },
      "models": {
        "my-model": {
          "requestBody": {
            "temperature": 0.6,
            "top_k": 40
          }
        }
      }
    }
  }
}
```

In this example, `my-model` uses `temperature: 0.6`, `top_p: 0.95` (inherited), and `top_k: 40`.

### Common Parameters

- `temperature` — randomness (0.0 = deterministic, 2.0 = very creative)
- `top_p` — nucleus sampling threshold (0.0–1.0)
- `top_k` — number of tokens considered
- `min_p` — minimum probability threshold
- `repeat_penalty` — penalty for repeating tokens (1.0 = none)
- `max_tokens` — maximum tokens to generate

See [llama-server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) for the full list.

## Per-Model Settings

### Context Size

```json
"models": {
  "large-model": {
    "contextSize": 256000
  }
}
```

### Max Output Tokens

```json
"models": {
  "my-model": {
    "maxOutputTokens": 4096
  }
}
```

### Thinking Budget

Reasoning models can consume their entire output budget on thinking. The extension automatically sets `thinking_budget_tokens` on each request — by default half of `max_tokens`.

Override with `thinkingBudgetFraction` per endpoint or per model. Values above 1 disable the budget entirely.

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "thinkingBudgetFraction": 0.5,
      "models": {
        "qwen3-4b": {
          "thinkingBudgetFraction": 0.3
        },
        "non-reasoning-model": {
          "thinkingBudgetFraction": 2
        }
      }
    }
  }
}
```

An explicit `thinking_budget_tokens` in `requestBody` always takes precedence. If llama-server was started with `--reasoning-budget` (other than `-1`), per-request budgets have no effect.

### Capabilities

Capabilities are inferred automatically for models discovered from llama-server:

- **`imageInput`**: `true` when the model has `--image-min-tokens` (add it to your models.ini — see the [Server Manager README](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot-ui)).
- **`toolCalling`**: `true` for chat models by default.

Override per model:

```json
"models": {
  "multimodal-model": {
    "capabilities": {
      "imageInput": true,
      "toolCalling": true
    }
  }
}
```

`toolCalling` can also be a number to limit the maximum number of tools.

## Request Timeout

**Request timeout (seconds)** controls how long the extension waits for a server response. Default is 3600 (one hour). Increase it if you see timeouts on large contexts. In managed mode the server is started with `--timeout 3600` to match.

## Inline Completions (Ghost Text)

The extension can show inline completions using the llama-server `/infill` endpoint. This requires a FIM-capable model such as [Sweep next-edit](https://huggingface.co/sweepai/sweep-next-edit-1.5B).

### Setup

1. Add a FIM model to your server — in managed mode, use the Models Manager; in advanced mode, add it to your `models.ini`:
   ```ini
   [sweep-next-edit-1.5b]
   jinja = true
   ctx-size = 0
   temp = 0.7
   top-p = 0.8
   top-k = 20
   hf = sweepai/sweep-next-edit-1.5B:latest
   ```
2. Set **Inline completion model** in Settings → Llama Copilot to the model ID including the endpoint, e.g. `sweep-next-edit-1.5b@managed`. Leave empty to disable.

### Settings

| Setting | Description |
|---------|-------------|
| **Inline completion model** | Model ID (e.g. `sweep-next-edit-1.5b@managed`). Empty = disabled. |
| **Inline completion timeout (ms)** | Request timeout; no suggestion shown on timeout. |
| **Inline completion debounce (ms)** | Delay before sending an automatic request. |
| **Max input bytes** | Maximum input size (prefix + suffix + context) sent to the server. |
| **Include context** | Include content from open tabs for better suggestions. |
| **Inline completion prompt** | Text sent as the `/infill` `prompt` field. Default nudges short completions; clear to omit. |

## Cursor Rules Integration

The extension exposes a `get-project-rule` tool that gives the LLM access to your `.cursor/rules/` directory.

### How It Works

1. All `.md` and `.mdc` files in `.cursor/rules/` are discovered.
2. Rules with glob patterns are matched against file attachments and messages.
3. When a glob matches, the rule becomes available for that chat session.
4. The LLM can call `get-project-rule` to retrieve rule contents.

### Rule Format

Simple markdown (`.md`) or markdown with frontmatter (`.mdc`):

```markdown
---
description: "TypeScript coding standards"
globs: ["**/*.ts", "**/*.tsx"]
alwaysApply: false
---

# TypeScript Guidelines

- Use strict mode
- Prefer interfaces over types for object shapes
```

Glob patterns: `*` matches within a path segment, `**` matches across path separators.

The tool accepts comma-separated rule names with optional `rule:` prefix and uses fuzzy matching (Levenshtein distance ≤ 8).

### Configuration

```json
{
  "llamaCopilot.enableCursorRules": true
}
```

When disabled, rules are not parsed and the tool is not exposed.

## Other Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `showAllModels` | `false` | Show all server models without filtering slash-IDs. Enable if models are not appearing. |
| `enableToolLoopDetection` | `true` | Detect and break duplicate tool-call loops. |

Debug flags (`debug.modelListFetch`, `debug.completion`, `debug.tokenization`, `debug.rulesMatching`, `debug.toolCalls`, `debug.inlineCompletion`) log to the "Llama Server API" output channel.

## Usage

### Selecting Models

1. Open the Command Palette → "Chat: Start Session" or use the chat panel.
2. Pick a model from the list — models appear as `model-name@endpoint-id`.

### Chat

- Tool calling and image input work automatically when the model supports them.
- Use **Open Endpoint Settings** to jump to configuration.

## Troubleshooting

### Models Not Appearing

- Managed mode: ensure the server is running (status bar or **Llama Copilot: Start Server**).
- Advanced mode: verify the endpoint URL and that llama-server is running (`/models` should return data).
- Enable `showAllModels` if your model IDs contain slashes.
- Check the "Llama Server API" output channel for errors.

### Configuration Errors

- Validate JSON syntax in `settings.json`.
- Every endpoint needs a `url` field.
- Endpoint identifiers should not contain special characters.

### Parameter Overrides Not Working

- Parameter names must match [llama-server's API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
- Model-level `requestBody` overrides endpoint-level.
- Check the output channel for API request/response details.

### Server Issues

For managed server problems (binary download, server crashes, port conflicts, models not loading), see the [Server Manager troubleshooting](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot-ui).

## Links

- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)
- [llama.cpp Quick Start](https://github.com/ggml-org/llama.cpp#quick-start)
- [llama-server Documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [Server Manager extension](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot-ui)
- [llama.brand](https://github.com/ggml-org/llama.brand) — source of the Llama icons used in this extension (`llama-icon-light.png`, `llama-icon-dark.png` — the repo's `icon/` assets), licensed CC BY-NC 4.0 and used here solely to refer to llama.cpp, per [ggml-org's brand-usage grant](https://github.com/ggml-org/llama.brand/blob/master/BRAND-USAGE.md)
