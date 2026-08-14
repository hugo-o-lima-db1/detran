import fs from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import type { Config } from './config.js';

/**
 * Abre um contexto de navegador PERSISTENTE. O diretório userDataDir guarda
 * cookies/sessão, então o login feito uma vez (comando `login`) continua
 * valendo nas execuções seguintes (comando `check`), inclusive headless.
 */
export async function openContext(cfg: Config): Promise<BrowserContext> {
  fs.mkdirSync(cfg.userDataDir, { recursive: true });

  // Permite apontar para um Chromium já instalado (ex.: em servidores/CI que
  // já trazem o navegador). Na maioria das máquinas, deixe em branco e rode
  // uma vez `npx playwright install chromium`.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined;

  // Em ambientes com proxy de saída (CI/sandbox), o Chromium precisa ser
  // apontado explicitamente para o proxy. Em máquinas normais, sem HTTPS_PROXY,
  // a conexão é direta.
  const proxyServer =
    process.env.PLAYWRIGHT_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    undefined;

  const context = await chromium.launchPersistentContext(cfg.userDataDir, {
    ...(executablePath ? { executablePath } : {}),
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    headless: cfg.headless,
    viewport: { width: 1366, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  context.setDefaultTimeout(cfg.stepTimeoutMs);
  context.setDefaultNavigationTimeout(cfg.stepTimeoutMs);
  return context;
}
