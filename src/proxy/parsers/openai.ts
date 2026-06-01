/**
 * Agent Monitor Proxy — OpenAI API Parser
 *
 * Parses OpenAI Chat Completions API requests and responses.
 * Reference: https://platform.openai.com/docs/api-reference/chat
 */

export interface OpenAIRequestMeta {
  model?: string
  messageCount: number
  maxTokens?: number
  toolNames?: string[]
  stream?: boolean
}

export interface OpenAIResponseMeta {
  finishReason?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  model?: string
  hasToolCall: boolean
  toolNames?: string[]
  contentLength?: number
}

/**
 * Parse an OpenAI Chat Completions request body.
 */
export function parseOpenAIRequest(body: Record<string, unknown>): OpenAIRequestMeta {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []

  return {
    model: body.model as string | undefined,
    messageCount: messages.length,
    maxTokens: body.max_tokens as number | undefined,
    toolNames: tools
      .map((t: { function?: { name?: string } }) => t.function?.name)
      .filter(Boolean) as string[],
    stream: body.stream as boolean | undefined,
  }
}

/**
 * Parse an OpenAI Chat Completions response body.
 */
export function parseOpenAIResponse(body: Record<string, unknown>): OpenAIResponseMeta {
  const choices = Array.isArray(body.choices) ? body.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const message = (firstChoice?.message ?? {}) as Record<string, unknown>
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const usage = (body.usage ?? {}) as Record<string, number>

  const content = typeof message.content === 'string' ? message.content : ''

  return {
    finishReason: firstChoice?.finish_reason as string | undefined,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    model: body.model as string | undefined,
    hasToolCall: toolCalls.length > 0,
    toolNames: toolCalls
      .map((tc: { function?: { name?: string } }) => tc.function?.name)
      .filter(Boolean) as string[],
    contentLength: content.length,
  }
}
