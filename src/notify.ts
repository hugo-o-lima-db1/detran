import net from 'node:net';
import tls from 'node:tls';
import type { Config } from './config.js';
import { log } from './logger.js';

/**
 * Envia uma notificação por todos os canais configurados.
 * Nunca lança: falha de notificação não deve derrubar a automação.
 */
export async function notify(cfg: Config, text: string): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (cfg.telegram) tasks.push(sendTelegram(cfg.telegram, text));
  if (cfg.webhookUrl) tasks.push(sendWebhook(cfg.webhookUrl, text));
  if (cfg.smtp) tasks.push(sendEmail(cfg.smtp, text));
  if (tasks.length === 0) {
    log.warn('Nenhum canal de notificação configurado (Telegram/Webhook/SMTP).');
    return;
  }
  await Promise.allSettled(tasks);
}

async function sendTelegram(
  tg: NonNullable<Config['telegram']>,
  text: string,
): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${tg.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) log.warn(`Telegram respondeu ${res.status}: ${await res.text()}`);
    else log.info('Notificação enviada por Telegram.');
  } catch (e) {
    log.warn(`Falha ao enviar Telegram: ${(e as Error).message}`);
  }
}

async function sendWebhook(url: string, text: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Formato compatível com Slack/Discord (campos "content" e "text").
      body: JSON.stringify({ text, content: text }),
    });
    if (!res.ok) log.warn(`Webhook respondeu ${res.status}.`);
    else log.info('Notificação enviada por webhook.');
  } catch (e) {
    log.warn(`Falha ao enviar webhook: ${(e as Error).message}`);
  }
}

async function sendEmail(
  smtp: NonNullable<Config['smtp']>,
  text: string,
): Promise<void> {
  try {
    await smtpSend(smtp, 'DETRAN-PR — agendamento do exame psicológico', text);
    log.info('Notificação enviada por e-mail.');
  } catch (e) {
    log.warn(`Falha ao enviar e-mail: ${(e as Error).message}`);
  }
}

/**
 * Cliente SMTP mínimo e SEGURO, sem dependências externas.
 * - Porta 465: TLS implícito (conexão criptografada desde o início).
 * - Porta 587 (ou outra): STARTTLS obrigatório — a conexão é elevada para TLS
 *   ANTES de enviar usuário/senha. Se o servidor não oferecer STARTTLS, aborta
 *   sem transmitir credenciais em texto puro.
 */
function smtpSend(
  smtp: NonNullable<Config['smtp']>,
  subject: string,
  body: string,
): Promise<void> {
  const CRLF = '\r\n';
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  return new Promise((resolve, reject) => {
    let socket: net.Socket | tls.TLSSocket;
    let buffer = '';
    let secured = false;
    let settled = false;
    const transcript: string[] = [];

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };
    const fail = (m: string) =>
      done(new Error(`${m}${transcript.length ? ` | ${transcript.slice(-3).join(' / ')}` : ''}`));

    const message = [
      `From: ${smtp.from}`,
      `To: ${smtp.to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      body.replace(/\r?\n\./g, '\n..'), // dot-stuffing
      `.`,
    ].join(CRLF);

    // Fila de comandos APÓS o canal estar seguro (TLS/STARTTLS concluído).
    const authAndSend: string[] = [
      `EHLO localhost`,
      `AUTH LOGIN`,
      b64(smtp.user),
      b64(smtp.pass),
      `MAIL FROM:<${smtp.from}>`,
      `RCPT TO:<${smtp.to}>`,
      `DATA`,
      message,
      `QUIT`,
    ];
    let phase: 'greet' | 'ehlo' | 'starttls' | 'secure' = 'greet';
    let secureIdx = 0;

    const write = (line: string) => socket.write(line + CRLF);

    const handleResponse = (code: number, full: string) => {
      if (code >= 400) return fail(`SMTP recusou (${code}): ${full}`);

      if (secured) {
        // Canal seguro: percorre a fila authAndSend.
        if (secureIdx >= authAndSend.length) return done();
        write(authAndSend[secureIdx++]);
        return;
      }

      // Canal ainda em texto puro (só p/ porta 587 antes do STARTTLS).
      switch (phase) {
        case 'greet':
          phase = 'ehlo';
          write('EHLO localhost');
          break;
        case 'ehlo':
          if (!/\bSTARTTLS\b/i.test(full)) {
            return fail(
              'Servidor não oferece STARTTLS na porta ' +
                smtp.port +
                '. Use porta 465 (TLS) para não expor a senha.',
            );
          }
          phase = 'starttls';
          write('STARTTLS');
          break;
        case 'starttls':
          upgradeToTls();
          break;
        default:
          fail('estado SMTP inesperado');
      }
    };

    const onData = (data: Buffer) => {
      buffer += data.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + CRLF.length);
        transcript.push(line);
        // Linha final de uma resposta multi-linha: "250 texto" (não "250-...").
        if (/^\d{3} /.test(line)) {
          handleResponse(Number(line.slice(0, 3)), line);
        }
      }
    };

    const upgradeToTls = () => {
      const plain = socket as net.Socket;
      plain.removeAllListeners('data');
      const secure = tls.connect(
        { socket: plain, servername: smtp.host },
        () => {
          secured = true;
          socket = secure;
          socket.on('data', onData);
          // Reinicia o diálogo dentro do túnel TLS: primeiro comando é EHLO.
          write(authAndSend[secureIdx++]);
        },
      );
      secure.on('error', (e) => fail(`TLS: ${e.message}`));
      buffer = '';
    };

    try {
      if (smtp.port === 465) {
        socket = tls.connect(
          { host: smtp.host, port: 465, servername: smtp.host },
          () => {
            secured = true;
            socket.on('data', onData);
          },
        );
      } else {
        socket = net.connect({ host: smtp.host, port: smtp.port }, () => {
          socket.on('data', onData);
        });
      }
      socket.setTimeout(20000, () => fail('timeout SMTP'));
      socket.on('error', (e) => fail(`socket: ${e.message}`));
    } catch (e) {
      fail((e as Error).message);
    }
  });
}
