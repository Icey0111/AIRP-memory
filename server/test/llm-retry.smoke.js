// LLM 客户端瞬时故障重试冒烟测试。
//
// 为什么需要 (实测事故): 抽取网关整段返回 502, 三层抽取全灭, 一整场戏一行未落库。
// 每轮编织只有一次调用机会 —— 网关抖 1 秒, 代价是整轮记忆丢失。
// 这里用本地 http 服务把"抖"复现出来, 钉住:
//   1) 502/503/504/429 与网络错误会重试, 抖完就好
//   2) 4xx 语义错 (如模型名写错) 不重试, 立即抛出 (重试只会白等)
//   3) 重试次数用尽后如实抛出最后一次的错误 (不假装成功)
// 运行: node test/llm-retry.smoke.js
import http from 'node:http';
import { createLlmClient } from '../src/services/llmClient.js';
import { LLM_LIMITS } from '../src/domain/constants.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};

/** 起一个按脚本应答的假网关: script 里每项是一次请求的响应; 顺带记下收到的请求体与头 */
function fakeGateway(script) {
  let hits = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { seen.push({ body: JSON.parse(raw), auth: req.headers.authorization }); } catch { seen.push({ raw }); }
      const step = script[Math.min(hits, script.length - 1)];
      hits++;
      if (step.status >= 500) {   // 复现网关的 HTML 错误页 (真实 502 就长这样)
        res.writeHead(step.status, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>error code: 502</body></html>');
        return;
      }
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(step.status === 200
        ? { choices: [{ message: { content: step.content ?? '{"ok":true}' } }] }
        : { error: { message: 'bad request' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      hits: () => hits,
      seen,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const client = (port, extra = {}) => createLlmClient({
  provider: 'openai-compatible',
  baseUrl: `http://127.0.0.1:${port}/`,
  apiKey: 'test',
  model: 'test-model',
  timeoutMs: 3000,
  retries: 2,
  ...extra,
});

console.log(`重试配置: retries=${LLM_LIMITS.retries} backoff=${LLM_LIMITS.retryBackoffMs}ms 可重试状态=${LLM_LIMITS.retryableStatus.join('/')}`);

// 1) 抖两下再成功 —— 这是 502 事故最该被自动兜住的情形
{
  const gw = await fakeGateway([{ status: 502 }, { status: 502 }, { status: 200, content: '{"ok":1}' }]);
  const c = client(gw.port);
  const out = await c.chat({ system: 's', user: 'u' });
  check('502 抖两次后第三次成功: 内容正确返回', out === '{"ok":1}', out);
  check('确实重试了 (共 3 次请求)', gw.hits() === 3, String(gw.hits()));
  await gw.close();
}

// 2) 4xx 语义错不重试 (模型名/参数写错, 重试只是白等)
{
  const gw = await fakeGateway([{ status: 400 }]);
  const c = client(gw.port);
  let err = null;
  try { await c.chat({ system: 's', user: 'u' }); } catch (e) { err = e; }
  check('400 立即抛出', err && /400/.test(err.message), err?.message);
  check('400 只请求一次 (不浪费延迟)', gw.hits() === 1, String(gw.hits()));
  await gw.close();
}

// 3) 一直 502 -> 用尽重试后如实抛错, 不假装成功 (否则就是静默丢数据)
{
  const gw = await fakeGateway([{ status: 502 }]);
  const c = client(gw.port);
  let err = null;
  try { await c.chat({ system: 's', user: 'u' }); } catch (e) { err = e; }
  check('持续 502 最终抛错', err && /502/.test(err.message), err?.message);
  check(`请求次数 = 1 + retries (${1 + 2})`, gw.hits() === 3, String(gw.hits()));
  await gw.close();
}

// 4) retries=0 关闭重试 (排查时只想知道一次结果)
{
  const gw = await fakeGateway([{ status: 502 }]);
  const c = client(gw.port, { retries: 0 });
  let err = null;
  try { await c.chat({ system: 's', user: 'u' }); } catch (e) { err = e; }
  check('retries=0 时只请求一次并抛错', Boolean(err) && gw.hits() === 1, String(gw.hits()));
  await gw.close();
}

// 5) 网络层失败 (连不上) 也走重试, 最终抛出可读错误
{
  const gw = await fakeGateway([{ status: 200 }]);
  const port = gw.port;
  await gw.close();                       // 关掉 -> 连接被拒 = fetch 抛 TypeError
  const c = client(port);
  let err = null;
  try { await c.chat({ system: 's', user: 'u' }); } catch (e) { err = e; }
  check('连不上时抛出可读的网络错误', err && /网络错误|fetch failed|ECONNREFUSED/i.test(err.message), err?.message);
}

// 6) extraBody 透传供应商私有开关 (如 DeepSeek reasoning_effort), 且能覆盖默认字段
{
  const gw = await fakeGateway([{ status: 200 }]);
  const c = client(gw.port, { extraBody: { reasoning_effort: 'low' } });
  await c.chat({ system: 's', user: 'u', maxTokens: 1234 });
  const sent = gw.seen[0].body;
  check('extraBody 出现在请求体里', sent.reasoning_effort === 'low', JSON.stringify(sent.reasoning_effort));
  check('extraBody 不挤掉协议字段', sent.model === 'test-model' && sent.response_format?.type === 'json_object'
    && sent.max_tokens === 1234, JSON.stringify(sent));
  check('密钥走 Authorization 头, 不进 body', String(gw.seen[0].auth).startsWith('Bearer ') && !('apiKey' in sent));
  await gw.close();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
