// 最小 CORS: 供酒馆前端扩展从 http(s)://<本机>:8000 跨源调用本服务 (默认 7780)
//
// 策略:
//   - 只放行"本机来源": localhost / 127.0.0.1 / [::1], 任意端口 (酒馆端口可能不是 8000)
//   - 外加 config.server.cors.origins 显式白名单 (如反向代理到局域网域名/私网 IP 的场景)
//   - 绝不放行 '*' —— 本服务无鉴权, 通配会把整个记忆库暴露给任意网页
//
// 这是前端能工作的前提: 酒馆页面与记忆服务不同源, 浏览器会拦截无 CORS 头的响应。

// *.localhost 子域: Tauri 系桌面客户端的 webview 源是 http://tauri.localhost ——
// 主机名不是裸 localhost, 但 RFC 6761 规定 *.localhost 与 localhost 同样指向本机, 等价可信
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:[\w-]+\.)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

const ALLOW_METHODS = 'GET,POST,PATCH,PUT,DELETE,OPTIONS';
// X-TM-Token: 访问令牌鉴权 (server.token 非空时启用) —— 必须进预检许可, 否则
// 局域网/手机场景下前端带着令牌的请求会被预检拦下
const ALLOW_HEADERS = 'Content-Type, X-TM-Token';

export function createCorsMiddleware({ enabled = true, origins = [] } = {}) {
  const extra = new Set((origins ?? []).map((o) => String(o).trim()).filter(Boolean));

  return function cors(req, res, next) {
    const origin = req.headers.origin;
    if (!enabled || !origin) return next();

    const allowed = extra.has(origin) || LOCAL_ORIGIN_RE.test(origin);
    if (!allowed) {
      // 预检直接拒绝; 普通请求照常处理, 只是不带 CORS 头 (浏览器自行拦截响应)
      if (req.method === 'OPTIONS') return res.sendStatus(403);
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    // 页面位于私网地址、服务位于本机时的额外许可 (Chrome Private Network Access)
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}

/** 供 /api/meta 如实报告当前生效的 CORS 策略 (不是文档承诺, 是运行时事实) */
export function describeCors({ enabled = true, origins = [] } = {}, { tokenRequired = false } = {}) {
  return {
    enabled,
    allowLoopbackAnyPort: enabled,
    extraOrigins: (origins ?? []).map(String),
    /** 令牌鉴权是否启用 (server.token 非空); 前端据此提示"局域网访问需要填令牌" */
    tokenRequired,
  };
}
