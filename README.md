# Agendamento automático do exame psicológico — DETRAN-PR

Automação que **verifica todo dia se há datas disponíveis** para o exame
psicológico (avaliação psicológica, serviço **749**) no portal do DETRAN-PR e,
assim que encontra uma vaga, **agenda automaticamente** a primeira data — ou só
te avisa, se você preferir.

Portal oficial:
<https://www.detran.pr.gov.br/servicos/Motorista/Exames-e-provas/Agendar-ou-cancelar-exames-lqNJnNx8>
→ agendamento em
<https://www.agendamento.detran.pr.gov.br/detran-agendamento/portal?servico=749>

---

## ⚠️ Leia isto primeiro (importante)

O agendamento do DETRAN-PR **exige login** na *Central de Segurança do Paraná*
(o mesmo login do `gov.br` / identidade digital), muitas vezes **com segundo
fator (2FA)**. Não existe forma de agendar sem essa autenticação.

Por isso a automação funciona assim:

1. **Você faz login UMA vez**, numa janela de navegador que abre na sua tela
   (comando `npm run login`). A sessão fica salva na pasta `user-data/`.
2. Depois disso, a verificação diária roda **sozinha e sem janela** (headless),
   reaproveitando essa sessão salva.
3. Quando a sessão expirar (o DETRAN desloga de tempos em tempos), a automação
   te **avisa** para refazer o login.

> **Onde rodar:** o mais confiável é na **sua própria máquina** (que já está
> logada) ou num servidor/VPS seu. O GitHub Actions incluído serve para
> *monitorar e avisar*, mas não passa sozinho pelo 2FA.

---

## Instalação

Requer **Node.js 20+**.

```bash
cd detran
npm install
npx playwright install chromium   # baixa o navegador (só na primeira vez)
cp .env.example .env               # depois edite o .env
```

Edite o `.env` e preencha pelo menos:

- `DETRAN_CPF` — seu CPF.
- `AUTO_BOOK` — `true` para agendar sozinho, `false` para só avisar.
- Um canal de notificação (Telegram é o mais simples — veja abaixo).

---

## Uso

### 1) Login (uma vez, com janela visível)

```bash
npm run login
```

Abre o portal numa janela. **Faça o login normalmente** (CPF, senha, 2FA). Quando
a automação detectar que você está autenticado, ela salva a sessão e fecha. Se
demorar, ela espera até 5 minutos.

> Dica: no Linux sem tela (servidor), use `xvfb-run npm run login` ou faça o
> login numa máquina com tela e copie a pasta `user-data/` para o servidor.

### 2) Verificação avulsa

```bash
npm run check
```

Faz uma verificação única. Resultados possíveis:

| Status | Significado |
|---|---|
| `BOOKED` | Agendou com sucesso 🎉 |
| `AVAILABLE` | Achou vaga (mas `AUTO_BOOK=false`, então só avisou) |
| `NO_AVAILABILITY` | Sem datas no momento (não notifica, pra não encher) |
| `NEEDS_LOGIN` | Sessão expirou — rode `npm run login` de novo |
| `STUCK` | Travou numa etapa específica do seu processo (veja abaixo) |

Screenshots e logs de cada execução ficam em `runs/`.

### 3) Loop contínuo (verifica de tempos em tempos)

```bash
npm run loop
```

Fica rodando e verifica a cada 6 horas (configurável com
`LOOP_INTERVAL_MIN`, em minutos). Quando **agenda**, encerra sozinho. Bom para
deixar aberto numa máquina ligada o dia todo.

---

## Agendar para rodar "todo dia" sozinho

### Opção A — `cron` (Linux/macOS)

Rode `crontab -e` e adicione (ajuste o caminho):

```cron
# A cada 6 horas
0 */6 * * * cd $HOME/detran && /usr/bin/npm run check >> $HOME/detran/runs/cron.log 2>&1
```

### Opção B — `systemd` (Linux)

Há um service + timer prontos em `deploy/`:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/detran-check.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now detran-check.timer
systemctl --user list-timers | grep detran   # conferir
```

### Opção C — GitHub Actions

O workflow `.github/workflows/check.yml` roda a cada 6h. Configure em
*Settings → Secrets and variables → Actions*:

- **Secrets:** `DETRAN_CPF`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (e/ou `WEBHOOK_URL`).
- **Variables:** `AUTO_BOOK` (`false` recomendado no Actions), `CIDADE_PREFERIDA`.

⚠️ O Actions **não passa pelo 2FA sozinho** — use-o para *monitorar/avisar*. O
agendamento automático é mais confiável nas opções A ou B, na sua máquina.

### Opção D — Windows (Agendador de Tarefas)

Crie uma tarefa que executa, no diretório do projeto:
`cmd /c npm run check`, repetindo a cada 6 horas.

---

## Notificações

Configure **pelo menos um** canal no `.env`:

- **Telegram (recomendado):** fale com o [@BotFather](https://t.me/BotFather),
  crie um bot, copie o token em `TELEGRAM_BOT_TOKEN`. Descubra seu `chat_id`
  (ex.: mande uma mensagem pro bot e acesse
  `https://api.telegram.org/bot<TOKEN>/getUpdates`) e ponha em `TELEGRAM_CHAT_ID`.
- **Webhook (Slack/Discord/próprio):** ponha a URL em `WEBHOOK_URL`. Recebe um
  `POST` JSON com os campos `text` e `content`.
- **E-mail (SMTP):** preencha `SMTP_*`. Use **porta 465** (TLS) sempre que
  possível — a automação recusa enviar a senha sem criptografia.

Você é notificado quando: **agendou**, **achou vaga**, **precisa relogar** ou
**travou**. "Sem vagas" não gera notificação (pra não virar spam diário).

---

## Configuração (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `DETRAN_CPF` | — | CPF (obrigatório) |
| `DETRAN_SERVICO` | `749` | Código do serviço (749 = avaliação psicológica) |
| `AUTO_BOOK` | `true` | `true` agenda sozinho; `false` só avisa |
| `DATA_MINIMA` / `DATA_MAXIMA` | — | Restringe datas aceitas (`YYYY-MM-DD`) |
| `CIDADE_PREFERIDA` | — | Prioriza uma cidade/unidade (texto parcial) |
| `HEADLESS` | `true` | `false` mostra o navegador (necessário no login) |
| `USER_DATA_DIR` | `./user-data` | Pasta da sessão salva (não versione!) |
| `STEP_TIMEOUT_MS` | `45000` | Tempo máx. por passo da página |
| `LOOP_INTERVAL_MIN` | `360` | Intervalo do modo `loop` (minutos) |
| `PLAYWRIGHT_CHROMIUM_PATH` | — | Caminho de um Chromium já instalado (opcional) |

---

## Como funciona por dentro

O portal é uma aplicação Vue/PrimeVue que consome a API
`https://ws.agendamento.detran.pr.gov.br/detran-agendamento/api`. O fluxo é um
**formulário dirigido pelo servidor**, fase a fase
(`/agendamento/fase/inicio` → `POST /agendamento/fase` → ... → calendário).

A automação:

1. Abre o portal com a sessão salva (Playwright + Chromium).
2. Escuta as respostas JSON de `/agendamento/fase` para saber a fase atual
   (salvas em `runs/form-*.json` para depuração).
3. Avança as fases automaticamente: preenche CPF, aceita termos, escolhe opções
   de etapa única (priorizando `CIDADE_PREFERIDA`) e clica em *Continuar*.
4. Ao chegar no **calendário**, detecta os dias clicáveis (não desabilitados).
5. Se houver vaga e `AUTO_BOOK=true`, seleciona o primeiro dia, o primeiro
   horário e confirma. Senão, só avisa.

### Se der `STUCK`

Cada processo de habilitação tem etapas próprias (categoria, RENACH, escolha de
clínica...). Se a automação travar numa etapa que não soube resolver:

1. Rode `HEADLESS=false npm run check` para ver o que aparece na tela.
2. Olhe o screenshot em `runs/` e o último `runs/form-*.json`.
3. Ajuste a função `resolveAndAdvance` em `src/detran.ts` para tratar a etapa
   (os seletores são de PrimeVue: `.p-dropdown`, `.p-radiobutton`, `.p-button`).

O código é comentado justamente nesses pontos de extensão.

---

## Aviso legal

Ferramenta de uso pessoal para agilizar **o seu próprio** agendamento. Use com
responsabilidade e respeite os termos do DETRAN-PR. Não faça polling agressivo:
o padrão (a cada 6 horas) é suficiente e educado com o servidor público.
