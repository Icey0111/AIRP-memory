// embedding 客户端: OpenAI 兼容 /embeddings + mock 通道
// 与 llmClient 同构: service 只依赖 { embed(texts), model } 接口
// BLOB 序列化: Float32 小端数组, pack/unpack 成对使用

// ---------- BLOB 序列化 ----------
export function packVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function unpackVector(buf) {
  if (!buf) return null;
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- mock 通道: 字符二元组哈希向量 (确定性, 文本越相似余弦越高) ----------
function mockEmbed(text, dim) {
  const vec = new Array(dim).fill(0);
  const s = ` ${text} `;
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    let h = 0;
    for (const ch of bg) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    vec[h % dim] += (h & 0x100) ? 1 : -1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// ---------- 工厂 ----------
export function createEmbeddingClient(cfg) {
  if (cfg.provider === 'mock') {
    const dim = cfg.mockDim ?? 128;
    return {
      model: 'mock-bigram',
      dim,
      describe() {
        return {
          provider: 'mock', configured: true, model: 'mock-bigram', dim,
          timeoutMs: cfg.timeoutMs ?? 60000, batchSize: cfg.batchSize ?? 32, reason: null,
        };
      },
      async embed(texts) {
        return texts.map((t) => mockEmbed(String(t), dim));
      },
    };
  }

  const { baseUrl, apiKey, model } = cfg;
  const configured = Boolean(baseUrl && apiKey && model);

  // OpenAI 兼容通道 (官方 / SiliconFlow / 中转网关均可)
  return {
    model: cfg.model,
    dim: null, // 由首次返回决定
    describe() {
      return {
        provider: 'openai-compatible',
        configured,
        model: model || null,
        dim: null,
        timeoutMs: cfg.timeoutMs ?? 60000,
        batchSize: cfg.batchSize ?? 32,
        reason: configured ? null : '未配置 baseUrl/apiKey/model',
      };
    },
    async embed(texts) {
      if (!configured) {
        throw new Error('embedding 未配置完整 (baseUrl/apiKey/model), 请编辑 server/config.json');
      }
      const batchSize = cfg.batchSize ?? 32;
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 60000);
        try {
          const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, input: batch }),
            signal: controller.signal,
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`embedding 请求失败 ${resp.status}: ${body.slice(0, 300)}`);
          }
          const data = await resp.json();
          const items = (data?.data ?? []).sort((a, b) => a.index - b.index);
          if (items.length !== batch.length) {
            throw new Error(`embedding 返回数量不符: 期望 ${batch.length}, 实际 ${items.length}`);
          }
          for (const it of items) out.push(it.embedding);
        } finally {
          clearTimeout(timer);
        }
      }
      return out;
    },
  };
}
