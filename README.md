# Copilot for llama-server LLMs

Local AI-powered coding assistance in VS Code via [llama-server](https://github.com/ggml-org/llama.cpp). Chat, inline completions, and cursor-rules integration — all running on your own hardware.

> **Note**: This project has no affiliation with llama.cpp or its maintainers.

## Packages

This is a monorepo containing two VS Code extensions and a shared library:

| Package | Description |
|---------|-------------|
| [`packages/workspace`](packages/workspace/) | **Copilot for llama-server LLMs** — chat provider, endpoint configuration, inline completions, cursor rules. Published as the primary Marketplace extension. |
| [`packages/ui`](packages/ui/) | **Llama Copilot — Server Manager** — downloads, runs, and manages a local llama-server instance. Installed automatically as part of the workspace extension pack. |
| [`packages/shared`](packages/shared/) | Shared types, constants, and utilities used by both extensions. |

## Build

```bash
npm install
npm run compile
```

## Test

```bash
npm test
```

## Package

Build `.vsix` files for both extensions:

```bash
npm run package
```

This produces `packages/workspace/*.vsix` and `packages/ui/*.vsix`.

## Links

- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)
- [llama-server Documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
