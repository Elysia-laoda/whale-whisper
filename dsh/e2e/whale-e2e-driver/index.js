/**
 * 只在端到端测试档案里出现的观察者插件（不随 dsh-whisper-whale 发布）。
 * 它必须比 whisper-whale 先注册，这样在 waterfall 里它才是外层，能通过 next()
 * 看到 whisper-whale 合并后的结果。
 */
export const name = 'whale-e2e-driver';
export const inject = [];

const EVENT_RE = /补充提示挂件 · 事件 (w-[0-9a-z-]+)/;

function log(line) {
  process.stderr.write('[e2e] ' + line + '\n');
}

function textsOf(messages) {
  try {
    return (messages ?? []).map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join(' || ');
  } catch { return ''; }
}

export function apply(ctx) {
  const delayMs = Number(process.env.WHALE_E2E_DELAY_MS || 0);
  let clicked = false;
  let seenGreeting = false;
  let seenEvent = false;

  function click(agent) {
    try {
      const api = ctx.get('whisperWhale');
      if (!api) return log('FAIL: ctx.get("whisperWhale") 是空的');
      log('click -> ' + JSON.stringify(api.click(agent.id)));
    } catch (error) {
      log('FAIL click threw: ' + String(error));
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (clicked) return;
      clicked = true;
      log('agent created: ' + agent.id + ' (delay=' + delayMs + 'ms)');
      if (delayMs <= 0) click(agent);
      else setTimeout(() => click(agent), delayMs);
    } catch (error) {
      log('FAIL created handler: ' + String(error));
    }
  });

  // 缺口一：agent/turn-stopping。它由 agentEvents 派发，payload 里会被注入 agent
  // 主体；用真实的派发器跑一遍，再看挂件状态是否从 queued 变成 delivered。
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const api = ctx.get('whisperWhale');
      const id = agent.id;
      log('probe turn-stopping: click ok=' + api.click(id).ok + ', phase=' + api.status(id).phase);
      const mod = await import('@deepseek-ai/dsh-agent');
      const dispatch = mod.agentEvents(ctx, agent);
      await dispatch.serial('agent/turn-stopping', { turn: 1 });
      log('probe turn-stopping: 派发之后 phase=' + api.status(id).phase);
    } catch (error) {
      log('FAIL turn-stopping probe: ' + String(error));
    }
  });

  // 缺口二：tools/post-execute。直接用真实 cordis 的 waterfall 走一遍，验证监听器
  // 顺序与 additionalContexts 合并（agent-loop 的 runGroup 会消费这个字段）。
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!ctx.get('whisperWhale').click(agent.id).ok) return;
      const decision = await ctx.waterfall(
        'tools/post-execute',
        { agent, name: 'e2e-probe', arguments: {}, callId: 'e2e-call', signal: undefined },
        { content: [{ type: 'text', text: 'probe' }] },
        () => Promise.resolve({ kind: 'result', additionalContexts: [{ marker: 'theirs' }] })
      );
      const injected = (decision.additionalContexts ?? []).map((c) => textsOf([c])).join(' ');
      const match = EVENT_RE.exec(injected);
      log('waterfall tools/post-execute -> kind=' + decision.kind
        + ', contexts=' + (decision.additionalContexts ?? []).length
        + ', ours=' + (match ? match[1] : 'MISSING')
        + ', theirsKept=' + JSON.stringify(decision.additionalContexts ?? []).includes('theirs'));
    } catch (error) {
      log('FAIL post-execute probe: ' + String(error));
    }
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next();
    try {
      const text = textsOf(downstream?.messages);
      if (!seenGreeting && text.includes('补充提示挂件 · 上下文')) {
        seenGreeting = true;
        log('PASS 会话开头上下文已进入请求');
      }
      const match = EVENT_RE.exec(text);
      if (!seenEvent && match) {
        seenEvent = true;
        log('PASS pre-step 收到事件提醒，eventId=' + match[1]);
      }
    } catch { /* ignore */ }
    return downstream;
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    try {
      for (const context of downstream?.additionalContexts ?? []) {
        const match = EVENT_RE.exec(textsOf([context]));
        if (match) log('PASS post-execute 注入了事件提醒 (tool=' + exec.name + ', eventId=' + match[1] + ')');
      }
    } catch { /* ignore */ }
    return downstream;
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec.name === 'ask_user_question') {
        log('PASS 模型正在调用 ask_user_question: ' + JSON.stringify(exec.arguments).slice(0, 300));
      }
    } catch { /* ignore */ }
    return next();
  });
}
