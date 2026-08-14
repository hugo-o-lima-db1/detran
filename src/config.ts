import 'dotenv/config';
import path from 'node:path';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim', 'y', 's'].includes(v.trim().toLowerCase());
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** CPF só com dígitos. */
export function onlyDigits(v: string): string {
  return (v || '').replace(/\D/g, '');
}

export interface Config {
  cpf: string;
  processo: string;
  servico: string;
  autoBook: boolean;
  dataMinima?: string;
  dataMaxima?: string;
  cidadePreferida?: string;
  headless: boolean;
  userDataDir: string;
  stepTimeoutMs: number;
  telegram?: { token: string; chatId: string };
  webhookUrl?: string;
  smtp?: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
    to: string;
  };
  // URLs do portal / API do DETRAN-PR (serviço 749).
  portalUrl: string;
  apiBase: string;
  runsDir: string;
}

export function loadConfig(): Config {
  const cpf = onlyDigits(process.env.DETRAN_CPF ?? '');
  // O número do processo/RENACH pode ter letras e dígitos — só removemos espaços.
  const processo = (process.env.DETRAN_PROCESSO ?? '').replace(/\s+/g, '').trim();
  const servico = (process.env.DETRAN_SERVICO ?? '749').trim();

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChat = process.env.TELEGRAM_CHAT_ID?.trim();

  const smtpHost = process.env.SMTP_HOST?.trim();
  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim();
  const smtpTo = process.env.SMTP_TO?.trim();

  const cfg: Config = {
    cpf,
    processo,
    servico,
    autoBook: bool(process.env.AUTO_BOOK, true),
    dataMinima: process.env.DATA_MINIMA?.trim() || undefined,
    dataMaxima: process.env.DATA_MAXIMA?.trim() || undefined,
    cidadePreferida: process.env.CIDADE_PREFERIDA?.trim() || undefined,
    headless: bool(process.env.HEADLESS, true),
    userDataDir: path.resolve(process.env.USER_DATA_DIR?.trim() || './user-data'),
    stepTimeoutMs: num(process.env.STEP_TIMEOUT_MS, 45000),
    telegram:
      telegramToken && telegramChat
        ? { token: telegramToken, chatId: telegramChat }
        : undefined,
    webhookUrl: process.env.WEBHOOK_URL?.trim() || undefined,
    smtp:
      smtpHost && smtpUser && smtpPass && smtpTo
        ? {
            host: smtpHost,
            port: num(process.env.SMTP_PORT, 587),
            user: smtpUser,
            pass: smtpPass,
            from: process.env.SMTP_FROM?.trim() || smtpUser,
            to: smtpTo,
          }
        : undefined,
    portalUrl: `https://www.agendamento.detran.pr.gov.br/detran-agendamento/portal?servico=${servico}`,
    apiBase: 'https://ws.agendamento.detran.pr.gov.br/detran-agendamento/api',
    runsDir: path.resolve('./runs'),
  };

  return cfg;
}

/** Valida a config para os comandos que precisam de CPF. */
export function assertRunnable(cfg: Config): void {
  if (cfg.cpf.length !== 11) {
    throw new Error(
      `DETRAN_CPF inválido ("${process.env.DETRAN_CPF ?? ''}"). ` +
        'Preencha um CPF com 11 dígitos no arquivo .env.',
    );
  }
  if (!cfg.processo) {
    throw new Error(
      'DETRAN_PROCESSO vazio. Preencha o número do processo/RENACH no .env ' +
        '(o mesmo que você digita no portal para acessar).',
    );
  }
}
