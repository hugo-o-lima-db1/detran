import { loadConfig, assertRunnable, type Config } from './config.js';
import { initLogFile, log } from './logger.js';
import { openContext } from './browser.js';
import { runCheck, runLogin, type CheckResult } from './detran.js';
import { notify } from './notify.js';

async function withContext<T>(
  cfg: Config,
  fn: (ctx: Awaited<ReturnType<typeof openContext>>) => Promise<T>,
): Promise<T> {
  const ctx = await openContext(cfg);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

function summarize(r: CheckResult): string {
  const head = `DETRAN-PR (exame psicológico) — ${r.status}`;
  let body = r.message;
  if (r.dates?.length) body += `\nDatas: ${r.dates.join(', ')}`;
  if (r.chosen) body += `\nEscolhida: ${r.chosen}`;
  return `${head}\n${body}`;
}

/** Executa uma verificação e notifica conforme o resultado. */
async function doCheck(cfg: Config): Promise<CheckResult> {
  assertRunnable(cfg);
  const result = await withContext(cfg, (ctx) =>
    runCheck(cfg, ctx, { allowBooking: cfg.autoBook }),
  );

  const text = summarize(result);
  log.info(`Resultado: ${result.status} — ${result.message}`);

  // Notifica apenas quando há algo relevante para o usuário saber.
  if (['BOOKED', 'AVAILABLE', 'NEEDS_LOGIN', 'STUCK'].includes(result.status)) {
    await notify(cfg, text);
  } else {
    log.info('Sem vagas: sem notificação (evita spam diário).');
  }
  return result;
}

async function cmdLogin(cfg: Config): Promise<void> {
  // Login sempre com janela visível.
  const visibleCfg: Config = { ...cfg, headless: false };
  await withContext(visibleCfg, (ctx) => runLogin(visibleCfg, ctx));
}

async function cmdCheck(cfg: Config): Promise<void> {
  const r = await doCheck(cfg);
  // Código de saída: 0 = agendou/achou vaga, 2 = precisa login/travou, 1 = sem vaga.
  if (r.status === 'BOOKED' || r.status === 'AVAILABLE') process.exitCode = 0;
  else if (r.status === 'NEEDS_LOGIN' || r.status === 'STUCK' || r.status === 'ERROR')
    process.exitCode = 2;
  else process.exitCode = 1;
}

async function cmdLoop(cfg: Config): Promise<void> {
  // Intervalo entre verificações (minutos). Padrão: a cada 6 horas.
  const minutes = Number(process.env.LOOP_INTERVAL_MIN ?? '360');
  const intervalMs = (Number.isFinite(minutes) && minutes >= 1 ? minutes : 360) * 60_000;
  log.info(`Modo loop: verificando a cada ${intervalMs / 60000} min. Ctrl+C para parar.`);

  // Loop infinito, resistente a erros de rede/site.
  for (;;) {
    try {
      const r = await doCheck(cfg);
      if (r.status === 'BOOKED') {
        log.ok('Agendado! Encerrando o loop.');
        return; // missão cumprida
      }
    } catch (e) {
      log.error(`Erro na verificação: ${(e as Error).message}`);
      await notify(cfg, `DETRAN-PR: erro na verificação — ${(e as Error).message}`).catch(
        () => {},
      );
    }
    // Pequena variação (0–60s) para não bater sempre no mesmo instante.
    const jitter = Math.floor(Math.random() * 60_000);
    await sleep(intervalMs + jitter);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? 'check').toLowerCase();
  const cfg = loadConfig();
  initLogFile(cfg.runsDir);
  log.info(`Comando: ${cmd} | serviço ${cfg.servico} | headless=${cfg.headless} | autoBook=${cfg.autoBook}`);

  switch (cmd) {
    case 'login':
      await cmdLogin(cfg);
      break;
    case 'check':
      await cmdCheck(cfg);
      break;
    case 'loop':
      await cmdLoop(cfg);
      break;
    default:
      log.error(`Comando desconhecido: ${cmd}. Use: login | check | loop`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  log.error(`Falha fatal: ${(e as Error).stack ?? (e as Error).message}`);
  process.exitCode = 2;
});
