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

llama-server --port 8013 --models-preset ./models.ini
```

### Key Flags

- `--port`: Specifies the port on which the server will listen (default: 8080)
- `--models-preset`: Path to your models configuration file (INI format)

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
