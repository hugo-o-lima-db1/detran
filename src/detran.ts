import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { Config } from './config.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Tipos do formulário dirigido pelo servidor (subconjunto do que a API retorna)
// ---------------------------------------------------------------------------
interface FormField {
  '@class'?: string;
  name?: string;
  type?: string;
  label?: string | null;
  value?: unknown;
  required?: boolean | null;
  items?: Array<{ label?: string; value?: unknown }> | null;
}
interface FormMsgBag {
  infos?: unknown[];
  alerts?: unknown[];
  errors?: unknown[];
}
interface ServerForm {
  action?: string;
  fields?: FormField[];
  infos?: unknown[];
  alerts?: unknown[];
  errors?: unknown[];
}

export type CheckStatus =
  | 'NEEDS_LOGIN' // sessão não autenticada — rodar `npm run login`
  | 'NO_AVAILABILITY' // chegou no calendário, nenhuma data aberta
  | 'AVAILABLE' // há data(s), mas AUTO_BOOK=false (só avisou)
  | 'BOOKED' // agendou com sucesso
  | 'STUCK' // travou numa fase que não soube resolver
  | 'ERROR'; // exceção inesperada

export interface CheckResult {
  status: CheckStatus;
  message: string;
  dates?: string[];
  chosen?: string;
  screenshot?: string;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

async function shot(page: Page, cfg: Config, name: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(cfg.runsDir, `${stamp}-${name}.png`);
  fs.mkdirSync(cfg.runsDir, { recursive: true });
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    /* ignora */
  }
  return file;
}

/** Observa as respostas da API de fases e mantém a última Form recebida. */
function attachFormSniffer(page: Page, cfg: Config) {
  const state: { last?: ServerForm; count: number } = { count: 0 };
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/agendamento/fase')) return;
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const body = (await res.json()) as { form?: ServerForm } | ServerForm;
      const form: ServerForm | undefined =
        (body as { form?: ServerForm }).form ?? (body as ServerForm);
      if (form && (form.fields || form.action)) {
        state.last = form;
        state.count += 1;
        fs.mkdirSync(cfg.runsDir, { recursive: true });
        fs.writeFileSync(
          path.join(cfg.runsDir, `form-${state.count}.json`),
          JSON.stringify(form, null, 2),
        );
      }
    } catch {
      /* respostas não-JSON são ignoradas */
    }
  });
  return state;
}

// ---------------------------------------------------------------------------
// Detecção de estado da página
// ---------------------------------------------------------------------------

/** Texto visível da página, normalizado. */
async function pageText(page: Page): Promise<string> {
  try {
    return norm((await page.locator('body').innerText({ timeout: 5000 })) || '');
  } catch {
    return '';
  }
}

/**
 * O portal exigiu login gov.br/Central? Este serviço normalmente NÃO exige
 * (acesso só com CPF + processo), então isto é uma rede de segurança para o
 * caso de o DETRAN mudar o fluxo.
 */
async function needsLogin(page: Page): Promise<boolean> {
  const url = page.url();
  if (/identidadedigital\.pr\.gov\.br|centralautenticacao|centralcidadao/.test(url)) {
    return true;
  }
  const t = await pageText(page);
  return (
    (t.includes('entrar com') && (t.includes('central') || t.includes('gov.br'))) ||
    t.includes('faca login')
  );
}

/** Portal recusou o acesso — quase sempre CPF ou nº do processo incorreto. */
async function accessDenied(page: Page): Promise<boolean> {
  const t = await pageText(page);
  return (
    t.includes('acesso nao permitido') ||
    t.includes('dados nao conferem') ||
    t.includes('nao foi possivel localizar') ||
    t.includes('processo nao encontrado')
  );
}

const NO_SLOT_PHRASES = [
  'nao ha datas',
  'nao existem datas',
  'nenhuma data',
  'sem datas disponiveis',
  'nao ha vagas',
  'sem vagas',
  'nenhum horario',
  'indisponivel',
  'nao ha horarios',
  'no momento nao',
];

async function hasNoAvailabilityMessage(page: Page): Promise<boolean> {
  const t = await pageText(page);
  return NO_SLOT_PHRASES.some((p) => t.includes(p));
}

/** Existe um calendário (PrimeVue datepicker) na tela? */
async function hasCalendar(page: Page): Promise<boolean> {
  return (
    (await page
      .locator('.p-datepicker, .p-calendar, [class*="datepicker"]')
      .count()) > 0
  );
}

/** Dias clicáveis (não desabilitados) do calendário. */
async function enabledDayCells(page: Page) {
  // No PrimeVue, dias indisponíveis recebem a classe p-disabled.
  return page.locator(
    '.p-datepicker table td:not(.p-disabled) > span:not(.p-disabled), ' +
      '.p-datepicker table td:not(.p-disabled) > .p-highlight, ' +
      '.p-datepicker-calendar td:not(.p-disabled) > span',
  );
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------

export async function runCheck(
  cfg: Config,
  context: BrowserContext,
  opts: { allowBooking: boolean },
): Promise<CheckResult> {
  const page = context.pages()[0] ?? (await context.newPage());
  const forms = attachFormSniffer(page, cfg);

  log.info(`Abrindo portal do serviço ${cfg.servico}...`);
  await page.goto(cfg.portalUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  if (await needsLogin(page)) {
    const s = await shot(page, cfg, 'needs-login');
    return {
      status: 'NEEDS_LOGIN',
      message:
        'O portal pediu login gov.br/Central de Segurança — inesperado para este ' +
        'serviço (que costuma exigir só CPF + processo). O fluxo do DETRAN pode ter ' +
        'mudado. Veja o screenshot.',
      screenshot: s,
    };
  }

  // Preenche CPF e número do processo já na tela inicial de acesso.
  await maybeFillCpf(page, cfg);
  await maybeFillProcesso(page, cfg);

  // Caminha pelas fases até o calendário (ou até travar).
  const MAX_STEPS = 18;
  let idleSteps = 0;
  for (let step = 1; step <= MAX_STEPS; step++) {
    await page.waitForTimeout(1500);

    if (await needsLogin(page)) {
      return {
        status: 'NEEDS_LOGIN',
        message: 'O portal passou a exigir login gov.br durante o fluxo (inesperado).',
        screenshot: await shot(page, cfg, 'login-inesperado'),
      };
    }

    // Acesso negado = CPF ou número do processo incorreto.
    if (await accessDenied(page)) {
      return {
        status: 'STUCK',
        message:
          'O portal recusou o acesso. Verifique se DETRAN_CPF e DETRAN_PROCESSO ' +
          'estão corretos (os mesmos que você digita no site para entrar).',
        screenshot: await shot(page, cfg, 'acesso-negado'),
      };
    }

    // Chegamos ao calendário?
    if (await hasCalendar(page)) {
      log.info('Fase de calendário detectada.');
      return await handleCalendar(page, cfg, opts);
    }

    // Mensagem explícita de indisponibilidade antes mesmo do calendário.
    if (await hasNoAvailabilityMessage(page)) {
      return {
        status: 'NO_AVAILABILITY',
        message: 'O portal informou que não há datas/vagas disponíveis no momento.',
        screenshot: await shot(page, cfg, 'sem-vagas'),
      };
    }

    const advanced = await resolveAndAdvance(page, cfg, forms.last);
    if (advanced) {
      idleSteps = 0;
      log.info(`Fase ${step}: avançou.`);
    } else {
      idleSteps += 1;
      log.warn(`Fase ${step}: nada para resolver (idle ${idleSteps}).`);
      if (idleSteps >= 2) break;
    }
  }

  return {
    status: 'STUCK',
    message:
      'A automação não conseguiu chegar ao calendário sozinha. Provavelmente há ' +
      'uma etapa específica do seu processo (categoria, RENACH, clínica) que precisa ' +
      'de ajuste manual dos seletores em src/detran.ts (função resolveAndAdvance). ' +
      'Veja o screenshot e os arquivos runs/form-*.json.',
    screenshot: await shot(page, cfg, 'stuck'),
  };
}

/** Preenche o campo de CPF, se existir e estiver vazio. */
async function maybeFillCpf(page: Page, cfg: Config): Promise<boolean> {
  const candidates = [
    'input[name="cpf"]',
    'input#cpf',
    'input[placeholder*="CPF" i]',
    'input[aria-label*="CPF" i]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      const cur = (await loc.inputValue().catch(() => '')) || '';
      if (cur.replace(/\D/g, '').length !== 11) {
        await loc.click({ delay: 30 }).catch(() => {});
        await loc.fill('').catch(() => {});
        await loc.type(cfg.cpf, { delay: 40 });
        log.info('CPF preenchido.');
      }
      return true;
    }
  }
  return false;
}

/** Preenche o número do processo/RENACH, se o campo existir e estiver vazio. */
async function maybeFillProcesso(page: Page, cfg: Config): Promise<boolean> {
  const candidates = [
    'input[name*="processo" i]',
    'input[id*="processo" i]',
    'input[name*="renach" i]',
    'input[id*="renach" i]',
    'input[placeholder*="processo" i]',
    'input[placeholder*="renach" i]',
    'input[aria-label*="processo" i]',
    'input[aria-label*="renach" i]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      const cur = (await loc.inputValue().catch(() => '')) || '';
      if (cur.trim() === '') {
        await loc.click({ delay: 30 }).catch(() => {});
        await loc.fill('').catch(() => {});
        await loc.type(cfg.processo, { delay: 40 });
        log.info('Número do processo preenchido.');
      }
      return true;
    }
  }

  // Fallback: se houver um segundo campo de texto vazio (que não seja o CPF),
  // provavelmente é o processo. Só preenche se o CPF já estiver preenchido.
  const inputs = page.locator(
    'input[type="text"]:visible, input[type="number"]:visible, input:not([type]):visible',
  );
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const name = norm((await el.getAttribute('name').catch(() => '')) || '');
    if (name.includes('cpf')) continue;
    const val = (await el.inputValue().catch(() => '')) || '';
    if (val.trim() === '') {
      await el.click({ delay: 30 }).catch(() => {});
      await el.type(cfg.processo, { delay: 40 });
      log.info('Número do processo preenchido (campo genérico).');
      return true;
    }
  }
  return false;
}

/**
 * Resolve a fase atual (CPF, processo, termos, opção única) e clica em avançar.
 * Retorna true se fez alguma ação que muda de fase.
 */
async function resolveAndAdvance(
  page: Page,
  cfg: Config,
  _form?: ServerForm,
): Promise<boolean> {
  let acted = false;

  // 1) CPF e número do processo, caso apareçam.
  if (await maybeFillCpf(page, cfg)) acted = true;
  if (await maybeFillProcesso(page, cfg)) acted = true;

  // 2) Aceitar termos: marca checkboxes não marcados.
  const checkboxes = page.locator(
    'input[type="checkbox"]:not(:checked), .p-checkbox-box:not(.p-highlight)',
  );
  const cbCount = await checkboxes.count().catch(() => 0);
  for (let i = 0; i < cbCount; i++) {
    const cb = checkboxes.nth(i);
    if (await cb.isVisible().catch(() => false)) {
      await cb.click({ delay: 30 }).catch(() => {});
      acted = true;
    }
  }

  // 3) Escolhas de opção única (radios / dropdowns): tenta a preferida por
  //    cidade, senão a primeira opção.
  if (await pickPreferredOption(page, cfg)) acted = true;

  // 4) Botão de avançar/confirmar/continuar.
  const advanced = await clickAdvance(page);
  return acted || advanced;
}

/** Seleciona a opção preferida (por cidade) ou a primeira, em radios/dropdowns. */
async function pickPreferredOption(page: Page, cfg: Config): Promise<boolean> {
  const pref = cfg.cidadePreferida ? norm(cfg.cidadePreferida) : null;

  // Radios (PrimeVue): clica no rótulo que casa com a cidade, senão no primeiro.
  const radios = page.locator('.p-radiobutton, input[type="radio"]');
  const rCount = await radios.count().catch(() => 0);
  if (rCount > 0) {
    if (pref) {
      const match = page
        .locator('label, .p-radiobutton-label, tr, li')
        .filter({ hasText: new RegExp(cfg.cidadePreferida!, 'i') })
        .first();
      if ((await match.count()) > 0) {
        await match.click({ delay: 30 }).catch(() => {});
        return true;
      }
    }
    // Só auto-seleciona a primeira se nada estiver marcado ainda.
    const anyChecked = await page
      .locator('input[type="radio"]:checked, .p-radiobutton.p-radiobutton-checked')
      .count()
      .catch(() => 0);
    if (!anyChecked) {
      await radios.first().click({ delay: 30 }).catch(() => {});
      return true;
    }
  }

  // Dropdown PrimeVue: abre e escolhe a opção preferida/primeira.
  const dd = page.locator('.p-dropdown:not(.p-disabled)').first();
  if ((await dd.count()) > 0 && (await dd.isVisible().catch(() => false))) {
    const label = await dd.locator('.p-dropdown-label').innerText().catch(() => '');
    if (norm(label).includes('selecione') || label.trim() === '') {
      await dd.click({ delay: 30 }).catch(() => {});
      await page.waitForTimeout(400);
      const items = page.locator('.p-dropdown-item');
      const n = await items.count().catch(() => 0);
      if (n > 0) {
        let chosen = items.first();
        if (pref) {
          const m = items.filter({ hasText: new RegExp(cfg.cidadePreferida!, 'i') });
          if ((await m.count()) > 0) chosen = m.first();
        }
        await chosen.click({ delay: 30 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

const ADVANCE_LABELS = [
  'continuar',
  'avancar',
  'avançar',
  'proximo',
  'próximo',
  'prosseguir',
  'confirmar',
  'agendar',
  'iniciar',
  'buscar',
  'pesquisar',
];

/** Clica no botão de avanço mais provável, se houver e estiver habilitado. */
async function clickAdvance(page: Page): Promise<boolean> {
  const buttons = page.locator('button:visible, a.p-button:visible, .p-button:visible');
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const txt = norm((await b.innerText().catch(() => '')) || '');
    if (!txt) continue;
    if (ADVANCE_LABELS.some((l) => txt.includes(norm(l)))) {
      const disabled =
        (await b.getAttribute('disabled').catch(() => null)) !== null ||
        (await b.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
        (await b.evaluate((el) => el.classList.contains('p-disabled')).catch(() => false));
      if (disabled) continue;
      await b.click({ delay: 40 }).catch(() => {});
      await page.waitForTimeout(1200);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Calendário: detecção de datas e agendamento
// ---------------------------------------------------------------------------

const MESES: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

interface AvailableDate {
  iso: string | null; // "YYYY-MM-DD" quando foi possível datar; senão null
  label: string; // rótulo legível ("14" ou "2026-08-14")
  handle: import('playwright').Locator; // célula clicável do dia
}

/**
 * Percorre os painéis do datepicker (PrimeVue), lê o mês/ano visível de cada um
 * e coleta os dias habilitados (não desabilitados, do mês corrente) já com a
 * data ISO completa, permitindo filtro por faixa e ordenação.
 */
async function collectAvailableDates(page: Page): Promise<AvailableDate[]> {
  const out: AvailableDate[] = [];
  const groups = page.locator('.p-datepicker-group, .p-datepicker-calendar-container');
  let groupCount = await groups.count().catch(() => 0);

  // Datepicker simples (sem "group"): trata a raiz como um único painel.
  const roots = groupCount > 0 ? groups : page.locator('.p-datepicker');
  if (groupCount === 0) groupCount = await roots.count().catch(() => 0);

  for (let g = 0; g < groupCount; g++) {
    const grp = roots.nth(g);
    const title = norm((await grp.locator('.p-datepicker-title').innerText().catch(() => '')) || '');
    // Extrai "mês" e "ano" do título (ex.: "agosto 2026").
    let month = 0;
    let year = 0;
    for (const [nome, num] of Object.entries(MESES)) {
      if (title.includes(nome)) {
        month = num;
        break;
      }
    }
    const ym = title.match(/(\d{4})/);
    if (ym) year = Number(ym[1]);

    // Dias habilitados deste painel (exclui outros meses e desabilitados).
    const cells = grp.locator(
      'table td:not(.p-disabled):not(.p-datepicker-other-month) > span, ' +
        'table td:not(.p-disabled):not(.p-datepicker-other-month) > .p-highlight',
    );
    const n = await cells.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const cell = cells.nth(i);
      const dayTxt = ((await cell.innerText().catch(() => '')) || '').trim();
      const day = Number(dayTxt);
      let iso: string | null = null;
      let label = dayTxt;
      if (day >= 1 && day <= 31 && month && year) {
        iso = `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        label = iso;
      }
      if (dayTxt) out.push({ iso, label, handle: cell });
    }
  }

  // Fallback: se nada foi coletado (layout diferente), usa a coleta genérica.
  if (out.length === 0) {
    const generic = await enabledDayCells(page);
    const gc = await generic.count().catch(() => 0);
    for (let i = 0; i < gc; i++) {
      const cell = generic.nth(i);
      const t = ((await cell.innerText().catch(() => '')) || '').trim();
      if (t) out.push({ iso: null, label: t, handle: cell });
    }
  }

  return out;
}

async function handleCalendar(
  page: Page,
  cfg: Config,
  opts: { allowBooking: boolean },
): Promise<CheckResult> {
  // Dá tempo do calendário carregar as datas via API.
  await page.waitForTimeout(2000);

  if (await hasNoAvailabilityMessage(page)) {
    return {
      status: 'NO_AVAILABILITY',
      message: 'Calendário aberto, mas sem datas disponíveis.',
      screenshot: await shot(page, cfg, 'calendario-sem-vagas'),
    };
  }

  // Coleta as datas disponíveis com a data ISO completa (dia + mês/ano do
  // painel visível), para permitir filtro por faixa e ordenação.
  const available = await collectAvailableDates(page);
  if (available.length === 0) {
    return {
      status: 'NO_AVAILABILITY',
      message: 'Calendário aberto, nenhum dia clicável (sem vagas).',
      screenshot: await shot(page, cfg, 'calendario-vazio'),
    };
  }

  // Aplica o filtro de faixa de datas (DATA_MINIMA / DATA_MAXIMA), se houver.
  const inRange = available.filter((d) => {
    if (!d.iso) return true; // se não conseguiu datar, não descarta
    if (cfg.dataMinima && d.iso < cfg.dataMinima) return false;
    if (cfg.dataMaxima && d.iso > cfg.dataMaxima) return false;
    return true;
  });

  // Ordena da mais próxima para a mais distante.
  inRange.sort((a, b) => (a.iso || a.label).localeCompare(b.iso || b.label));

  const labels = inRange.map((d) => d.iso || d.label);
  const shotFile = await shot(page, cfg, 'datas-disponiveis');

  if (inRange.length === 0) {
    return {
      status: 'NO_AVAILABILITY',
      message:
        `Há ${available.length} data(s) disponível(is), mas nenhuma dentro da ` +
        `faixa configurada (${cfg.dataMinima ?? '...'} a ${cfg.dataMaxima ?? '...'}).`,
      dates: available.map((d) => d.iso || d.label),
      screenshot: shotFile,
    };
  }

  if (!opts.allowBooking) {
    return {
      status: 'AVAILABLE',
      message: `Há ${inRange.length} data(s) disponível(is) (AUTO_BOOK desligado, não agendei).`,
      dates: labels,
      screenshot: shotFile,
    };
  }

  // --- Agendamento automático da primeira data válida ----------------------
  log.info(`Tentando agendar a data mais próxima: ${labels[0]}`);
  await inRange[0].handle.click({ delay: 40 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Se aparecerem horários (time slots), escolhe o primeiro habilitado.
  await pickFirstTimeSlot(page);
  await page.waitForTimeout(800);

  // Confirma o agendamento (pode exigir 1 ou 2 cliques de confirmação).
  let confirmed = false;
  for (let i = 0; i < 3; i++) {
    const clicked = await clickConfirm(page);
    if (!clicked) break;
    confirmed = true;
    await page.waitForTimeout(2000);
    if (await bookingSucceeded(page)) break;
  }

  const finalShot = await shot(page, cfg, 'apos-confirmar');

  if (confirmed && (await bookingSucceeded(page))) {
    return {
      status: 'BOOKED',
      message: `Agendamento realizado com sucesso para ${labels[0]}! Confira o comprovante no portal.`,
      dates: labels,
      chosen: labels[0],
      screenshot: finalShot,
    };
  }

  // Não confirmou com certeza: avisa que há vaga para o usuário concluir na mão.
  return {
    status: 'AVAILABLE',
    message:
      'Encontrei data disponível e selecionei, mas não confirmei o agendamento ' +
      'automaticamente com segurança. Abra o portal e finalize — a vaga existe.',
    dates: labels,
    chosen: labels[0],
    screenshot: finalShot,
  };
}

async function pickFirstTimeSlot(page: Page): Promise<boolean> {
  const slots = page.locator(
    '.p-button:not(.p-disabled):has-text(":"), ' +
      'button:not([disabled]):has-text(":"), ' +
      '[class*="horario"] button:not([disabled]), ' +
      '[class*="slot"]:not(.p-disabled)',
  );
  const n = await slots.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const s = slots.nth(i);
    if (await s.isVisible().catch(() => false)) {
      await s.click({ delay: 30 }).catch(() => {});
      return true;
    }
  }
  return false;
}

const CONFIRM_LABELS = ['confirmar', 'agendar', 'finalizar', 'concluir', 'sim'];

async function clickConfirm(page: Page): Promise<boolean> {
  const buttons = page.locator('button:visible, .p-button:visible');
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const txt = norm((await b.innerText().catch(() => '')) || '');
    if (CONFIRM_LABELS.some((l) => txt.includes(l))) {
      const disabled =
        (await b.getAttribute('disabled').catch(() => null)) !== null ||
        (await b.evaluate((el) => el.classList.contains('p-disabled')).catch(() => false));
      if (disabled) continue;
      await b.click({ delay: 40 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function bookingSucceeded(page: Page): Promise<boolean> {
  const t = await pageText(page);
  return (
    t.includes('agendamento realizado') ||
    t.includes('agendado com sucesso') ||
    t.includes('protocolo') ||
    t.includes('comprovante') ||
    t.includes('sucesso')
  );
}

// ---------------------------------------------------------------------------
// Login interativo (headed)
// ---------------------------------------------------------------------------

export async function runLogin(cfg: Config, context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  log.info('Abrindo o portal para login. Faça login na Central de Segurança do PR.');
  await page.goto(cfg.portalUrl, { waitUntil: 'domcontentloaded' });

  log.info(
    'Aguardando você concluir o login (inclusive 2FA). ' +
      'A janela fecha sozinha quando a sessão estiver autenticada, ou em 5 min.',
  );

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await needsLogin(page))) {
      log.ok('Sessão autenticada detectada e salva em ' + cfg.userDataDir);
      await page.waitForTimeout(1500);
      return;
    }
  }
  log.warn('Tempo de login esgotado. Se você concluiu o login, a sessão foi salva mesmo assim.');
}
