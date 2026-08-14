# Agendamento automático do exame psicológico — DETRAN-PR

Automação que **verifica de tempos em tempos se há datas disponíveis** para o
exame psicológico (avaliação psicológica, serviço **749**) no portal do
DETRAN-PR e, assim que encontra uma vaga, **agenda automaticamente** a data mais
próxima — ou só te avisa, se você preferir.

O acesso ao agendamento é feito **apenas com CPF + número do processo** (sem
senha e sem código no celular), então a automação roda **sozinha, 24/7**, sem
precisar da sua máquina ligada.

Portal oficial:
<https://www.detran.pr.gov.br/servicos/Motorista/Exames-e-provas/Agendar-ou-cancelar-exames-lqNJnNx8>

---

## 🚀 Rodar 24/7 no GitHub Actions (recomendado)

Esta é a forma mais simples: roda de graça na infraestrutura do GitHub, no
horário agendado, **sem servidor para manter**.

### Passo 1 — Tenha o código no seu GitHub

O código já está no repositório. Se ainda não estiver na branch principal, faça
o merge (ou use a branch atual). O workflow fica em
`.github/workflows/check.yml`.

### Passo 2 — Configure os segredos e variáveis

No GitHub, vá em **Settings → Secrets and variables → Actions**.

Em **Secrets** (dados sensíveis), clique em *New repository secret* e crie:

| Secret | Valor |
|---|---|
| `DETRAN_CPF` | Seu CPF (só números) |
| `DETRAN_PROCESSO` | Seu número de processo / RENACH |
| `TELEGRAM_BOT_TOKEN` | (opcional) token do bot do Telegram |
| `TELEGRAM_CHAT_ID` | (opcional) seu chat id no Telegram |
| `WEBHOOK_URL` | (opcional) URL de webhook Slack/Discord |

Em **Variables** (não sensíveis), opcionalmente:

| Variable | Padrão | Para quê |
|---|---|---|
| `AUTO_BOOK` | `true` | `true` agenda sozinho; `false` só avisa |
| `CIDADE_PREFERIDA` | — | Prioriza uma cidade/unidade (ex.: `CURITIBA`) |
| `DATA_MINIMA` / `DATA_MAXIMA` | — | Faixa de datas aceitas (`YYYY-MM-DD`) |

### Passo 3 — Ligue o agendamento

Na aba **Actions**, habilite os workflows (o GitHub pede confirmação na
primeira vez). Pronto: ele passa a rodar **a cada 2 horas**. Você também pode
disparar na hora pelo botão **Run workflow**.

Para mudar a frequência, edite o `cron` em `.github/workflows/check.yml`
(ex.: `'0 * * * *'` = de hora em hora).

### Passo 4 — Quando agendar

Você recebe a notificação de **agendamento realizado**. A partir daí, **desligue
o workflow** (Actions → *Verificar vagas DETRAN-PR* → `•••` → *Disable
workflow*) para não ficar rodando à toa.

> ⚠️ **Dois detalhes do GitHub Actions:**
> - Ele **desativa** workflows agendados se o repositório ficar **60 dias sem
>   nenhuma atividade**. É raro isso acontecer antes de você agendar, mas se
>   acontecer, é só reabilitar.
> - Em repositório **privado**, os minutos do Actions são limitados (2000/mês no
>   plano grátis). A cada 2 horas está tranquilo; de hora em hora, fique de olho.
>   Em repositório **público**, é ilimitado.

---

## 💻 Rodar em um servidor/VPS próprio (alternativa)

Se preferir uma máquina Linux sua (VPS barata, Raspberry Pi):

```bash
git clone <este-repo> detran && cd detran
npm install
npx playwright install --with-deps chromium
cp .env.example .env      # preencha DETRAN_CPF e DETRAN_PROCESSO
npm run check             # teste uma vez
```

Depois, agende com **systemd** (arquivos prontos em `deploy/`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/detran-check.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now detran-check.timer
```

…ou com **cron** (`crontab -e`):

```cron
0 */2 * * * cd $HOME/detran && /usr/bin/npm run check >> $HOME/detran/runs/cron.log 2>&1
```

…ou simplesmente deixe rodando em modo loop: `npm run loop` (verifica a cada 6h,
ajustável com `LOOP_INTERVAL_MIN`, e para sozinho quando agenda).

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run check` | Uma verificação. Agenda se houver vaga e `AUTO_BOOK=true`. |
| `npm run loop` | Fica verificando em intervalos; encerra ao agendar. |
| `npm run login` | (raramente necessário) abre o navegador visível para depurar. |

Resultados possíveis do `check`:

| Status | Significado | Código de saída |
|---|---|---|
| `BOOKED` | Agendou com sucesso 🎉 | 0 |
| `AVAILABLE` | Achou vaga (mas `AUTO_BOOK=false`) | 0 |
| `NO_AVAILABILITY` | Sem datas no momento (não notifica) | 1 |
| `STUCK` | Travou / CPF ou processo errado (veja abaixo) | 2 |
| `NEEDS_LOGIN` | Portal passou a exigir login gov.br (inesperado) | 2 |

Screenshots e logs de cada execução ficam em `runs/` (e viram *artifacts* no
GitHub Actions).

---

## Notificações

Configure **pelo menos um** canal:

- **Telegram (mais simples):** fale com o [@BotFather](https://t.me/BotFather),
  crie um bot e copie o token (`TELEGRAM_BOT_TOKEN`). Mande uma mensagem ao seu
  bot e acesse `https://api.telegram.org/bot<TOKEN>/getUpdates` para descobrir o
  `chat_id` (`TELEGRAM_CHAT_ID`).
- **Webhook (Slack/Discord/próprio):** ponha a URL em `WEBHOOK_URL`.
- **E-mail (SMTP):** preencha `SMTP_*`. Use **porta 465** (TLS) — a automação
  recusa enviar a senha sem criptografia.

Você é avisado quando: **agendou**, **achou vaga** ou **travou**. "Sem vagas"
não gera notificação (pra não virar spam).

---

## Como funciona por dentro

O portal é uma aplicação Vue/PrimeVue que consome a API
`https://ws.agendamento.detran.pr.gov.br/detran-agendamento/api`, num
**formulário dirigido pelo servidor**, fase a fase
(`/agendamento/fase/inicio` → `POST /agendamento/fase` → … → calendário).

A automação (Playwright + Chromium):

1. Abre o portal do serviço 749.
2. Preenche **CPF** e **número do processo** para acessar.
3. Avança as fases automaticamente: aceita termos, escolhe opções de etapa única
   (priorizando `CIDADE_PREFERIDA`) e clica em *Continuar*.
4. No **calendário**, lê os dias habilitados já com a data completa, aplica o
   filtro `DATA_MINIMA`/`DATA_MAXIMA` e ordena da mais próxima para a mais longe.
5. Se `AUTO_BOOK=true`, seleciona a data mais próxima, o primeiro horário e
   confirma. Senão, só avisa.

### Se der `STUCK`

Duas causas comuns:

1. **CPF ou processo errados** — a automação avisa isso explicitamente. Confira
   os secrets/`.env`.
2. **Uma etapa específica do seu processo** (categoria, escolha de clínica…) que
   os seletores genéricos não souberam resolver. Nesse caso:
   - Rode localmente com `HEADLESS=false npm run check` para ver a tela.
   - Olhe o screenshot em `runs/` e o último `runs/form-*.json`.
   - Ajuste a função `resolveAndAdvance` em `src/detran.ts` (seletores PrimeVue:
     `.p-dropdown`, `.p-radiobutton`, `.p-button`). O código é comentado nesses
     pontos de extensão.

---

## Aviso legal

Ferramenta de uso pessoal para agilizar **o seu próprio** agendamento. Use com
responsabilidade e respeite os termos do DETRAN-PR. O intervalo padrão (2–6h) é
suficiente e educado com o servidor público — evite polling agressivo.
