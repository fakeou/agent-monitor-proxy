/**
 * Agent Monitor Proxy — Anthropic API Parser
 *
 * Parses Anthropic Messages API requests and responses.
 * Reference: https://docs.anthropic.com/en/api/messages
 */

export interface AnthropicRequestMeta {
  model?: string
  messageCount: number
  maxTokens?: number
  systemPromptLength?: number
  toolNames?: string[]
  stream?: boolean
}

export interface AnthropicResponseMeta {
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  model?: string
  hasToolUse: boolean
  toolNames?: string[]
  contentLength?: number
}

/**
 * Parse an Anthropic Messages API request body.
 */
export function parseAnthropicRequest(body: Record<string, unknown>): AnthropicRequestMeta {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []

  let systemPromptLength = 0
  if (typeof body.system === 'string') {
    systemPromptLength = body.system.length
  } else if (Array.isArray(body.system)) {
    systemPromptLength = (body.system as Array<{ text?: string }>)
      .reduce((acc, block) => acc + (block.text?.length ?? 0), 0)
  }

  return {
    model: body.model as string | undefined,
    messageCount: messages.length,
    maxTokens: body.max_tokens as number | undefined,
    systemPromptLength,
    toolNames: tools.map((t: { name?: string }) => t.name).filter(Boolean) as string[],
    stream: body.stream as boolean | undefined,
  }
}

/**
 * Parse an Anthropic Messages API response body.
 */
export function parseAnthropicResponse(body: Record<string, unknown>): AnthropicResponseMeta {
  const content = Array.isArray(body.content) ? body.content : []
  const toolUseBlocks = content.filter((c: { type?: string }) => c.type === 'tool_use')
  const usage = (body.usage ?? {}) as Record<string, number>

  return {
    stopReason: body.stop_reason as string | undefined,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    model: body.model as string | undefined,
    hasToolUse: toolUseBlocks.length > 0,
    toolNames: toolUseBlocks.map((t: { name?: string }) => t.name).filter(Boolean) as string[],
    contentLength: content.reduce(
      (acc: number, c: { text?: string }) => acc + (c.text?.length ?? 0),
      0,
    ),
  }
}
