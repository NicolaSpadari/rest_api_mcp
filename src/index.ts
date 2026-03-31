#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const REST_BASE_URL = process.env.REST_BASE_URL;
if (!REST_BASE_URL) {
  throw new Error('REST_BASE_URL environment variable is required');
}

const RESPONSE_SIZE_LIMIT = Math.max(
  1,
  parseInt(process.env.REST_RESPONSE_SIZE_LIMIT || '50000', 10) || 50000,
);

const CONFIG_BEARER_TOKEN = process.env.REST_BEARER_TOKEN || '';

// Directories to search for .env files (cwd first, then explicit env var)
const ENV_SEARCH_DIRS = [
  process.cwd(),
  process.env.REST_ENV_DIR,
].filter(Boolean) as string[];

// ---------------------------------------------------------------------------
// Bearer token management — chain: project .env → MCP config → session
// ---------------------------------------------------------------------------

/** Session-scoped token set via rest_set_token. Persists until server restart. */
let sessionBearerToken: string | null = null;

/**
 * Bearer token resolution chain (evaluated fresh on every request):
 *   1. Project .env file  (REST_BEARER_TOKEN) — supports live rotation
 *   2. MCP server config env var (REST_BEARER_TOKEN set at launch)
 *   3. Session token (set interactively via rest_set_token tool)
 */
function getBearerToken(): string {
  // 1. Project .env (read fresh every call)
  for (const dir of ENV_SEARCH_DIRS) {
    try {
      const envPath = resolve(dir, '.env');
      const content = readFileSync(envPath, 'utf-8');
      const match = content.match(/^REST_BEARER_TOKEN=(.+)$/m);
      if (match) {
        const token = match[1].trim().replace(/^["']|["']$/g, '');
        if (token) return token;
      }
    } catch {
      // file not found or unreadable — try next source
    }
  }

  // 2. MCP config env var (set when server was launched)
  if (CONFIG_BEARER_TOKEN) return CONFIG_BEARER_TOKEN;

  // 3. Session token (set via rest_set_token tool)
  if (sessionBearerToken) return sessionBearerToken;

  return '';
}

/** Identify where the current token comes from (for diagnostics / hints). */
function getTokenSource(): string {
  for (const dir of ENV_SEARCH_DIRS) {
    try {
      const envPath = resolve(dir, '.env');
      const content = readFileSync(envPath, 'utf-8');
      const match = content.match(/^REST_BEARER_TOKEN=(.+)$/m);
      if (match && match[1].trim().replace(/^["']|["']$/g, '')) {
        return `project .env (${envPath})`;
      }
    } catch { /* continue */ }
  }
  if (CONFIG_BEARER_TOKEN) return 'MCP server config env';
  if (sessionBearerToken) return 'session (rest_set_token)';
  return 'none';
}

// Collect HEADER_* env vars as custom headers
function getCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^header_/i.test(key) && value !== undefined) {
      headers[key.replace(/^header_/i, '')] = value;
    }
  }
  return headers;
}

const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, '');
const BASE = normalizeBaseUrl(REST_BASE_URL);

// ---------------------------------------------------------------------------
// Response analysis helpers
// ---------------------------------------------------------------------------

interface StructureNode {
  type: string;
  sample?: unknown;
  children?: Record<string, StructureNode>;
  itemStructure?: StructureNode;
  length?: number;
}

/** Recursively describe the shape of a JSON value (keys, types, array lengths). */
function describeStructure(value: unknown, depth = 0, maxDepth = 6): StructureNode {
  if (value === null) return { type: 'null', sample: null };
  if (value === undefined) return { type: 'undefined' };

  if (Array.isArray(value)) {
    const node: StructureNode = { type: 'array', length: value.length };
    if (value.length > 0 && depth < maxDepth) {
      node.itemStructure = describeStructure(value[0], depth + 1, maxDepth);
    }
    return node;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const children: Record<string, StructureNode> = {};
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, 80)) {
      children[key] = describeStructure(obj[key], depth + 1, maxDepth);
    }
    const node: StructureNode = { type: 'object', children };
    if (keys.length > 80) {
      (node as any)._truncatedKeys = keys.length;
    }
    return node;
  }

  // Primitive
  const t = typeof value;
  const sample = t === 'string' ? (value as string).slice(0, 120) : value;
  return { type: t, sample };
}

/** Build a compact summary: status, timing, top-level keys, array lengths. */
function buildCompactSummary(
  status: number,
  statusText: string,
  timing: number,
  body: unknown,
  headers: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`Status: ${status} ${statusText}`);
  lines.push(`Timing: ${timing}ms`);

  // Content-type from response
  const ct = headers['content-type'] || headers['Content-Type'];
  if (ct) lines.push(`Content-Type: ${ct}`);

  if (body === null || body === undefined) {
    lines.push('Body: (empty)');
    return lines.join('\n');
  }

  if (typeof body === 'string') {
    lines.push(`Body: string (${Buffer.from(body).length} bytes)`);
    return lines.join('\n');
  }

  if (Array.isArray(body)) {
    lines.push(`Body: array with ${body.length} items`);
    if (body.length > 0 && typeof body[0] === 'object' && body[0] !== null) {
      lines.push(`Item keys: ${Object.keys(body[0]).join(', ')}`);
    }
    return lines.join('\n');
  }

  if (typeof body === 'object') {
    const keys = Object.keys(body as object);
    lines.push(`Body: object with ${keys.length} keys`);
    lines.push(`Keys: ${keys.join(', ')}`);
    // Show array lengths for top-level array fields
    for (const k of keys) {
      const v = (body as any)[k];
      if (Array.isArray(v)) {
        lines.push(`  ${k}: array[${v.length}]`);
      }
    }
    return lines.join('\n');
  }

  lines.push(`Body: ${typeof body}`);
  return lines.join('\n');
}

/** Smart truncation: for JSON, truncate arrays instead of cutting mid-string. */
function smartTruncate(body: unknown, limit: number): { data: string; truncated: boolean; originalSize: number } {
  const raw = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const originalSize = Buffer.from(raw).length;

  if (originalSize <= limit) {
    return { data: raw, truncated: false, originalSize };
  }

  // For JSON objects/arrays, try to reduce array contents first
  if (typeof body === 'object' && body !== null) {
    try {
      const reduced = reducePayload(body, limit);
      const reducedStr = JSON.stringify(reduced, null, 2);
      if (Buffer.from(reducedStr).length <= limit) {
        return { data: reducedStr, truncated: true, originalSize };
      }
    } catch {
      // fall through to simple truncation
    }
  }

  // Simple truncation fallback
  return { data: raw.slice(0, limit), truncated: true, originalSize };
}

/** Reduce a JSON payload by slicing large arrays to fit within a size budget. */
function reducePayload(value: unknown, budget: number): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    // Keep at most a few items to stay within budget
    const maxItems = Math.min(value.length, 5);
    const sliced = value.slice(0, maxItems).map((item) => reducePayload(item, Math.floor(budget / maxItems)));
    if (value.length > maxItems) {
      (sliced as any).push(`... (${value.length - maxItems} more items)`);
    }
    return sliced;
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const key of keys) {
    result[key] = reducePayload(obj[key], Math.floor(budget / keys.length));
  }
  return result;
}

// ---------------------------------------------------------------------------
// TypeScript type generation from response structure
// ---------------------------------------------------------------------------

interface TypeGenResult {
  /** The type reference to use inline (e.g. "UserItem" or "string") */
  typeRef: string;
  /** Interface definitions that need to be emitted */
  interfaces: string[];
}

function toPascalCase(str: string): string {
  return str
    .replace(/[-_]+(.)/g, (_: string, c: string) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

/** Recursively generate TypeScript type references and interface definitions. */
function generateTypes(node: StructureNode, name: string): TypeGenResult {
  switch (node.type) {
    case 'string': return { typeRef: 'string', interfaces: [] };
    case 'number': return { typeRef: 'number', interfaces: [] };
    case 'boolean': return { typeRef: 'boolean', interfaces: [] };
    case 'null': return { typeRef: 'unknown | null', interfaces: [] };
    case 'undefined': return { typeRef: 'unknown', interfaces: [] };

    case 'array': {
      if (!node.itemStructure) return { typeRef: 'unknown[]', interfaces: [] };
      const item = generateTypes(node.itemStructure, name + 'Item');
      return { typeRef: `${item.typeRef}[]`, interfaces: item.interfaces };
    }

    case 'object': {
      if (!node.children || Object.keys(node.children).length === 0) {
        return { typeRef: 'Record<string, unknown>', interfaces: [] };
      }
      const allInterfaces: string[] = [];
      const fields: string[] = [];

      for (const [key, child] of Object.entries(node.children)) {
        const safeKey = /^[a-zA-Z_$]\w*$/.test(key) ? key : `'${key}'`;
        const childTypeName = name + toPascalCase(key);
        const result = generateTypes(child, childTypeName);
        allInterfaces.push(...result.interfaces);
        fields.push(`  ${safeKey}: ${result.typeRef};`);
      }

      const iface = `export interface ${name} {\n${fields.join('\n')}\n}`;
      allInterfaces.push(iface);
      return { typeRef: name, interfaces: allInterfaces };
    }

    default: return { typeRef: 'unknown', interfaces: [] };
  }
}

/** Build complete TypeScript definitions from a response structure. */
function buildTypeScript(structure: StructureNode, rootName: string = 'ApiResponse'): string {
  if (structure.type === 'array' && structure.itemStructure) {
    const result = generateTypes(structure.itemStructure, rootName + 'Item');
    const lines = [...result.interfaces];
    lines.push(`\nexport type ${rootName} = ${result.typeRef}[];`);
    return lines.join('\n\n');
  }

  const result = generateTypes(structure, rootName);
  return result.interfaces.join('\n\n');
}

// ---------------------------------------------------------------------------
// Auth hint helper (attached to responses on 401/403 when no token)
// ---------------------------------------------------------------------------

function buildAuthHint(status: number): Record<string, unknown> | null {
  if ((status === 401 || status === 403) && getTokenSource() === 'none') {
    return {
      status: 'NO_TOKEN',
      message: 'Authentication failed. No bearer token is configured.',
      resolution: [
        '1. Add REST_BEARER_TOKEN=<your-token> to the project .env file',
        '2. Or configure REST_BEARER_TOKEN in the MCP server env vars',
        '3. Or call rest_set_token with the token to set it for this session',
      ],
      ask_user: 'Ask the user for their API bearer token, then call rest_set_token to store it for the session.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP request helper (native fetch – no extra deps)
// ---------------------------------------------------------------------------

interface RequestArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  endpoint: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

function validateArgs(args: unknown): asserts args is RequestArgs {
  if (typeof args !== 'object' || args === null) {
    throw new McpError(ErrorCode.InvalidParams, 'Arguments must be an object');
  }
  const a = args as any;
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  if (!methods.includes(a.method)) {
    throw new McpError(ErrorCode.InvalidParams, `method must be one of: ${methods.join(', ')}`);
  }
  if (typeof a.endpoint !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'endpoint must be a string path, e.g. "/users"');
  }
  if (/^https?:\/\//i.test(a.endpoint)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Do not include full URLs in endpoint. Use just the path (e.g. "/api/users"). It will be resolved to: ${BASE}${a.endpoint}`,
    );
  }
}

async function executeRequest(args: RequestArgs) {
  const normalizedEndpoint = `/${args.endpoint.replace(/^\/+|\/+$/g, '')}`;

  // Build query string
  let qs = '';
  if (args.query && Object.keys(args.query).length > 0) {
    const params = new URLSearchParams(args.query);
    qs = `?${params.toString()}`;
  }

  const url = `${BASE}${normalizedEndpoint}${qs}`;

  // Merge headers: custom globals < per-request < auth
  const mergedHeaders: Record<string, string> = {
    ...getCustomHeaders(),
    ...(args.headers || {}),
  };

  // Inject bearer token (fresh read on every call)
  const token = getBearerToken();
  if (token) {
    mergedHeaders['Authorization'] = `Bearer ${token}`;
  }

  // Build fetch options
  const init: RequestInit = {
    method: args.method,
    headers: mergedHeaders,
  };

  if (['POST', 'PUT', 'PATCH'].includes(args.method) && args.body !== undefined) {
    if (typeof args.body === 'string') {
      init.body = args.body;
    } else {
      init.body = JSON.stringify(args.body);
      if (!mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    }
  }

  const start = Date.now();
  const response = await fetch(url, init);
  const timing = Date.now() - start;

  // Read response
  const contentType = response.headers.get('content-type') || '';
  let body: unknown;
  const rawText = await response.text();

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = rawText;
    }
  } else {
    body = rawText;
  }

  // Collect response headers
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });

  return { url, status: response.status, statusText: response.statusText, timing, body, responseHeaders, rawSize: Buffer.from(rawText).length };
}

// ---------------------------------------------------------------------------
// Field extraction helper
// ---------------------------------------------------------------------------

function extractField(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // Handle array iteration: "items[]" or "items[].field"
    const arrayMatch = part.match(/^(\w+)\[\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const arr = (current as any)[key];
      if (!Array.isArray(arr)) return undefined;
      // If there are remaining parts, extract from each item
      const remaining = parts.slice(parts.indexOf(part) + 1).join('.');
      if (remaining) {
        return arr.map((item) => extractField(item, remaining));
      }
      return arr;
    }

    current = (current as any)[part];
  }

  return current;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'rest-api-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const customHeadersList = Object.entries(getCustomHeaders())
  .map(([k, v]) => `${k}: ${v}`)
  .join(', ');

const tokenChainInfo = 'Token resolution: 1) project .env REST_BEARER_TOKEN, 2) MCP config env var, 3) session token via rest_set_token. If none found on 401/403, ask the user for a token.';

const contextResolutionGuidance = `
AUTONOMOUS CONTEXT RESOLUTION — When the endpoint comes from code analysis (feature-port, migration, Vuex store dispatch, API service file):
DO NOT call blindly with missing parameters. First investigate the source code context:
1. Path params (:id, :slug) — find actual values in component data, props, route params, or hardcoded in the store action
2. Query params — inspect the Vuex action, API service call, or component for the params/query object passed to the request
3. Request body — check what payload is dispatched or composed in the action
4. If a value is purely dynamic (e.g. user-selected at runtime), use a representative test value and document the assumption.
The goal is to make a real API call that returns representative data for type extraction.`.trim();

const typeExtractionGuidance = 'PRIMARY PURPOSE: The main goal of API response analysis is to derive TypeScript type definitions. Always present the generated TypeScript interfaces without being asked — this is the expected output for feature ports and migrations.';

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // -----------------------------------------------------------------------
    // rest_set_token — set session bearer token
    // -----------------------------------------------------------------------
    {
      name: 'rest_set_token',
      description: `Set the bearer token for this session (persists until server restart). ${tokenChainInfo}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          token: {
            type: 'string',
            description: 'The bearer token value (without "Bearer " prefix)',
          },
        },
        required: ['token'],
      },
    },
    // -----------------------------------------------------------------------
    // rest_request — full response
    // -----------------------------------------------------------------------
    {
      name: 'rest_request',
      description: `Execute an HTTP request and return the full response (smart-truncated if large). Base URL: ${BASE} | ${tokenChainInfo}${customHeadersList ? ` | Custom headers: ${customHeadersList}` : ''}. Responses over ${RESPONSE_SIZE_LIMIT} bytes are smart-truncated. Use rest_describe for structure only, or rest_types for TypeScript interfaces. ${contextResolutionGuidance}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP method',
          },
          endpoint: {
            type: 'string',
            description: `Path only (e.g. "/users"). Resolved to: ${BASE}/...`,
          },
          body: {
            description: 'Request body (for POST/PUT/PATCH). Object auto-serialized as JSON.',
          },
          headers: {
            type: 'object',
            description: 'Additional request headers (one-time, merged with configured globals)',
            additionalProperties: { type: 'string' },
          },
          query: {
            type: 'object',
            description: 'Query string parameters as key-value pairs',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['method', 'endpoint'],
      },
    },
    // -----------------------------------------------------------------------
    // rest_describe — structure + TypeScript types (no full body)
    // -----------------------------------------------------------------------
    {
      name: 'rest_describe',
      description: `Execute an HTTP request and return the response structure (keys, types, array lengths) AND generated TypeScript interfaces — without the full body. Ideal for large responses. ${typeExtractionGuidance} Base URL: ${BASE}. ${contextResolutionGuidance}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP method',
          },
          endpoint: {
            type: 'string',
            description: `Path only (e.g. "/users"). Resolved to: ${BASE}/...`,
          },
          body: {
            description: 'Request body (for POST/PUT/PATCH)',
          },
          headers: {
            type: 'object',
            description: 'Additional request headers',
            additionalProperties: { type: 'string' },
          },
          query: {
            type: 'object',
            description: 'Query string parameters',
            additionalProperties: { type: 'string' },
          },
          typeName: {
            type: 'string',
            description: 'Root interface name for generated TypeScript (default: "ApiResponse")',
          },
        },
        required: ['method', 'endpoint'],
      },
    },
    // -----------------------------------------------------------------------
    // rest_types — TypeScript interfaces only (primary tool for migrations)
    // -----------------------------------------------------------------------
    {
      name: 'rest_types',
      description: `Execute an HTTP request and generate TypeScript interfaces from the response structure. This is the PRIMARY tool for feature-port and migration workflows — returns clean, ready-to-use TypeScript interfaces. ${typeExtractionGuidance} Base URL: ${BASE}. ${contextResolutionGuidance}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP method',
          },
          endpoint: {
            type: 'string',
            description: `Path only (e.g. "/users"). Resolved to: ${BASE}/...`,
          },
          body: {
            description: 'Request body (for POST/PUT/PATCH)',
          },
          headers: {
            type: 'object',
            description: 'Additional request headers',
            additionalProperties: { type: 'string' },
          },
          query: {
            type: 'object',
            description: 'Query string parameters',
            additionalProperties: { type: 'string' },
          },
          typeName: {
            type: 'string',
            description: 'Root interface name (default: "ApiResponse"). Use a domain-specific name like "User", "BookingList", etc.',
          },
        },
        required: ['method', 'endpoint'],
      },
    },
    // -----------------------------------------------------------------------
    // rest_extract — extract specific fields
    // -----------------------------------------------------------------------
    {
      name: 'rest_extract',
      description: `Execute an HTTP request, then extract specific fields using dot-notation paths. Returns only the extracted data. Example: fields ["data.items[].name", "meta.total"]. Base URL: ${BASE}. ${contextResolutionGuidance}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP method',
          },
          endpoint: {
            type: 'string',
            description: `Path only (e.g. "/users")`,
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Dot-notation paths to extract, e.g. ["data.id", "data.items[].name", "meta.total"]. Use [] to iterate array items.',
          },
          body: {
            description: 'Request body (for POST/PUT/PATCH)',
          },
          headers: {
            type: 'object',
            description: 'Additional request headers',
            additionalProperties: { type: 'string' },
          },
          query: {
            type: 'object',
            description: 'Query string parameters',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['method', 'endpoint', 'fields'],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ------- rest_set_token -------
  if (name === 'rest_set_token') {
    const a = args as any;
    if (!a?.token || typeof a.token !== 'string' || !a.token.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'token must be a non-empty string');
    }
    const token = a.token.trim();
    sessionBearerToken = token;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: 'Bearer token set for this session.',
          tokenPreview: `${token.slice(0, 8)}...${token.slice(-4)}`,
          source: 'session (rest_set_token)',
        }, null, 2),
      }],
    };
  }

  // ------- rest_request -------
  if (name === 'rest_request') {
    validateArgs(args);
    const typedArgs = args as RequestArgs;

    try {
      const res = await executeRequest(typedArgs);
      const { data, truncated, originalSize } = smartTruncate(res.body, RESPONSE_SIZE_LIMIT);

      const result: any = {
        request: { url: res.url, method: typedArgs.method },
        response: {
          statusCode: res.status,
          statusText: res.statusText,
          timing: `${res.timing}ms`,
          headers: res.responseHeaders,
          body: typeof res.body === 'string' ? data : JSON.parse(data),
        },
      };

      if (truncated) {
        result.response._truncation = {
          originalSize,
          returnedSize: Buffer.from(data).length,
          sizeLimit: RESPONSE_SIZE_LIMIT,
          hint: 'Response was truncated. Use rest_describe to see structure + TypeScript types, or rest_extract to get specific fields.',
        };
      }

      const authHint = buildAuthHint(res.status);
      if (authHint) result._auth = authHint;

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: res.status >= 400,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { message: error.message, code: error.code } }, null, 2) }],
        isError: true,
      };
    }
  }

  // ------- rest_describe -------
  if (name === 'rest_describe') {
    validateArgs(args);
    const typedArgs = args as RequestArgs;
    const typeName = (args as any).typeName || 'ApiResponse';

    try {
      const res = await executeRequest(typedArgs);
      const summary = buildCompactSummary(res.status, res.statusText, res.timing, res.body, res.responseHeaders);
      const structure = describeStructure(res.body);
      const typescript = buildTypeScript(structure, typeName);

      const result: any = {
        request: { url: res.url, method: typedArgs.method },
        summary,
        rawSize: `${res.rawSize} bytes`,
        structure,
        typescript,
      };

      const authHint = buildAuthHint(res.status);
      if (authHint) result._auth = authHint;

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: res.status >= 400,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { message: error.message, code: error.code } }, null, 2) }],
        isError: true,
      };
    }
  }

  // ------- rest_types -------
  if (name === 'rest_types') {
    validateArgs(args);
    const typedArgs = args as RequestArgs;
    const typeName = (args as any).typeName || 'ApiResponse';

    try {
      const res = await executeRequest(typedArgs);
      const structure = describeStructure(res.body);
      const typescript = buildTypeScript(structure, typeName);

      const result: any = {
        request: { url: res.url, method: typedArgs.method },
        status: res.status,
        timing: `${res.timing}ms`,
        typescript,
        _hint: 'These TypeScript interfaces are derived from a live API response. Verify nullable fields and optional properties against your domain knowledge.',
      };

      const authHint = buildAuthHint(res.status);
      if (authHint) result._auth = authHint;

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: res.status >= 400,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { message: error.message, code: error.code } }, null, 2) }],
        isError: true,
      };
    }
  }

  // ------- rest_extract -------
  if (name === 'rest_extract') {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Arguments required');
    }
    const a = args as any;
    validateArgs({ method: a.method, endpoint: a.endpoint, body: a.body, headers: a.headers, query: a.query });

    const fields: string[] = a.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'fields must be a non-empty array of dot-notation paths');
    }

    try {
      const res = await executeRequest({
        method: a.method,
        endpoint: a.endpoint,
        body: a.body,
        headers: a.headers,
        query: a.query,
      });

      const extracted: Record<string, unknown> = {};
      for (const field of fields) {
        extracted[field] = extractField(res.body, field);
      }

      const result: any = {
        request: { url: res.url, method: a.method },
        status: res.status,
        timing: `${res.timing}ms`,
        extracted,
      };

      const authHint = buildAuthHint(res.status);
      if (authHint) result._auth = authHint;

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: res.status >= 400,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { message: error.message, code: error.code } }, null, 2) }],
        isError: true,
      };
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`rest-api-mcp running | base: ${BASE} | token: ${getTokenSource()}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
