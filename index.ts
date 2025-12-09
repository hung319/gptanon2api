/**
 * =================================================================================
 * Project: gptanon-2api (Bun Edition)
 * Description: Proxy server chuyển đổi API gptanon sang chuẩn OpenAI.
 * Runtime: Bun v1.0+
 * Author: CezDev (Refactored from Cloudflare Worker)
 * =================================================================================
 */

// --- [1. Configuration] ---
const CONFIG = {
  PORT: Bun.env.PORT || 3000,
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "1", // Fallback only for dev
  
  UPSTREAM_URL: Bun.env.UPSTREAM_URL || "https://www.gptanon.com/api/chat/stream",
  UPSTREAM_ORIGIN: Bun.env.UPSTREAM_ORIGIN || "https://www.gptanon.com",
  
  // Model mapping (Giữ nguyên danh sách gốc)
  MODELS: [
    "openai/gpt-5.1-chat",
    "x-ai/grok-4.1-fast",
    "x-ai/grok-3-mini",
    "deepseek/deepseek-prover-v2",
    "openai/gpt-4.1",
    "openai/o1-pro",
    "google/gemini-2.0-flash-001",
    "perplexity/sonar-reasoning",
    "perplexity/sonar",
    "perplexity/sonar-deep-research"
  ],
  DEFAULT_MODEL: "x-ai/grok-4.1-fast",
};

// --- [2. Server Entry Point] ---
console.log(`🚀 Server running at http://localhost:${CONFIG.PORT}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS Handling
    if (req.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. Authentication Check (Middleware logic)
    // Chỉ áp dụng auth cho các endpoints API, bỏ qua root nếu muốn healthcheck
    if (url.pathname.startsWith('/v1/')) {
        const authError = validateAuth(req);
        if (authError) return authError;
    }

    // 3. Routing
    if (url.pathname === '/v1/models') {
      return handleModelsRequest();
    } 
    
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const requestId = `chatcmpl-${crypto.randomUUID()}`;
      return handleChatCompletions(req, requestId);
    }

    // 4. Fallback / 404
    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  },
});

// --- [3. Core Logic Handlers] ---

/**
 * Xác thực Bearer Token
 */
function validateAuth(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return createErrorResponse('Missing or invalid Authorization header.', 401, 'unauthorized');
  }
  const token = authHeader.substring(7);
  if (token !== CONFIG.API_MASTER_KEY) {
    return createErrorResponse('Invalid API Key.', 403, 'invalid_api_key');
  }
  return null; // OK
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'gptanon-2api-bun',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

async function handleChatCompletions(req, requestId) {
  try {
    const requestData = await req.json();
    const upstreamPayload = transformRequestToUpstream(requestData);

    const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': CONFIG.UPSTREAM_ORIGIN,
        'Referer': `${CONFIG.UPSTREAM_ORIGIN}/chat`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify(upstreamPayload),
    });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      console.error(`[Upstream Error] ${upstreamResponse.status}: ${errorBody}`);
      return createErrorResponse(`Upstream error: ${upstreamResponse.status}`, upstreamResponse.status, 'upstream_error');
    }

    const contentType = upstreamResponse.headers.get('content-type');
    const isStream = requestData.stream !== false && contentType && contentType.includes('text/event-stream');

    if (isStream) {
      // --- STREAMING MODE ---
      const transformStream = createUpstreamToOpenAIStream(requestId, requestData.model || CONFIG.DEFAULT_MODEL);
      
      // Bun hỗ trợ trực tiếp việc trả về ReadableStream trong Response
      return new Response(upstreamResponse.body.pipeThrough(transformStream), {
        headers: corsHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Trace-ID': requestId,
        }),
      });
    } else {
      // --- NON-STREAMING MODE ---
      const fullBody = await upstreamResponse.text();
      const openAIResponse = transformNonStreamResponse(fullBody, requestId, requestData.model || CONFIG.DEFAULT_MODEL);
      return new Response(JSON.stringify(openAIResponse), {
        headers: corsHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'X-Trace-ID': requestId,
        }),
      });
    }

  } catch (e) {
    console.error(`[Internal Error] ${e.message}`);
    return createErrorResponse(`Internal Server Error: ${e.message}`, 500, 'internal_server_error');
  }
}

// --- [4. Data Transformation Utilities] ---

function transformRequestToUpstream(requestData) {
  const messages = requestData.messages || [];
  const lastUserMessage = messages.filter(m => m.role === 'user').pop();

  return {
    message: lastUserMessage ? lastUserMessage.content : "Hello",
    modelIds: [requestData.model || CONFIG.DEFAULT_MODEL],
    deepSearchEnabled: false,
  };
}

/**
 * Chuyển đổi SSE của upstream sang định dạng OpenAI
 */
function createUpstreamToOpenAIStream(requestId, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Giữ lại phần chưa hoàn thiện

      for (const line of lines) {
        if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          if (!dataStr) continue;
          
          try {
            const data = JSON.parse(dataStr);
            let content = null;
            let finish_reason = null;

            if (data.type === 'token' && data.token) {
              content = data.token;
            } else if (data.type === 'done') {
              finish_reason = 'stop';
            }

            if (content !== null || finish_reason) {
              const openAIChunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: content ? { content: content } : {},
                  finish_reason: finish_reason,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}

function transformNonStreamResponse(fullBody, requestId, model) {
    let fullContent = '';
    const lines = fullBody.split('\n');
    for (const line of lines) {
        if (line.startsWith('data:')) {
            const dataStr = line.substring(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
                const data = JSON.parse(dataStr);
                if (data.type === 'complete' && data.content) {
                    fullContent = data.content;
                    break;
                }
                if (data.type === 'token' && data.token) {
                    fullContent += data.token;
                }
            } catch (e) {}
        }
    }

    return {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

// --- [5. Helper Functions] ---

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
}
