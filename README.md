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

## ⚠️ Onde rodar: precisa ser um servidor NO BRASIL

Isto foi **testado e comprovado** (veja as execuções do workflow): o portal do
Detran-PR carrega seu aplicativo JavaScript do host
`dagf-detran-atendimento-prod.paas.pr.gov.br`, e esse host **não responde de
fora do Brasil**. Medido a partir dos servidores do GitHub (EUA):

| Endereço | Resultado |
|---|---|
| Portal (HTML) | `http=200` em 0,7s ✅ |
| API de agendamento | `http=200` em 0,5s ✅ |
| **Bundle JavaScript** | **timeout de 40s, 0 bytes** ❌ |

Sem o bundle, a página abre **em branco** e não existe campo de CPF para
preencher. Por isso:

- ❌ **GitHub Actions não funciona** (o agendamento vem desligado no workflow).
- ✅ **VPS/servidor no Brasil funciona** — use o instalador abaixo.

---

## 🚀 Rodar 24/7 numa VPS no Brasil (recomendado)

Um único comando faz tudo: instala o que falta, pergunta seus dados, testa na
hora e agenda a verificação a cada 2 horas.

```bash
git clone -b claude/automate-psychology-exam-booking-wwkv2k \
  https://github.com/hugo-o-lima-db1/detran.git ~/detran-agendamento
cd ~/detran-agendamento
bash deploy/instalar-vps.sh
```

O script (`deploy/instalar-vps.sh`):

1. Instala **Node.js 22**, **git** e o **Chromium** (com as bibliotecas do sistema).
2. Pergunta seu **CPF**, **número do processo** e, opcionalmente, o **Telegram**.
3. Grava o `.env` com permissão `600` (só você lê).
4. **Roda um teste imediato** e explica o resultado em português.
5. Agenda no **systemd** a cada 2 horas, com `linger` habilitado (continua
   rodando depois que você fecha o SSH). Se não houver systemd, usa `cron`.

Quando você receber o aviso de agendamento realizado, **desligue**:

```bash
systemctl --user disable --now detran-check.timer
```

Comandos úteis:

```bash
systemctl --user list-timers | grep detran   # quando roda a próxima vez
journalctl --user -u detran-check -n 50      # ver o log das execuções
```

---

## GitHub Actions (apenas execução manual)

O workflow `.github/workflows/check.yml` continua no repositório, mas com o
**agendamento desligado** — porque, como medido acima, o servidor do GitHub não
alcança o bundle JavaScript do Detran e a página abre em branco.

Ele serve para duas coisas:

1. **Re-testar** se o Detran mudar a hospedagem (aba *Actions* → *Verificar
   vagas DETRAN-PR* → **Run workflow**). O passo *Diagnóstico de rede* mostra na
   hora se o bundle voltou a responder.
2. Se um dia responder, basta descomentar o bloco `schedule` no início do
   arquivo para voltar a rodar de forma agendada.

Os secrets já estão configurados no **Environment `detran`** (o job usa
`environment: detran` para lê-los): `DETRAN_CPF` e `DETRAN_PROCESSO`.

## 💻 Instalação manual (se preferir não usar o script)

Os mesmos passos que o `instalar-vps.sh` faz, na mão:

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
| `ERROR` | Página em branco (servidor fora do Brasil) ou falha de rede | 2 |

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
