# llama.cpp server `/infill` endpoint

The `/infill` endpoint provides **code infilling** (Fill-In-the-Middle, FIM): given text before and after a gap, the model predicts the missing middle. It is intended for IDE-style code completion (e.g. in-between completion).

## Request

- **Method:** `POST`
- **Path:** `/infill` (or `{api-prefix}/infill` if the server uses `--api-prefix`)

### Main options

| Option | Description |
|--------|-------------|
| `input_prefix` | Code (or text) **before** the gap to fill. |
| `input_suffix` | Code (or text) **after** the gap. Can be empty. |
| `input_extra` | Optional. Array of `{"filename": string, "text": string}` for extra context before the FIM prefix (e.g. other files). |
| `prompt` | Optional. Text added after the `FIM_MID` token (e.g. a partial middle or hint). |

### Router mode: selecting the model

When llama-server is running in **router mode** (started without `-m` / `--model`, e.g. with `--models-dir` or a models cache), include a `model` field in the JSON body to choose which loaded model handles the request. The value is the model name/identifier as known to the router (e.g. the filename or the ID from `GET /models`).

Example request body with model selection:

```json
{
  "model": "ggml-org/MY-CODER-MODEL-GGUF:Q4_K_M",
  "input_prefix": "function foo() {\n  ",
  "input_suffix": "\n}",
  "n_predict": 128
}
```

For GET endpoints (e.g. `/props`), the router uses the `model` **query parameter** instead; for POST endpoints like `/infill`, the `model` field is always in the **request body**.

The endpoint accepts **all options of `/completion`** (e.g. `n_predict`, `temperature`, `top_k`, `top_p`, `stream`, `t_max_predict_ms`). `t_max_predict_ms` is especially useful for FIM to cap generation time.

## Prompt construction

The server builds the infill prompt from special FIM tokens and your inputs.

- **If the model has `FIM_REPO` and `FIM_FILE_SEP` tokens**, the [repo-level pattern](https://arxiv.org/pdf/2409.12186) is used: repo name, then file chunks (filename + text) separated by `<FIM_SEP>`, then:

  ```text
  <FIM_PRE>[input_prefix]<FIM_SUF>[input_suffix]<FIM_MID>[prompt]
  ```

- **Otherwise**, any `input_extra` text is prefixed, then:

  ```text
  <FIM_PRE>[input_prefix]<FIM_SUF>[input_suffix]<FIM_MID>[prompt]
  ```

Server flag `--spm-infill` switches to Suffix/Prefix/Middle order when the model expects it.

## Response

The endpoint returns the predicted **middle** as a **stream** (same streaming behavior as `/completion`). Response fields and streaming format follow the completion endpoint (e.g. `content`, `stop`, optional `tokens`).

## Model support

Use models that support infill/FIM (e.g. Code Llama, Qwen 2.5 Coder). The server can load FIM-capable models via `--model` or router config; some presets (e.g. `--fim-qwen-7b-default`) are intended for infill.

## References

- [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) — full API and options.
- This extension uses `/v1/chat/completions` and `/tokenize` for chat and token counting; it does **not** call `/infill`. This doc is for developers integrating with the llama.cpp server’s infill API.
