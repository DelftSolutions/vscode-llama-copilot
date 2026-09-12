# Llama Copilot — Server Manager

Companion extension that downloads, runs, and manages a local [llama-server](https://github.com/ggml-org/llama.cpp) instance. Bundled with [Copilot for llama-server LLMs](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot) and installed automatically as part of its extension pack.

> **Note**: This extension has no affiliation with llama.cpp or its maintainers.

## Getting Started

Run the command **Llama Copilot: Run Setup** to open the onboarding wizard. It offers three paths:

| Mode | What happens |
|------|-------------|
| **Managed** (recommended) | Downloads the llama-server binary, lets you pick a model from built-in presets, and starts the server automatically. The chat extension receives a `managed` endpoint — no manual configuration needed. |
| **Advanced** | Skips managed setup. You install and run llama-server yourself and configure `llamaCopilot.endpoints` in VS Code settings (see the [chat extension README](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot)). |
| **Skip** | Dismisses the wizard. You can re-run it any time. |

After choosing **Managed**, the wizard walks you through:

1. **Binary download** — fetched from the llama.cpp GitHub releases for your platform.
2. **Model selection** — recommended based on your hardware (RAM, GPU). Pick a preset or enable additional models.
3. **Server start** — the server launches in the background; a status-bar item shows its state.

In remote (SSH) sessions the wizard also offers to configure `RemoteForward` entries in your SSH config so the remote VS Code instance can reach the locally running server.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| **Llama Copilot: Run Setup** | Open the onboarding wizard. |
| **Llama Copilot: Start Server** | Start the managed llama-server. |
| **Llama Copilot: Stop Server** | Stop the managed llama-server. |
| **Llama Copilot: Restart Server** | Restart the managed llama-server. |
| **Llama Copilot: Update llama-server Binary** | Check for a newer llama-server release and install it. |
| **Llama Copilot: Manage Models** | Open the Models Manager to toggle presets on or off. |
| **Llama Copilot: Edit models.ini** | Open the raw `models.ini` file in the editor. |
| **Llama Copilot: Configure SSH Forwards** | Add `RemoteForward` entries to your SSH config for remote sessions. |
| **Llama Copilot: Revert SSH Config** | Undo SSH config changes made by the extension. |

## Settings

Settings live under `llamaCopilot.server.*` in VS Code settings (`settings.json`).

| Setting | Default | Description |
|---------|---------|-------------|
| `server.managed` | `false` | Enable managed mode. When on, the extension downloads, starts, and auto-restarts llama-server. |
| `server.port` | `8013` | Port the managed server listens on. |
| `server.stopOnDeactivate` | `true` | Kill the server when VS Code closes. Set to `false` to keep it running between sessions. |
| `server.autoUpdate` | `true` | Automatically update the binary when a new llama.cpp release is available. |
| `server.extraArgs` | `[]` | Additional CLI arguments passed to llama-server (e.g. `["--gpu-layers", "99"]`). |
| `server.manageModels` | — | Shortcut link in Settings UI that opens the Models Manager. |

## Models Manager

The Models Manager (**Llama Copilot: Manage Models**) lets you toggle built-in presets on or off. Each preset defines a model with recommended settings (context size, sampling parameters, quantization). The manager writes a `models.ini` that the managed server loads with `--models-preset`.

Presets that exceed your system RAM are dimmed. You can still enable them manually.

To hand-edit the configuration, run **Llama Copilot: Edit models.ini**. User-added sections (those without a `; managed:` tracking comment) are preserved across manager updates.

### models.ini Format

Each section defines one model. Refer to [the llama-server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) for all available keys.

```ini
[qwen3-4b]
jinja = true
ctx-size = 32768
temp = 0.6
min-p = 0.0
top-p = 0.95
top-k = 20
hf = unsloth/Qwen3-4B-128K-GGUF:Q8_K_XL
```

To enable vision on a model, add `image-min-tokens`:

```ini
[my-vision-model]
jinja = true
ctx-size = 32768
image-min-tokens = 512
hf = your-org/your-vision-model-GGUF:Q8_0
```

### Memory Considerations

Pick models and context sizes that fit your machine.

- **Context size** (approximate additional RAM):
  - 1,000,000 tokens ≈ 133 GB
  - 256,000 tokens ≈ 33 GB
  - 128,000 tokens ≈ 17 GB
  - 32,768 tokens ≈ 4 GB

- **Quantization** (relative to parameter count):
  - BF16: 2× model size (30B → ~60 GB)
  - Q8_0: ~1× model size
  - Q4_0: ~0.5× model size
  - Q1_0: ~0.125× model size

## Remote / SSH Sessions

When you open a remote SSH workspace, VS Code runs the workspace (chat) extension on the remote host while the Server Manager runs locally. The managed server listens on `127.0.0.1:<port>` on your local machine, so the remote host needs a tunnel to reach it.

The extension can configure this automatically:

1. **Proactive check** — on activation in an SSH session, the extension inspects your SSH config and offers to add `RemoteForward` entries if they are missing.
2. **Manual** — run **Llama Copilot: Configure SSH Forwards** to set up or update forwards at any time.
3. **Revert** — run **Llama Copilot: Revert SSH Config** to undo the changes.

Forwards are derived from the managed server port and any endpoints with private/local URLs.

## Advanced: Bring Your Own Server

If you prefer to install and run llama-server yourself:

1. Install llama.cpp via `brew`, `nix`, `winget`, [pre-built binaries](https://github.com/ggml-org/llama.cpp/releases), or [from source](https://github.com/ggml-org/llama.cpp#quick-start).
2. Start the server with your models:
   ```bash
   llama-server --port 8013 --models-preset ./models.ini --timeout 3600
   ```
3. In the onboarding wizard choose **Advanced**, or configure `llamaCopilot.endpoints` manually in the [chat extension settings](https://marketplace.visualstudio.com/items?itemName=delft-solutions.llama-copilot).

The managed flags (`--port`, `--models-preset`, `--timeout 3600`) are passed automatically in managed mode. Use `server.extraArgs` to append additional flags.

## Troubleshooting

### Binary Download Fails
- Check your internet connection and proxy settings.
- GitHub rate limits may apply — wait a few minutes and retry.
- Run **Llama Copilot: Update llama-server Binary** to retry manually.

### Server Won't Start
- Look at the **llama-server** output channel (View → Output → "llama-server") for error details.
- Check that the port is not already in use (`server.port`, default 8013).
- If the binary is corrupted, delete it from global storage and re-run setup.

### Models Not Loading
- Open the Models Manager and verify at least one preset is enabled.
- Run **Llama Copilot: Edit models.ini** and check for INI syntax errors.
- Ensure the model fits in available RAM (see [Memory Considerations](#memory-considerations)).

### SSH Tunnel Not Working
- Verify that `RemoteForward` lines appear in your SSH config for the correct host.
- Reconnect the SSH session after changing the config.
- Run **Llama Copilot: Configure SSH Forwards** to regenerate entries.

## Links

- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)
- [llama.cpp Quick Start](https://github.com/ggml-org/llama.cpp#quick-start)
- [llama-server Documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama.brand](https://github.com/ggml-org/llama.brand) — source of the Llama icons used in this extension (`llama-icon-light.png`, `llama-icon-dark.png` — the repo's `icon/` assets), licensed CC BY-NC 4.0 and used here solely to refer to llama.cpp, per [ggml-org's brand-usage grant](https://github.com/ggml-org/llama.brand/blob/master/BRAND-USAGE.md)
