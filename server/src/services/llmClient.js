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
      const retries = Math.max(0, llmConfig.retries ?? LLM_LIMITS.retries);
      const body = JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        temperature: llmConfig.temperature ?? 0.3,
        max_tokens: maxTokens ?? llmConfig.maxTokens ?? LLM_LIMITS.chatMaxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        // 供应商私有开关透传 (config.json 的 llm.extraBody): 如 DeepSeek 的 reasoning_effort。
        // 放最后 = 可覆盖上面任何字段 —— 换供应商时不必改代码, 但也不要在这里塞协议外的结构。
        ...(llmConfig.extraBody && typeof llmConfig.extraBody === 'object' ? llmConfig.extraBody : {}),
      });

      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          // 退避后重试: 只在"这一次可能就好了"的错误上花时间 (见 LLM_LIMITS.retryableStatus)
          const wait = LLM_LIMITS.retryBackoffMs * 2 ** (attempt - 1);
          console.warn(`[llm] 第 ${attempt}/${retries} 次重试 (${wait}ms 后): ${lastErr?.message?.slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, wait));
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
            body,
            signal: controller.signal,
          });
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            const err = new Error(`LLM 请求失败 ${resp.status}: ${text.slice(0, 300)}`);
            // 语义错 (4xx) 重试也不会变好, 直接抛; 瞬时故障才进下一轮
            if (!LLM_LIMITS.retryableStatus.includes(resp.status)) throw err;
            err.retryable = true;
            lastErr = err;
            continue;
          }
          const data = await resp.json();
          const content = data?.choices?.[0]?.message?.content;
          if (!content) {
            // 空壳响应同样是瞬时现象, 但它已经 200 了 —— 重试而不再加判断, 交给统一逻辑
            lastErr = new Error('LLM 返回为空');
            lastErr.retryable = true;
            continue;
          }
          return content;
        } catch (err) {
          if (err?.retryable) { lastErr = err; continue; }   // 上面已判定瞬时
          if (err?.name === 'AbortError') {
            lastErr = new Error(`LLM 请求超时 (${llmConfig.timeoutMs ?? 60000}ms)`);
            lastErr.retryable = true;
            continue;
          }
          if (err instanceof TypeError) {                     // fetch 网络层失败 (DNS/连接重置)
            lastErr = new Error(`LLM 网络错误: ${err.message}`);
            lastErr.retryable = true;
            continue;
          }
          throw err;                                          // 语义错: 立即抛, 不留悬念
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastErr ?? new Error('LLM 请求失败');
    },
  };
}
