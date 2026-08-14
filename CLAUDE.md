# Contexto para o Claude Code — automação de agendamento DETRAN-PR

Este arquivo é lido automaticamente pelo Claude Code ao abrir o projeto.
Ele existe porque a parte final da automação **ainda não pôde ser testada**: o
ambiente onde ela foi escrita fica fora do Brasil e o portal do Detran bloqueia
esse acesso. Se você (Claude) está rodando **numa máquina no Brasil**, você tem
algo que o autor original não tinha: acesso real ao portal. Use isso.

## O que a automação faz

Verifica periodicamente se há data disponível para o **exame psicológico**
(avaliação psicológica, serviço **749**) no portal do DETRAN-PR e, ao encontrar,
agenda a data mais próxima automaticamente. Notifica por Telegram/webhook/e-mail.

- `npm run check` — uma verificação (é o que o agendador chama)
- `npm run loop` — verifica em intervalos, encerra ao agendar
- `HEADLESS=false npm run check` — mesma coisa, com janela visível (depuração)

## Fatos já estabelecidos (não precisa redescobrir)

1. **Acesso só com CPF + número do processo.** Não há login gov.br nem 2FA neste
   serviço. Os dois valores vêm do `.env` (`DETRAN_CPF`, `DETRAN_PROCESSO`).

2. **O portal é um SPA Vue/PrimeVue** que consome
   `https://ws.agendamento.detran.pr.gov.br/detran-agendamento/api`.
   O fluxo é um **formulário dirigido pelo servidor**: cada fase devolve um
   objeto `Form` com `fields[]`, e avançar é um `POST /agendamento/fase`.
   - `GET /agendamento/fase/inicio?f_servico_pre_selecionado=749` devolve a
     primeira fase (campo `cpf` + um `f_token` JWT oculto).
   - A API exige o header `X-App-Route: 23479:0`.
   - Sem User-Agent de navegador, alguns hosts do Detran resetam a conexão.

3. **Bloqueio geográfico comprovado.** Medido do runner do GitHub (EUA):
   portal HTML `200` em 0,7s; API `200` em 0,5s; mas o **bundle JavaScript**
   (`dagf-detran-atendimento-prod.paas.pr.gov.br/assets/index-*.js`) dá
   **timeout de 40s / 0 bytes**. Sem ele o SPA não inicia: página em branco,
   zero inputs. Por isso o GitHub Actions foi desligado (só `workflow_dispatch`).
   **Numa máquina no Brasil isso deve funcionar** — confirme antes de depurar
   qualquer outra coisa.

4. **O que nunca foi exercitado de verdade:** tudo depois da tela inicial. As
   fases intermediárias (categoria, escolha de clínica/unidade, confirmação) e a
   leitura do calendário foram escritas a partir da engenharia reversa do bundle,
   **não** contra a tela real. É aqui que provavelmente falta ajuste.

## Como está organizado

| Arquivo | Papel |
|---|---|
| `src/cli.ts` | Comandos `check` / `loop` / `login`; códigos de saída |
| `src/config.ts` | Lê o `.env`; valida CPF e processo |
| `src/browser.ts` | Sobe o Chromium (perfil persistente, proxy opcional) |
| `src/detran.ts` | **O fluxo.** Navega as fases, detecta datas, agenda |
| `src/notify.ts` | Telegram, webhook e SMTP (TLS/STARTTLS) |
| `deploy/instalar-vps.sh` | Instalador one-shot + systemd timer |

Pontos de extensão em `src/detran.ts`:

- `resolveAndAdvance()` — resolve a fase atual (CPF, processo, termos, opção
  única) e clica em avançar. **É aqui que se adiciona uma etapa desconhecida.**
- `collectAvailableDates()` — lê os dias habilitados do datepicker PrimeVue e
  monta a data ISO usando o título do painel (ex.: "agosto 2026").
- `handleCalendar()` — filtra por `DATA_MINIMA`/`DATA_MAXIMA`, ordena e agenda.
- `pickFirstTimeSlot()` / `clickConfirm()` — horário e confirmação.

Códigos de saída do `check`: `0` achou/agendou · `1` sem vagas · `2` erro.

## Playbook de depuração (siga nesta ordem)

**Antes de tudo, confirme que a máquina alcança o bundle:**

```bash
curl -sS -m 20 -o /dev/null -w '%{http_code} %{time_total}s %{size_download}B\n' \
  -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  https://dagf-detran-atendimento-prod.paas.pr.gov.br/assets/index-cc095a18.js
```

- Deu `200` com centenas de KB → ótimo, a rede está boa; siga adiante.
- Deu `404` rápido → o nome do arquivo mudou (o hash `index-*.js` muda a cada
  deploy do Detran), mas **o host respondeu**, que é o que importa. Pegue o nome
  atual no HTML: `curl -s '<portal>' | grep -o 'assets/index-[^"]*\.js'`.
- Deu timeout/`000` → esta máquina **também** está bloqueada. Nada mais vai
  funcionar; é preciso uma máquina no Brasil (ou rotear o navegador por uma:
  `PLAYWRIGHT_PROXY=http://ip:porta`, já suportado em `src/browser.ts`).

**Depois, rode e leia o diagnóstico:**

```bash
npm run check          # o log termina com uma linha "Diagnóstico: ..."
```

A linha `Diagnóstico:` informa `texto=N chars`, `inputs=N`,
`respostas de fase capturadas=N` e `requisições falhas=N`. Interprete assim:

- `texto=0 inputs=0` → página em branco: problema de rede/bloqueio, não de
  seletor. Volte ao passo do `curl`.
- `inputs>0` mas travou → é seletor/etapa. Continue abaixo.

**Para consertar uma etapa desconhecida:**

1. Rode com janela visível para ver o que aparece:
   `HEADLESS=false npm run check` (num servidor sem tela: `xvfb-run -a npm run check`).
2. Olhe o screenshot mais recente em `runs/` e o último `runs/form-*.json` — esse
   JSON é a resposta crua da API e **lista os campos que o servidor espera**
   naquela fase (nome, tipo, rótulo, opções). É a fonte de verdade.
3. Acrescente o tratamento em `resolveAndAdvance()`. Prefira casar por texto
   visível/rótulo (robusto) em vez de índice de elemento (quebra fácil).
4. Repita `npm run check` até chegar ao calendário.

**Cuidado importante ao testar com `AUTO_BOOK=true`:** se houver vaga, a
automação **agenda de verdade** — é um ato real no sistema do Detran, e cancelar
exige 48h de antecedência. Durante a depuração, use `AUTO_BOOK=false` (ela
encontra e avisa, sem confirmar). Só ligue `true` quando o fluxo estiver
confiável.

## Convenções deste projeto

- Mensagens de log, comentários e documentação **em português** (o usuário é
  brasileiro e vai ler os logs).
- Sem dependências novas sem necessidade: hoje são só `playwright` e `dotenv`
  (o envio de e-mail é SMTP escrito à mão justamente para evitar mais pacotes).
- `runs/`, `.env` e `user-data/` **nunca** vão para o git (já no `.gitignore`).
  O `.env` contém CPF e número de processo — dados pessoais.
- Ao mexer no fluxo, rode `npx tsc --noEmit` antes de commitar.
