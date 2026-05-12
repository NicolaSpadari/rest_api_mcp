# rest-api-mcp

A lightweight [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets LLMs interact with any REST API. It executes HTTP requests and provides optimized response analysis, including automatic TypeScript interface generation from live API responses.

## Features

- **Full HTTP support** — GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
- **Smart response truncation** — large JSON payloads are intelligently reduced (arrays sliced, structure preserved) instead of being cut mid-string
- **TypeScript type generation** — automatically derives TypeScript interfaces from API response structures
- **Response structure analysis** — inspect keys, types, and array lengths without returning the full body
- **Field extraction** — pull specific fields using dot-notation paths (e.g. `data.items[].name`)
- **Flexible authentication** — bearer token resolution chain: project `.env.mcp` file → MCP config env var → session token
- **Custom headers** — inject global headers via `HEADER_*` environment variables
- **Zero external runtime dependencies** — uses only the MCP SDK and Node.js built-in `fetch`

## Tools

| Tool | Description |
|---|---|
| `rest_request` | Execute a request and return the full (smart-truncated) response |
| `rest_describe` | Execute a request and return the response structure + generated TypeScript interfaces (no full body) |
| `rest_types` | Execute a request and return only the generated TypeScript interfaces |
| `rest_extract` | Execute a request and extract specific fields by dot-notation paths |
| `rest_set_token` | Set a bearer token for the current session |

## Installation

### Prerequisites

- Node.js >= 18.0.0
- pnpm (or npm/yarn)

### Build from source

```bash
git clone <repository-url>
cd rest-api-mcp
pnpm install
pnpm build
```

### Configure in your MCP client

Add the server to your MCP client configuration (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rest-api": {
      "command": "node",
      "args": ["/path/to/rest-api-mcp/dist/index.js"],
      "env": {
        "REST_BASE_URL": "https://api.example.com",
        "REST_BEARER_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Configuration

All configuration is done via environment variables:

| Variable | Required | Description |
|---|---|---|
| `REST_BASE_URL` | Yes | Base URL for all API requests (e.g. `https://api.example.com/v1`) |
| `REST_BEARER_TOKEN` | No | Bearer token for authentication |
| `REST_RESPONSE_SIZE_LIMIT` | No | Max response size in bytes before smart truncation (default: `50000`) |
| `REST_ENV_DIR` | No | Additional directory to search for `.env.mcp` files containing `REST_BEARER_TOKEN` |
| `HEADER_*` | No | Custom headers injected into every request (e.g. `HEADER_X_API_KEY=abc` sends `X-Api-Key: abc`) |

### Authentication

Bearer tokens are resolved in this order (first match wins):

1. **Project `.env.mcp` file** — `REST_BEARER_TOKEN` in a `.env.mcp` file in the working directory or `REST_ENV_DIR`. Re-read on every request, so token rotation is supported without restarting the server.
2. **MCP config env var** — `REST_BEARER_TOKEN` set in the MCP server configuration.
3. **Session token** — set at runtime via the `rest_set_token` tool.

If a `401` or `403` response is received and no token is configured, the server returns an auth hint suggesting resolution steps.

## Usage Examples

### Basic request

```
rest_request({ method: "GET", endpoint: "/users" })
```

### With query parameters

```
rest_request({ method: "GET", endpoint: "/users", query: { page: "1", limit: "10" } })
```

### Generate TypeScript types from an endpoint

```
rest_types({ method: "GET", endpoint: "/users/1", typeName: "User" })
```

### Describe response structure

```
rest_describe({ method: "GET", endpoint: "/products", typeName: "ProductList" })
```

### Extract specific fields

```
rest_extract({ method: "GET", endpoint: "/orders", fields: ["data[].id", "data[].status", "meta.total"] })
```

## Development

```bash
# Watch mode with hot reload
pnpm dev

# Build for production
pnpm build

# Run the built server
pnpm start
```

## License

MIT
