# Plano de Evolução — Pericles Desktop Widget

Este arquivo rastreia o que já foi implementado e o que ainda falta.
Marque `[x]` ao concluir cada item e avance para a próxima etapa.

## Etapa 0 — Base do widget (concluída)
- [x] Relógio em tempo real
- [x] Data formatada em pt-BR
- [x] Previsão do tempo (Open-Meteo)
- [x] Busca de cidades com sugestões
- [x] Uso da localização atual
- [x] Alarmes (criar, ativar/pausar, excluir, repetir)
- [x] Lembretes (criar, concluir, excluir)
- [x] Painéis (alarme, lembrete, clima, configurações)
- [x] Preferências (transparência, sempre no topo, modo desktop, autostart, duas telas)
- [x] Sincronização entre janelas (principal/secundária)
- [x] Som de alarme com volume ajustável
- [x] Opções de som de alarme (clássico, bipe, sino, digital, suave)
- [x] Alarme também toca para lembretes
- [x] Exclusão automática do lembrete ao parar o alarme
- [x] Edição de lembretes no painel (engrenagem)
- [x] Clique na área de lembretes abre o painel de lembretes
- [x] Remoção da seta e do nome na barra superior esquerda
- [x] Barra de rolagem minimalista global
- [x] Ícone na bandeja do sistema (sem botão na barra de tarefas)
- [x] Segunda tela com skip na barra de tarefas

## Etapa 1 — Notificações e tela de bloqueio (concluída)
- [x] Seção “Notificações” nas configurações
- [x] Toggle para ativar/desativar notificações
- [x] Botão “Testar notificação”
- [x] Botão para abrir configurações do Windows (deep link)
- [x] Orientação ao usuário sobre exibir conteúdo na tela de bloqueio

## Etapa 2 — Previsão e dados offline (concluída)
- [x] Previsão estendida (próximos dias)
- [x] Cache offline do último clima
- [x] Tratamento de erro mais claro (sem internet)
- [x] Atualização automática de localização (clima atualizado periodicamente)

## Etapa 3 — Lembretes avançados (concluída)
- [x] Lembretes recorrentes (repetição diária)
- [x] Categorias/tags
- [x] Filtro por concluídos/pendentes
- [x] Busca de lembretes

## Etapa 4 — Produtividade
- [x] Timer Pomodoro/foco
- [x] Cronômetro
- [x] Notas rápidas
- [x] Atalhos rápidos (apps/sites)
- [x] Paleta de comandos

## Etapa 6 — Sistema e integração
- [x] Atalhos globais (mostrar/ocultar, adiar alarme)
- [x] Métricas do sistema (bateria, CPU/RAM, rede) opcionais
- [ ] Integração com calendário (eventos do dia)

## Etapa 7 — Distribuição e robustez
- [ ] Atualização automática do app
- [x] Backup/restauração de configurações
- [ ] Acessibilidade (teclado, leitores de tela)
- [ ] Testes automatizados (UI e lógica)
- [ ] Melhorias no instalador (NSIS/MSI)

## Etapa 8 — Sons avançados
- [ ] Sons personalizados (arquivo do usuário)
- [ ] Preview de som na seleção
- [ ] Volume independente por tipo (alarme vs lembrete) (opcional)