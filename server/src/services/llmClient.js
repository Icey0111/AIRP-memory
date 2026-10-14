// LLM 客户端: OpenAI 兼容协议 + mock 通道
// 依赖注入设计: service 只依赖 { chat({system, user}) } 接口, 不绑定 provider
// describe(): 自描述能力, 供 GET /api/meta 汇总对外呈现 (不外泄 apiKey)
import { LLM_LIMITS } from '../domain/constants.js';

export function createLlmClient(llmConfig) {
  // mock 通道: 离线开发/测试用, 直接返回配置的固定内容
  if (llmConfig.provider === 'mock') {
    return {
      describe() {
        return {
          provider: 'mock', configured: true, model: 'mock',
          timeoutMs: llmConfig.timeoutMs ?? 60000, reason: null,
        };
      },
      async chat() {
        if (!llmConfig.mockResponse) {
          throw new Error('mock 模式需在 config.json 的 llm.mockResponse 配置返回内容');
        }
        return llmConfig.mockResponse;
      },
    };
  }

  const { baseUrl, apiKey, model } = llmConfig;
  const configured = Boolean(baseUrl && apiKey && model);

  // OpenAI 兼容通道 (官方 / DeepSeek / 各类中转网关均可)
  return {
    describe() {
      return {
        provider: 'openai-compatible',
        configured,
        model: model || null,
        // 前端据此推算自己的 fetch 超时 (需大于服务端 LLM 超时, 留出余量), 避免前端写死数字
        timeoutMs: llmConfig.timeoutMs ?? 60000,
        reason: configured ? null : '未配置 baseUrl/apiKey/model',
      };
    },
    // maxTokens 按调用可覆盖: 六要素抽取的输出体量远超网关默认 (截断=JSON 解析失败=整步丢弃)
    async chat({ system, user, jsonMode = true, maxTokens = null }) {
      if (!configured) {
        throw new Error('llm 未配置完整 (baseUrl/apiKey/model), 请编辑 server/config.json');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), llmConfig.timeoutMs ?? 60000);
      try {
        const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: user },
            ],
            temperature: llmConfig.temperature ?? 0.3,
            max_tokens: maxTokens ?? llmConfig.maxTokens ?? LLM_LIMITS.chatMaxTokens,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`LLM 请求失败 ${resp.status}: ${body.slice(0, 300)}`);
        }
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('LLM 返回为空');
        return content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
