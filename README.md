# Copilot for llama-server LLMs

A VS Code extension that integrates [llama-server](https://github.com/ggml-org/llama.cpp) LLMs as language model chat providers, enabling local AI-powered coding assistance directly in VS Code.

> **Note**: This extension has no affiliation with llama.cpp or its maintainers. It is an independent third-party extension that provides integration with llama-server.

Before using this extension, you need to install and run `llama-server` from the [llama.cpp](https://github.com/ggml-org/llama.cpp) project. Follow the [quick start guide](https://github.com/ggml-org/llama.cpp#quick-start) to get started.

### Installing llama.cpp

You can install `llama.cpp` in several ways:

- **Using package managers**: Install using `brew`, `nix`, or `winget`
- **Docker**: Run with Docker - see the [Docker documentation](https://github.com/ggml-org/llama.cpp#quick-start)
- **Pre-built binaries**: Download from the [releases page](https://github.com/ggml-org/llama.cpp/releases)
- **Build from source**: Clone the repository and build - check out the [build guide](https://github.com/ggml-org/llama.cpp#quick-start)

Once installed, you'll need a model to work with. Head to the [Obtaining and quantizing models](https://github.com/ggml-org/llama.cpp#obtaining-and-quantizing-models) section to learn more.

## Starting llama-server

After installing `llama.cpp`, you need to start `llama-server` with your models configured. Here's an example startup script (see `examples/start-llms`):

```bash
#!/bin/bash

llama-server --port 8013 --models-preset ./models.ini --timeout 3600
```

### Key Flags

- `--port`: Specifies the port on which the server will listen (default: 8080)
- `--models-preset`: Path to your models configuration file (INI format)
- `--timeout`: How long in seconds processing can take without any output to the client. Increase this alongside with the [Request timeout (extension setting)](#request-timeout) if you get timeouts.

The server will start and load models according to your configuration. Make sure the server is running before configuring the VS Code extension.

## Model Configuration

Models are configured using an INI file format. See `examples/models.ini` for a complete example. Here's an example for a MacBook with 128GB RAM:

```ini
[nemotron-3-nano-30b]
jinja = true
ctx-size = 256000
temp = 1.0
top-p = 1.00
fit = on
hf = unsloth/Nemotron-3-Nano-30B-A3B-GGUF:BF16

[qwen3-4b]
jinja = true
ctx-size = 32768
temp = 0.6
min-p = 0.0
top-p = 0.95
top-k = 20
hf = unsloth/Qwen3-4B-128K-GGUF:Q8_K_XL

[glm-4-7-flash]
jinja = true
ctx-size = 202752
temp = 0.7
top-p = 1.0
min-p = 0.01
repeat-penalty = 1.0
hf = unsloth/GLM-4.7-Flash-GGUF:BF16
```

### Configuration Options

Please look at the modelfile accompanying your model for the settings to use. All available settings can be found in [the llama-server readme](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

### Memory Considerations

Make sure to pick models and context sizes that work with your machine.

- **Context size**: Larger context sizes require more RAM
  - 1,000,000 tokens ≈ 133GB RAM
  - 256,000 tokens ≈ 33GB RAM
  - 128,000 tokens ≈ 17GB RAM
  - 32,768 tokens ≈ 4GB RAM

- **Quantization**: Smaller quantizations use less RAM
  - BF16: 2× model size (30b model => 60GB)
  - Q8_0: 1× model size
  - Q4_0: 0.5× model size
  - Q1_0: 0.125× model size

## VS Code Extension Configuration

Configure the extension by adding endpoint settings to your VS Code settings (File → Preferences → Settings, or edit `settings.json` directly).

### Basic Configuration

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013"
    }
  }
}
```

### Endpoint Identifiers

Each endpoint has an identifier (e.g., `"local"`). Models from that endpoint will be displayed with the suffix `@identifier` (e.g., `my-model@local`). This allows you to:

- Connect to multiple llama-server instances
- Distinguish between models from different endpoints
- Configure different settings per endpoint

### Multiple Endpoints

You can configure multiple endpoints:

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013"
    },
    "remote": {
      "url": "http://192.168.1.100:8080",
      "apiToken": "your-api-token-here"
    }
  }
}
```

## Parameter Overrides

You can override generation parameters (temperature, top_p, etc.) at both the endpoint and model level. These overrides are merged into the request body sent to llama-server.

### Endpoint-Level Overrides

Apply parameters to all models on an endpoint:

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

### Model-Level Overrides

Override parameters for specific models. Model-level `requestBody` properties override endpoint-level properties:

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
            "top_p": 0.9,
            "top_k": 40
          }
        }
      }
    }
  }
}
```

In this example, `my-model` will use `temperature: 0.6`, `top_p: 0.9`, and `top_k: 40`, while other models on the `local` endpoint will use `temperature: 0.7` and `top_p: 0.95`.

### Common Parameters

- `temperature` (number): Controls randomness (0.0 = deterministic, 2.0 = very creative)
- `top_p` (number): Nucleus sampling threshold (0.0 to 1.0)
- `top_k` (number): Top-k sampling (number of tokens to consider)
- `min_p` (number): Minimum probability threshold
- `repeat_penalty` (number): Penalty for repeating tokens (1.0 = no penalty, >1.0 = penalty)
- `max_tokens` (number): Maximum number of tokens to generate

## Advanced Configuration

### Headers

Add custom headers for authentication or other purposes:

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

### API Token Authentication

For authenticated endpoints:

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

The token will be sent as `Authorization: Bearer <token>` in all requests.

### Request timeout

The extension uses a **Request timeout** (Settings → Llama Copilot → **Request timeout (seconds)**) for how long it waits for the server to respond. This should be at least as large as the `--timeout` you pass to `llama-server`. If you see proxy or stream timeouts, increase the extension timeout and ensure `llama-server` is started with `--timeout` (e.g. `--timeout 3600`).

### Context Size Overrides

Override the context size for a specific model:

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "models": {
        "large-model": {
          "contextSize": 256000
        }
      }
    }
  }
}
```

### Max Output Tokens Overrides

Override the maximum output tokens:

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "models": {
        "my-model": {
          "maxOutputTokens": 4096
        }
      }
    }
  }
}
```

### Capabilities Configuration

Configure model capabilities:

```json
{
  "llamaCopilot.endpoints": {
    "local": {
      "url": "http://localhost:8013",
      "models": {
        "multimodal-model": {
          "capabilities": {
            "imageInput": true,
            "toolCalling": true
          }
        },
        "tool-model": {
          "capabilities": {
            "toolCalling": 10
          }
        }
      }
    }
  }
}
```

- `imageInput` (boolean): Whether the model supports image input
- `toolCalling` (boolean | number): Whether the model supports tool calling. Can be a boolean or a number (maximum number of tools)

## Inline completions (ghost text)

The extension can show inline (ghost) completions in the editor using the llama-server **/infill** endpoint. This requires a **FIM-capable model** (fill-in-the-middle), such as the [Sweep next-edit](https://huggingface.co/sweepai/sweep-next-edit-1.5B) models.

### Setup

1. **Configure an endpoint** and ensure llama-server is running with a FIM-capable model loaded (see below).
2. Set **Inline completion model** in Settings → Llama Copilot to a model ID including the endpoint, e.g. `sweep-next-edit-1.5b@local`. If this setting is empty, inline completions are disabled.

### llama-server setup for FIM

Your server must be running with a model that supports FIM tokens. Add one of the following to your `models.ini` and load it (e.g. with `llama-server --port 8013 --models-preset ./models.ini --timeout 3600`):

**sweep-next-edit-1.5b:**

```ini
[sweep-next-edit-1.5b]
jinja = true
ctx-size = 0
temp = 0.7
top-p = 0.8
top-k = 20
hf = sweepai/sweep-next-edit-1.5B:latest
```

**sweep-next-edit-0.5b:**

```ini
[sweep-next-edit-0.5b]
jinja = true
ctx-size = 0
temp = 0.7
top-p = 0.8
top-k = 20
hf = sweepai/sweep-next-edit-0.5B:Q8_0
```

### Inline completion settings

| Setting | Description |
|--------|-------------|
| **Inline completion model** | Model ID (e.g. `sweep-next-edit-1.5b@local`). Empty = disabled. |
| **Inline completion timeout (ms)** | Request timeout; no suggestion is shown on timeout. |
| **Inline completion debounce (ms)** | Delay before sending an automatic (as-you-type) request. |
| **Max input bytes** | Maximum total input size (prefix + suffix + context) sent to the server. |
| **Include context** | When enabled, include content from other open tabs to improve suggestions. |
| **Debug: Inline completion** | Log requests, cancellations, and errors to the "LLaMA Server API" output. |

## Cursor Rules Integration

The extension includes a built-in tool that gives the LLM access to your project's cursor rules from `.cursor/rules/`. This allows the model to access project-specific guidelines, coding standards, and best practices automatically.

### How It Works

1. **Rule Discovery**: The extension automatically reads all `.md` and `.mdc` files from `.cursor/rules/` in your workspace
2. **Glob Matching**: Rules with glob patterns in their frontmatter are matched against:
   - File attachments (e.g., `@src/logger.ts:32`)
   - User messages
   - Assistant messages
   - Tool call parameters (first 1024 bytes)
3. **Session Scoping**: Available rules are tracked per chat session. When a glob matches, that rule becomes available for that conversation
4. **Tool Exposure**: When rules are available, a `get-project-rule` tool is automatically exposed to the LLM

### Rule File Format

Rules can be simple markdown files (`.md`) or markdown files with frontmatter (`.mdc`):

**Simple rule** (`.md`):
```markdown
# Coding Guidelines

Always use TypeScript strict mode.
Prefer async/await over promises.
```

**Rule with frontmatter** (`.mdc`):
```markdown
---
description: "TypeScript coding standards"
globs: ["**/*.ts", "**/*.tsx"]
alwaysApply: false
---

# TypeScript Guidelines

- Use strict mode
- Prefer interfaces over types for object shapes
- Use const assertions where appropriate
```

### Glob Pattern Matching

Glob patterns are converted to regex patterns:
- `*` matches any characters except path separators: `[a-zA-Z0-9.~@+=_|-]`
- `**` matches any characters including path separators: `[a-zA-Z0-9.~@+=_|\/-]`
- Both Windows (`\`) and Unix (`/`) path separators are supported

### Tool Usage

When rules are available, the LLM can call the `get-project-rule` tool:

```
get-project-rule(rule: "coding-guidelines.md,style/markdown.mdc")
```

The tool supports:
- Comma-separated rule names
- Optional `rule:` prefix (e.g., `rule:style.md` or just `style.md`)
- Fuzzy matching: If a rule isn't found exactly, the closest match (within Levenshtein distance 8) is used
- Returns `<empty file>` if no matching rule is found

### Configuration

Enable or disable the cursor rules feature in settings:

```json
{
  "llamaCopilot.enableCursorRules": true
}
```

When disabled:
- Rules are not parsed
- The tool is not exposed to the LLM
- No performance overhead from rule matching

### Example

1. Create a rule file `.cursor/rules/typescript.md`:
```markdown
# TypeScript Rules

Always use explicit return types for functions.
Prefer `interface` over `type` for object shapes.
```

2. Create a rule with glob matching `.cursor/rules/react-components.mdc`:
```markdown
---
description: "React component guidelines"
globs: ["**/*.tsx", "src/components/**"]
---

# React Components

- Use functional components with hooks
- Extract complex logic into custom hooks
- Use React.memo for expensive components
```

3. When you mention a file matching the glob (e.g., `@src/components/Button.tsx`), the rule becomes available to the LLM automatically

## Usage

### Selecting Models

1. Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Type "Chat: Start Session" or use the chat interface
3. Select a model from the list (models appear as `model-name@endpoint-id`)

### Using the Chat Interface

- Start a chat session with a selected model
- The extension supports tool calling if the model supports it
- Models with image input capability can process images

### Opening Settings

Use the command "Open Endpoint Settings" to quickly access the configuration, or navigate to Settings and search for "llamaCopilot".

## Troubleshooting

### Server Not Found

- Ensure `llama-server` is running
- Check that the URL in your configuration matches the server's address and port
- Verify the server is accessible (try opening the URL in a browser)

### Models Not Appearing

- Check that models are loaded in `llama-server` (visit `/models` endpoint)
- Ensure models don't have "/" in their ID (these are filtered out)
- Verify the endpoint URL is correct
- Check the VS Code output panel for error messages (View → Output → "LLaMA Server API")

### Configuration Errors

- Validate your JSON syntax in `settings.json`
- Ensure required fields (`url`) are present
- Check that endpoint identifiers don't contain special characters

### Parameter Overrides Not Working

- Verify the parameter names match llama-server's API (check [llama-server documentation](https://github.com/ggml-org/llama.cpp))
- Remember that model-level `requestBody` overrides endpoint-level `requestBody`
- Check the VS Code output panel for API request/response logs

## Links

- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)
- [llama.cpp Quick Start](https://github.com/ggml-org/llama.cpp#quick-start)
- [llama-server Documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
