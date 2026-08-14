import fs from 'node:fs';
import path from 'node:path';

let logFile: string | null = null;

export function initLogFile(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  // Timestamp determinístico em ISO, seguro para nome de arquivo.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logFile = path.join(dir, `run-${stamp}.log`);
  return logFile;
}

function write(level: string, msg: string) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      /* ignora falha de escrita de log */
    }
  }
}

export const log = {
  info: (m: string) => write('INFO ', m),
  warn: (m: string) => write('WARN ', m),
  error: (m: string) => write('ERROR', m),
  ok: (m: string) => write('OK   ', m),
};
