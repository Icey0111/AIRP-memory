// 访问令牌鉴权 (可选): 让服务安全地离开 127.0.0.1, 服务局域网/手机访问
//
// 背景: 服务本身无用户体系, 绑定 127.0.0.1 时"回环 = 信任"。一旦为了手机/局域网
// 访问改绑 0.0.0.0, "能连上 = 能读写整个记忆库 + 能改模型配置", 私网内任何人都可以。
// docs/frontend-v0.md 早已预留方案: **后端持有上游密钥, 前端只带一个可撤销的令牌**。
//
// 规则:
//   - server.token 为空 => 不启用 (本机回环场景零配置, 行为与以往完全一致)
//   - 非空 => 除 /health 外全部要求请求头 X-TM-Token 精确匹配 (常量时间比较)
//   - 401 响应体 {ok:false, error}, 与全站错误口径一致, 前端原样展示
import { timingSafeEqual } from 'node:crypto';

export function createTokenAuth(token) {
  const expected = String(token ?? '').trim();
  if (!expected) return null;                       // 未启用
  const expectedBuf = Buffer.from(expected);

  return function tokenAuth(req, res, next) {
    if (req.path === '/health') return next();      // 存活探针免检 (不携带任何数据)
    const got = String(req.headers['x-tm-token'] ?? '');
    const gotBuf = Buffer.from(got);
    const ok = gotBuf.length === expectedBuf.length && timingSafeEqual(gotBuf, expectedBuf);
    if (ok) return next();
    res.status(401).json({
      ok: false,
      error: '需要访问令牌: 请求头 X-TM-Token 缺失或不正确 (面板"访问令牌"处填写 server.token 的值)',
    });
  };
}
