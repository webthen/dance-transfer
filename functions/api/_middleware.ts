import { jsonResponse, type Env } from '../../server/env';

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-access-pin',
      },
    });
  }

  const configuredPin = env.ACCESS_PIN?.trim();
  if (!configuredPin) {
    return jsonResponse(
      { error: '服务端未配置访问口令环境变量 ACCESS_PIN' },
      500
    );
  }

  const providedPin = request.headers.get('x-access-pin')?.trim() || '';
  if (!providedPin || providedPin !== configuredPin) {
    return jsonResponse(
      { error: '口令不正确或未输入，请输入正确的访问口令', code: 'UNAUTHORIZED' },
      401
    );
  }

  try {
    return await context.next();
  } catch (err) {
    const message = err instanceof Error ? err.message : '服务器内部错误，请稍后重试';
    return jsonResponse({ error: message }, 500);
  }
};
