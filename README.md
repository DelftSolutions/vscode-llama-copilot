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

For models discovered from llama-server, capabilities are inferred automatically:

- **`imageInput`**: Set to `true` when the model is started with `--image-min-tokens` (vision/multimodal support in llama.cpp).
- **`toolCalling`**: Defaults to `true` for chat models.

You can override these per model in VS Code settings:

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

To enable vision on llama-server, add `image-min-tokens` to your model preset (see [llama-server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)):

```ini
[my-vision-model]
jinja = true
ctx-size = 32768
image-min-tokens = 512
hf = your-org/your-vision-model-GGUF:Q8_0
```

- `imageInput` (boolean): Whether the model supports image input. Auto-detected from `--image-min-tokens` when listed by the server; override in settings if needed (e.g. for config-only models not returned by `/models`).
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
| **Inline completion prompt** | Text sent as the `/infill` `prompt` field (after the FIM middle marker). Default nudges short completions; clear to omit. Endpoint or model `requestBody.prompt` overrides this. |
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

## Remote Server Management via SSH

The extension supports managing a remote `llama-server` instance over SSH.

### Setup

Configure SSH connection settings in VS Code settings (Settings → Llama Copilot, or edit `settings.json` directly):

```json
{
  "llamaCopilot.ssh.host": "your-server.example.com",
  "llamaCopilot.ssh.username": "your-username",
  "llamaCopilot.ssh.privateKeyPath": "~/.ssh/id_rsa",
  "llamaCopilot.ssh.port": 22,
  "llamaCopilot.llamaServer.apiUrl": "http://localhost:8080",
  "llamaCopilot.llamaServer.startCommand": "nohup llama-server --models-preset /path/to/preset.ini --host 0.0.0.0 --port 8080 --mlock > /tmp/llama-server.log 2>&1 &",
  "llamaCopilot.llamaServer.stopCommand": "pkill -f llama-server",
  "llamaCopilot.llamaServer.shutdownCommand": "sudo shutdown -h now"
}
```

| Setting | Description |
|---------|-------------|
| **SSH host** | Remote server hostname or IP address. |
| **SSH username** | Username for SSH authentication. |
| **SSH private key path** | Path to your SSH private key file (e.g., `~/.ssh/id_rsa`). Leave empty for keyboard/password auth. |
| **SSH port** | SSH port (default: 22). |
| **API URL** | The llama-server API URL on the remote host (typically `http://localhost:8080`). |
| **Start command** | Command to start llama-server on the remote host. |
| **Stop command** | Command to stop llama-server on the remote host (default: `pkill -f llama-server`). |
| **Shutdown command** | Command to shut down the remote host (default: `sudo shutdown -h now`). |
| **Start model refresh delay (ms)** | Delay after starting the server before refreshing the model list. Default: 5000 ms. |

### Sudo and sudoers

The extension executes configured commands over SSH via `ssh2.exec()`, which runs them non-interactively. If a command uses `sudo`, it must be configured for passwordless (NOPASSWD) sudo, otherwise the SSH command will hang waiting for a password prompt.

**Which commands use `sudo` by default?**

| Setting | Default value | Uses `sudo`? |
|---------|---------------|--------------|
| `llamaCopilot.llamaServer.startCommand` | `nohup llama-server ...` | No |
| `llamaCopilot.llamaServer.stopCommand` | `pkill -f llama-server` | No |
| `llamaCopilot.llamaServer.shutdownCommand` | `sudo shutdown -h now` | **Yes** |

Only `shutdownCommand` uses `sudo` by default. However, you may choose to run `startCommand` or `stopCommand` with `sudo` in your environment (e.g., if llama-server binds to a privileged port below 1024). In that case, configure the sudoers entry for those commands as well.

**Configuring passwordless sudo**

Create a file `/etc/sudoers.d/llama-copilot` on the remote host (use `visudo -f /etc/sudoers.d/llama-copilot`):

```sudoers
your-username ALL=(root) NOPASSWD: /sbin/shutdown
```

Adjust the path (`/sbin/shutdown`, `/usr/sbin/shutdown`, etc.) to match your system. You can find it with `which shutdown` on the remote host.

If you also use `sudo` with `startCommand` or `stopCommand`, add entries for the specific binaries only (principle of least privilege).

### Status Bar

Once SSH is configured, the VS Code status bar shows real-time information about your remote server:

- **Connection status** — Connecting (spinning icon) / Running / Stopped (slash icon)
- **RAM usage** — Displays used memory and percentage (e.g., `24 GB / 64 GB (38%)`)
- **Server status** — Running, stopped, or connecting

Click the status bar item to refresh the model list.

### Command Palette Commands

All server management actions are available from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P):

| Command | Description |
|---------|-------------|
| **Llama Copilot: Start Llama Server** | Starts the llama-server using the configured `startCommand`. |
| **Llama Copilot: Stop Llama Server** | Stops the llama-server using the configured `stopCommand`. |
| **Llama Copilot: Shutdown Server** | Shuts down the remote host (requires confirmation). |
| **Llama Copilot: Refresh Status** | Manually refreshes the server status and model list. |

### How It Works

The extension polls the remote server over SSH to gather status information:

1. **RAM Usage** — Runs system commands to read total memory and calculate used memory from page statistics. On macOS, it uses `sysctl -n hw.memsize` and `vm_stat`. The polling interval is 1 second.
2. **Server Status** — Checks if `llama-server` is running using `pgrep -f llama-server`.
3. **Auto-reconnect** — If the SSH connection drops, the extension automatically attempts to reconnect on the next poll cycle.

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

### SSH Connection Issues

- **Connection fails** — Verify SSH connectivity from your local machine (`ssh user@host`). Ensure the private key is readable and not passphrase-protected (or use an SSH agent).
- **`sudo` command fails** — If you see `sudo: a terminal is required` or a password prompt in the error output, add a `NOPASSWD` rule for the required command(s) in `/etc/sudoers.d/` (see [Sudo and sudoers](#sudo-and-sudoers)).
- **RAM usage not showing** — The RAM monitoring commands are currently macOS-specific (`sysctl` and `vm_stat`). On Linux, RAM data may not be available.
- **Server status stuck on "connecting"** — Check that the SSH host is reachable and credentials are correct. Look at the "LLaMA Server API" output channel for debug messages.

## Links

- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)
- [llama.cpp Quick Start](https://github.com/ggml-org/llama.cpp#quick-start)
- [llama-server Documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
