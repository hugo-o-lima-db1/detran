# Prompt para a sessão do Claude Code na VPS

Copie o bloco abaixo e cole como primeira mensagem numa sessão do Claude Code
aberta dentro do diretório do projeto (`claude` rodando em `~/detran-agendamento`).

Ele é auto-contido: a sessão nova não tem memória desta conversa, então o prompt
diz o objetivo, a ordem de trabalho e os cuidados.

---

```
Este projeto é uma automação que monitora vagas do exame psicológico (serviço
749) no portal do DETRAN-PR e agenda a data mais próxima automaticamente.
Leia o CLAUDE.md antes de agir: ele tem o que já foi estabelecido, o que ainda
NÃO foi testado e um playbook de depuração.

Contexto de por que você está sendo chamado: a automação foi escrita num
ambiente fora do Brasil, e o portal do Detran bloqueia esse acesso (o bundle
JavaScript dá timeout, a página abre em branco). Por isso TODO o fluxo depois da
tela inicial — preencher CPF e processo, avançar as fases do meu processo,
chegar ao calendário e ler as datas — nunca foi exercitado contra a tela real.
Você está numa máquina no Brasil, então você consegue. É esse o trabalho.

Objetivo final: `npm run check` percorrer o fluxo até o calendário e reportar
corretamente se há ou não datas disponíveis, de forma confiável e repetida.

Faça nesta ordem:

1. Confirme que esta máquina alcança o servidor de aplicação do Detran (há um
   comando curl pronto no CLAUDE.md, seção "Playbook de depuração"). Se der
   timeout, pare e me avise: nada mais vai funcionar e o problema é a rede.

2. Crie o .env a partir do .env.example. Vou te passar meu CPF e número do
   processo quando você pedir — NÃO invente valores e não os escreva em nenhum
   arquivo além do .env (que já está no .gitignore).
   IMPORTANTE: use AUTO_BOOK=false nesta fase.

3. Rode `npm run check` e me diga o que aconteceu. Interprete a linha que começa
   com "Diagnóstico:" no fim do log — ela diz quantos caracteres de texto e
   quantos inputs a página tem, o que separa "problema de rede" de "problema de
   seletor".

4. Se travar numa etapa (status STUCK), depure de verdade: veja o screenshot
   mais recente em runs/ e o último runs/form-*.json (é a resposta crua da API e
   lista os campos que o servidor espera naquela fase). Ajuste a função
   resolveAndAdvance() em src/detran.ts para tratar a etapa. Prefira casar por
   texto/rótulo visível em vez de índice de elemento. Repita até chegar ao
   calendário. Se precisar ver a tela, use `xvfb-run -a env HEADLESS=false npm run check`.

5. Quando o fluxo estiver chegando ao calendário de forma consistente, me diga
   o que encontrou (há vagas? quais datas?) e só então discutimos ligar
   AUTO_BOOK=true.

Cuidados que eu quero que você respeite:

- Com AUTO_BOOK=true e havendo vaga, a automação AGENDA DE VERDADE no sistema do
  Detran, e cancelar exige 48h de antecedência. Não ligue isso por conta
  própria: pergunte antes.
- Não faça polling agressivo no site do Detran enquanto depura. Rode o check
  quando precisar, não em loop.
- Rode `npx tsc --noEmit` antes de commitar. Comentários e logs em português.
- Commite e dê push das correções na branch atual
  (claude/automate-psychology-exam-booking-wwkv2k), com mensagens descritivas.
- Não versione .env, runs/ nem user-data/ (já estão no .gitignore).

Ao terminar, me explique o que estava errado e o que você mudou, e me diga como
deixar rodando 24/7 (há um deploy/instalar-vps.sh que configura um timer do
systemd a cada 2 horas).
```

---

## Dicas de uso

- **Ele vai pedir seu CPF e o número do processo.** Passe na conversa; a sessão
  grava só no `.env` local da VPS.
- **Se quiser aviso no Telegram**, diga também: *"configure notificação por
  Telegram, meu token é ... e o chat id é ..."*.
- **Se a sessão travar em algo que você não entende**, peça: *"mostre o
  screenshot mais recente de runs/ e o último form-*.json"* — são as duas
  evidências que mais ajudam.
- **Ao final**, para deixar 24/7: *"agende com o systemd a cada 2 horas e me
  mostre como conferir e como desligar quando eu conseguir agendar"*.
