<div align="center">
  <img src="docs/assets/readme-banner.svg" alt="Pericles Desktop Widget — relógio, alarmes, lembretes e clima" width="100%"/>
  <br/>
  <img src="docs/assets/app-icon.svg" alt="Ícone do Pericles Desktop Widget" width="96"/>
  <h1>Pericles Desktop Widget</h1>
  <p>Seu painel pessoal para Windows: relógio, alarmes, lembretes e previsão do tempo.</p>
</div>

Este pacote reúne o código-fonte do Pericles Desktop Widget com os ajustes preparados até agora.

## Incluído
- Interface grafite em layout horizontal e relógio digital.
- Painéis de configurações, alarmes, lembretes e previsão do tempo.
- Opção "Mostrar nas duas telas" nas configurações: abre um segundo widget no outro monitor, com dados sincronizados entre as janelas. Cada janela pode ser arrastada separadamente.
- Ao iniciar, o widget abre sempre centralizado na parte superior da tela, tanto no monitor principal quanto no segundo monitor, já no tamanho final (sem expandir depois que a previsão do tempo carrega).
- Expansão da janela ao abrir painéis e retorno ao tamanho compacto ao fechar.
- Ícones do aplicativo para Windows, incluindo `src-tauri/icons/icon.ico`.
- Alarme sonoro gerado pelo próprio aplicativo, com controle de teste/parada e opção de adiamento na interface.
- Notificações do sistema, quando autorizadas pelo Windows.
- Backup e restauração dos dados (alarmes, lembretes, notas, atalhos e preferências) em um arquivo `.json`, pelos botões "Exportar backup" e "Importar backup" nas configurações.
- Controles de janela ligados aos comandos nativos: "Sobre outros programas" (sempre à frente) e "Modo área de trabalho" (sempre atrás). A opção "Iniciar com o Windows" usa o plugin de inicialização automática e reflete o estado real do sistema.
- Configuração Tauri 2 + React + TypeScript e permissões padrão.

## Identidade visual
- **Ícone:** [`docs/assets/app-icon.svg`](docs/assets/app-icon.svg)
- **Banner do README:** [`docs/assets/readme-banner.svg`](docs/assets/readme-banner.svg)

## Requisitos
- Windows 10 ou 11.
- Node.js instalado.
- Rust e ferramentas de compilação C++ do Visual Studio Build Tools instalados para compilar o Tauri.
- WebView2 Runtime disponível no Windows.

## Executar em modo de desenvolvimento
1. Extraia esta pasta para um local permanente.
2. Abra o PowerShell nesta pasta, onde está o `package.json`.
3. Instale as dependências:

   ```powershell
   npm install
   ```

4. Inicie o aplicativo:

   ```powershell
   npm run tauri dev
   ```

## Gerar instalador

```powershell
npm run tauri build
```

Os instaladores serão gerados na pasta de saída de build do Tauri, normalmente em `src-tauri/target/release/bundle/`.

## Observações
- Este pacote contém o código-fonte, não um executável já compilado.
- O alarme depende de o aplicativo estar em execução; ele não é garantido se o processo estiver encerrado ou se o computador estiver suspenso.
- O comportamento de áudio e o redimensionamento devem ser testados no Windows após iniciar o aplicativo.
