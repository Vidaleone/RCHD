# RCHD — MVP de atendimento

Sistema local de help desk com portal do cliente e painel técnico, usando Node.js, Express e SQLite (`sql.js`).

## Requisitos
- Node.js 20 ou superior (testado com Node 26).
- npm.

## Executar localmente
1. Abra o terminal na pasta que contém `package.json`.
2. Execute `npm install`.
3. Execute `npm start`.
4. Acesse `http://localhost:3000` para o portal do cliente.
5. Acesse `http://localhost:3000/tech/tech.html` para o painel técnico.
6. No primeiro acesso ao painel, crie o administrador principal.

Mantenha o terminal aberto enquanto utiliza o sistema.

## Funcionalidades atuais

### Portal do cliente
- Abrir chamado e receber token individual de acesso.
- Recuperar o chamado informando o token na página inicial.
- Conversar com a equipe técnica.
- Anexar arquivos durante a conversa (até 10 arquivos por envio, 100 MB por arquivo).
- Gravar áudio e vídeo pelo navegador, com envio direto para a conversa.
- Reproduzir áudio, vídeo e visualizar imagens anexadas.
- Receber aviso visual, som curto e notificação do navegador quando a equipe responder (com permissão concedida).
- Finalizar o atendimento, baixar a conversa em `.txt` e avaliar o atendimento.

### Painel técnico
- Login de técnico e administrador principal.
- Fila de chamados, filtros e busca por número, assunto, cliente, empresa e data.
- Resposta ao cliente, envio de arquivos e gravação de áudio/vídeo.
- Notificações visuais/sonoras e notificações do navegador para mensagens de clientes.
- Dados do cliente e anotações privadas da equipe.
- Botão para adicionar campos de notas internas com título e conteúdo livre.
- Encerramento com formulário obrigatório de resumo e relatório técnico, além de IP, modelo e nome do computador.
- Aba de histórico para chamados encerrados, com relatórios e informações técnicas.
- Download do log da conversa em `.txt`.
- Administrador principal pode cadastrar novos técnicos e consultar avaliações.
- Exclusão definitiva de chamados com confirmação.

## Estrutura
```text
RCHD_MVP_integrado/
├── server.js
├── package.json
├── data/rchd.sqlite
├── uploads/
└── public/
    ├── client/   # portal do cliente
    └── tech/     # painel técnico
```

## Dados e segurança
- Banco local: `data/rchd.sqlite`.
- Arquivos enviados: `uploads/`.
- Cada chamado possui token de acesso do cliente; não compartilhe esse token publicamente.
- Anotações internas e relatórios técnicos são visíveis somente no painel técnico.
- O som e os avisos são executados enquanto a página está aberta. Notificações do sistema operacional dependem de permissão do navegador. Não há push notification quando o navegador está fechado.
- Gravação de áudio/vídeo depende de suporte do navegador e permissão de câmera/microfone. Para acesso fora de `localhost`, utilize HTTPS.
- O limite atual é 100 MB por arquivo; ajuste `multer` em `server.js` se necessário.

## Variáveis de ambiente
`server.js` lê variáveis do ambiente do sistema/host. O arquivo `.env.example` serve como modelo, mas o projeto ainda não carrega `.env` automaticamente. No PowerShell, antes de iniciar, você pode definir ` $env:SESSION_SECRET="uma-chave-longa-e-aleatoria" ` e depois executar `npm start`. Em hospedagem, cadastre `SESSION_SECRET` nas variáveis de ambiente da plataforma. Em produção, configure HTTPS, cookies seguros, armazenamento persistente para banco/arquivos e armazenamento de sessão persistente. A configuração atual é voltada ao MVP local e ainda precisa de hardening antes de uso público.

## Observações importantes
- A primeira conta criada pelo assistente de configuração recebe o papel de administrador principal. O administrador pode cadastrar técnicos; os novos cadastros recebem papel de técnico.
- A migração do banco é executada automaticamente ao iniciar o servidor e preserva os dados anteriores.
- O SQLite e os anexos precisam ficar em armazenamento persistente. Serviços gratuitos com disco efêmero podem apagar os dados ao reiniciar ou dormir; não publique sem definir persistência.
- O projeto não implementa ainda e-mail, WhatsApp, bot, base de conhecimento ou notificações push em segundo plano.

## Atualização da interface do cliente

A tela de conversa do cliente agora utiliza um compositor centralizado com menu de ferramentas para envio de áudio, vídeo pela câmera, gravação de tela e anexos. As gravações exibem contagem regressiva de três segundos e um indicador pulsante enquanto a captura está ativa. A notificação de novas mensagens combina aviso visual, som discreto e notificação nativa do navegador quando autorizada.

Ao abrir um chamado, o destaque visual vermelho transita para verde em aproximadamente um segundo. Quando o chamado é encerrado pelo cliente ou pela equipe técnica, a área de composição é removida, a tela assume aparência em tons de cinza e é exibido um botão para voltar ao início. O histórico em TXT e a avaliação continuam acessíveis conforme o estado do atendimento.

**Permissões:** áudio e câmera exigem autorização do navegador. A gravação de tela depende do suporte a `getDisplayMedia`. Em produção, esses recursos e as notificações nativas exigem HTTPS; em desenvolvimento, `localhost` é considerado contexto seguro pelos navegadores modernos.

## Refinamentos recentes de interface
- Painel técnico: token de acesso do cliente visível em cartão discreto, com botão para copiar (somente para técnicos autenticados).
- Painel técnico: compositor de mensagens unificado com o portal do cliente, menu de ferramentas para áudio, vídeo, gravação de tela e anexos, contagem regressiva e indicador pulsante durante a gravação.
- Portal do cliente: removido o seletor duplicado de vídeo; a opção de vídeo agora grava diretamente pela câmera, enquanto anexos gerais permanecem em uma única ferramenta.
- Portal do cliente: após o encerramento, a área de avaliação recebe destaque amarelo temporário; depois do envio da avaliação, retorna ao estado totalmente cinza.

## Atualizações funcionais — avaliações, equipe e relatórios
- A avaliação do cliente utiliza escala numérica de 1 a 10. Após o envio, aparece a confirmação “muito obrigado! sua avaliação foi enviada!” e, em seguida, o formulário desaparece; o botão de finalizar atendimento também é removido assim que o chamado é encerrado.
- O seletor de arquivos do chat do cliente fica oculto; o envio de arquivos é acionado somente pelo menu **＋ Ferramentas → Anexar arquivo**. O campo de anexos do formulário de abertura do chamado continua disponível.
- O relatório técnico é montado com campos independentes, cada um com título e detalhes. É possível adicionar quantos campos forem necessários, além de registrar IP, modelo e nome do computador.
- O chamado pode ser transferido para qualquer integrante cadastrado da equipe.
- A administração possui cartões clicáveis para buscar técnicos, cadastrar técnicos e abrir a equipe cadastrada. Ao selecionar uma pessoa, são exibidos os últimos chamados atribuídos, as avaliações dos clientes e a média geral em escala de 1 a 10.
- O painel técnico também permite registrar uma avaliação numérica de 1 a 10 no encerramento. As avaliações do cliente e do técnico ficam identificadas separadamente no banco.
- Na primeira inicialização desta versão, as avaliações antigas de 1 a 5 são convertidas automaticamente para a escala equivalente de 1 a 10 (multiplicadas por dois). A migração é versionada e não se repete nas próximas inicializações.


## Atualizações funcionais — avaliações, equipe e relatórios
- A avaliação do cliente utiliza escala numérica de 1 a 10. Após o envio, aparece a confirmação “muito obrigado! sua avaliação foi enviada!” e, em seguida, o formulário desaparece; o botão de finalizar atendimento também é removido assim que o chamado é encerrado.
- O seletor de arquivos do chat do cliente fica oculto; o envio de arquivos é acionado somente pelo menu **＋ Ferramentas → Anexar arquivo**. O campo de anexos do formulário de abertura do chamado continua disponível.
- O relatório técnico é montado com campos independentes, cada um com título e detalhes. É possível adicionar quantos campos forem necessários, além de registrar IP, modelo e nome do computador.
- O chamado pode ser transferido para qualquer integrante cadastrado da equipe.
- A administração possui cartões clicáveis para buscar técnicos, cadastrar técnicos e abrir a equipe cadastrada. Ao selecionar uma pessoa, são exibidos os últimos chamados atribuídos, as avaliações dos clientes e a média geral em escala de 1 a 10.
- O painel técnico também permite registrar uma avaliação numérica de 1 a 10 no encerramento. As avaliações do cliente e do técnico ficam identificadas separadamente no banco.
- Na primeira inicialização desta versão, as avaliações antigas de 1 a 5 são convertidas automaticamente para a escala equivalente de 1 a 10 (multiplicadas por dois). A migração é versionada e não se repete nas próximas inicializações.


**Aplicação desta atualização:** faça uma cópia de segurança da pasta atual. Extraia os arquivos da atualização sobre a pasta do projeto, mantendo os arquivos existentes `data/rchd.sqlite` e o conteúdo de `uploads/`. O pacote de atualização não substitui o banco nem os anexos para evitar perda de chamados, avaliações, técnicos e arquivos. Na próxima inicialização, a migração do banco será executada automaticamente.


## Ajustes de transferência e organização da interface

- O botão **Encerrar chamado** fica junto aos controles no cabeçalho do chamado; o relatório técnico é preenchido no fluxo de encerramento.
- A transferência registra uma mensagem automática e discreta no chat, identificando o técnico anterior e o novo responsável.
- O chamado passa a aparecer na fila somente do técnico responsável (chamados ainda sem responsável continuam disponíveis para serem assumidos).
- A tabela `ticket_participants` registra os técnicos que já participaram. Após transferir, o técnico anterior perde acesso ao conteúdo do chamado, mas mantém no histórico um registro resumido da participação.
- O histórico de participação não expõe o relatório técnico nem os dados operacionais do chamado transferido.
- A busca global duplicada é ocultada na Administração; a pesquisa é apresentada somente após clicar em **Buscar técnico**.

A tabela `ticket_participants` é criada automaticamente na inicialização, e os responsáveis atuais dos chamados existentes são registrados na migração.
