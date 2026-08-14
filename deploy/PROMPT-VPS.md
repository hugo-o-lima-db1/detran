# Prompt one-shot — configurar a automação na VPS

Abra o Claude Code na sua VPS (em qualquer diretório, ex.: `cd ~ && claude`) e
cole **o bloco inteiro abaixo** como primeira mensagem. Ele parte do zero: clona
o repositório, instala tudo, configura, testa e agenda.

Ele vai pedir seu **CPF** e **número do processo** no meio do caminho — é normal,
esses dados só vão para o `.env` local da VPS (que não é versionado).

---

```
Preciso que você configure e valide uma automação neste servidor, do começo ao
fim. Você está numa VPS Linux no Brasil, e isso é essencial para a tarefa.

O QUE É: uma automação que verifica periodicamente se há data disponível para o
exame psicológico (avaliação psicológica, serviço 749) no portal do DETRAN-PR e,
ao encontrar, agenda a data mais próxima automaticamente, me notificando.

O CÓDIGO JÁ EXISTE, é público:
  repositório: https://github.com/hugo-o-lima-db1/detran
  branch:      claude/automate-psychology-exam-booking-wwkv2k

PASSO 1 — Traga o projeto e leia o contexto:

  git clone -b claude/automate-psychology-exam-booking-wwkv2k \
    https://github.com/hugo-o-lima-db1/detran.git ~/detran-agendamento
  cd ~/detran-agendamento

Leia o CLAUDE.md antes de qualquer outra coisa. Ele tem o que já foi
estabelecido, o que ainda NÃO foi testado, e um playbook de depuração. Não
refaça investigação que já está documentada lá.

PASSO 2 — Confirme que esta máquina alcança o Detran.

Isto é a primeira coisa a validar, porque decide se o resto faz sentido. O
portal carrega seu JavaScript de um host que NÃO responde de fora do Brasil
(dagf-detran-atendimento-prod.paas.pr.gov.br). O CLAUDE.md tem o comando curl
pronto na seção "Playbook de depuração". Se der timeout, PARE e me avise: esta
máquina está bloqueada e nada mais vai funcionar.

PASSO 3 — Instale as dependências.

Há um instalador pronto: `bash deploy/instalar-vps.sh`. Ele instala Node 22,
Chromium do Playwright e as bibliotecas do sistema, pergunta meus dados, cria o
.env, roda um teste e configura um timer do systemd a cada 2 horas.

Você pode rodá-lo OU fazer os passos na mão, como preferir — mas se rodar o
script, atenção: ele pergunta se quero agendamento automático, e neste momento a
resposta é NÃO (explico no passo 4).

PASSO 4 — Configure com AUTO_BOOK=false para começar.

Vou te passar meu CPF e o número do processo quando você pedir. Não invente
valores e não os escreva em nenhum lugar além do .env (já está no .gitignore).

Comece com AUTO_BOOK=false. Motivo: com AUTO_BOOK=true e havendo vaga, a
automação AGENDA DE VERDADE no sistema do Detran, e cancelar exige 48h de
antecedência. Durante a validação ela deve apenas encontrar e avisar. Só ligamos
true quando o fluxo estiver confiável — e você me pergunta antes de ligar.

PASSO 5 — Rode e faça funcionar de verdade.

  npm run check

Me diga o que aconteceu. O log termina com uma linha "Diagnóstico:" que informa
quantos caracteres de texto e quantos inputs a página tem — use isso para
separar "problema de rede" de "problema de seletor".

Resultados possíveis: BOOKED (agendou), AVAILABLE (achou vaga), NO_AVAILABILITY
(sem vagas agora — é sucesso!), STUCK (travou numa etapa), ERROR.

Se der STUCK, depure de verdade e itere até chegar ao calendário:
  - veja o screenshot mais recente em runs/
  - veja o último runs/form-*.json — é a resposta crua da API e lista os campos
    que o servidor espera naquela fase; é a fonte de verdade
  - ajuste a função resolveAndAdvance() em src/detran.ts (é o ponto de extensão
    feito para isso). Prefira casar por texto/rótulo visível em vez de índice de
    elemento, que quebra fácil.
  - se precisar ver a tela: xvfb-run -a env HEADLESS=false npm run check

Atenção: todas as etapas depois da tela inicial (categoria, escolha de clínica,
confirmação, leitura do calendário) foram escritas por engenharia reversa e
NUNCA foram testadas contra a tela real. É bem provável que precisem de ajuste.
Esse é o trabalho de verdade aqui — não desista no primeiro STUCK.

PASSO 6 — Deixe rodando 24/7 e me explique.

Quando o check estiver percorrendo o fluxo de forma consistente:
  - me diga o que encontrou (há vagas? quais datas?)
  - me pergunte se pode ligar AUTO_BOOK=true
  - configure o timer do systemd a cada 2 horas (o instalador faz isso, com
    loginctl enable-linger para sobreviver ao fim da sessão SSH)
  - me mostre como conferir (systemctl --user list-timers | grep detran) e como
    DESLIGAR quando eu conseguir agendar
  - se eu te passar um token e chat id do Telegram, configure a notificação

Regras que quero que você respeite:

- Não faça polling agressivo no site do Detran enquanto depura. Rode o check
  quando precisar, nunca em loop apertado. É um serviço público.
- Rode `npx tsc --noEmit` antes de commitar. Logs e comentários em português.
- Commite e dê push das correções na branch atual, com mensagens descritivas
  explicando o que a tela real mostrou e por que a mudança foi necessária.
- NUNCA versione .env, runs/ ou user-data/ — contêm meus dados pessoais e o
  repositório é público.

Ao final, me explique em português o que estava errado no fluxo, o que você
mudou, e qual é o estado atual (está monitorando? de quanto em quanto tempo?).
```

---

## Depois de colar

- **Ele vai pedir CPF e número do processo.** Responda na conversa.
- **Se travar em algo confuso**, peça: *"mostre o screenshot mais recente de
  `runs/` e o último `form-*.json`"* — são as duas evidências que mais ajudam.
- **Quando funcionar e você conseguir agendar**, desligue o monitoramento:
  ```bash
  systemctl --user disable --now detran-check.timer
  ```

## ⚠️ Agora que o repositório é público

- O `.env` (CPF e processo) **não vai** para o git — está no `.gitignore`. Mantenha assim.
- A pasta `runs/` também não vai. Isso importa mais do que parece: os
  screenshots podem mostrar seu nome e CPF na tela do Detran.
- Os *artifacts* do GitHub Actions em repositório público são **baixáveis por
  qualquer pessoa**. O agendamento do Actions já está desligado (não funciona de
  fora do Brasil), mas evite rodá-lo manualmente com dados reais — ou volte o
  repositório para privado se preferir.
