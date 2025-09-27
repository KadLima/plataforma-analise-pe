const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { spawn } = require('child_process');
const path = require('path');
const cors = require('cors');
const ExcelJS = require('exceljs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const activeProcesses = new Map();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) {
        return res.status(401).send('Acesso negado: Token não fornecido.');
    }

    jwt.verify(token, 'SEGREDO_SUPER_SECRETO', (err, user) => {
        if (err) {
            return res.status(403).send('Forbidden: Token inválido ou expirado.');
        }
        req.user = user; 
        next(); 
    });
}

// --- FUNÇÃO MIDDLEWARE PARA AUTENTICAÇÃO DE ADMIN (VERSÃO DE DIAGNÓSTICO) ---
function authenticateAdmin(req, res, next) {
    console.log("\n--- Verificando permissão de Admin ---");
    console.log("Conteúdo do crachá (req.user):", req.user); // A ESCUTA

    if (req.user && req.user.role === 'ADMIN') {
        console.log("Resultado: Permissão CONCEDIDA.");
        next(); // Permissão concedida, é um admin
    } else {
        console.log("Resultado: Permissão NEGADA.");
        // Se não for admin, retorna 403 Forbidden
        return res.status(403).send('Forbidden: Requer privilégios de administrador.');
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ROTAS DE PÁGINAS ---
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get("/scanner", (req, res) => { res.sendFile(path.join(__dirname, 'scanner.html')); });
app.get("/formulario", (req, res) => { res.sendFile(path.join(__dirname, 'formulario.html')); });
app.get("/admin", (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/avaliacao/:id', (req, res) => { res.sendFile(path.join(__dirname, 'avaliacao.html')); });
app.get("/login", (req, res) => {res.sendFile(path.join(__dirname, 'login.html')); });
app.get("/dashboard", (req, res) => { res.sendFile(path.join(__dirname, 'dashboard.html')); });
app.get("/avaliacao-usuario/:id", (req, res) => { res.sendFile(path.join(__dirname, 'avaliacao-usuario.html')); });

// ROTA DE LOGIN
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: email },
    });

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = jwt.sign(
      { userId: user.id, userEmail: user.email, role: user.role },
      'SEGREDO_SUPER_SECRETO',
      { expiresIn: '8h' }
    );

    res.json({
      message: 'Login bem-sucedido!',
      token: token,
    });

  } catch (error) {
    console.error("Erro na rota de login:", error);
    res.status(500).json({ error: 'Ocorreu um erro interno.' });
  }
});

// ROTA PARA O USUÁRIO LOGADO BUSCAR SUAS PRÓPRIAS AVALIAÇÕES (VERSÃO DE DIAGNÓSTICO)
app.get('/api/my-avaliacoes', authenticateToken, async (req, res) => {
    console.log("\n--- [DASHBOARD] Rota /api/my-avaliacoes foi chamada ---");
    try {
        const userId = req.user.userId;
        console.log(`[DASHBOARD] Buscando dados para o usuário com ID: ${userId}`);
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { secretariaId: true }
        });

        if (!user) {
            console.log(`[DASHBOARD] ERRO: Usuário com ID ${userId} não encontrado no banco.`);
            return res.status(404).json({ error: "Usuário não encontrado." });
        }
        console.log(`[DASHBOARD] Secretaria do usuário encontrada. ID da Secretaria: ${user.secretariaId}`);

        const avaliacoes = await prisma.avaliacao.findMany({
            where: { secretariaId: user.secretariaId },
            orderBy: { createdAt: 'desc' },
            include: {
                secretaria: {
                    select: { sigla: true }
                }
            }
        });
        console.log(`[DASHBOARD] Prisma encontrou ${avaliacoes.length} avaliações para esta secretaria.`);
        
        res.json(avaliacoes);

    } catch (error) {
        console.error("[DASHBOARD] ERRO CRÍTICO na rota:", error); // <-- A escuta mais importante
        res.status(500).json({ error: 'Ocorreu um erro ao buscar suas avaliações.' });
    }
});

// ROTA SEGURA PARA UM USUÁRIO VER OS DETALHES DE UMA DE SUAS AVALIAÇÕES
app.get('/api/my-avaliacoes/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.userId;

        // Encontra o usuário para saber a qual secretaria ele pertence
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { secretariaId: true }
        });
        if (!user) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        // Encontra a avaliação que o usuário pediu
        const avaliacao = await prisma.avaliacao.findUnique({
            where: { id: parseInt(id) },
            include: { 
                secretaria: true, 
                respostas: {
                    include: {
                        requisito: true,
                        evidencias: true // Inclui as evidências
                    },
                    orderBy: {
                        requisitoId: 'asc'
                    }
                } 
            }
        });

        // A MÁGICA DA SEGURANÇA:
        // Verifica se a avaliação existe E se ela pertence à mesma secretaria do usuário logado
        if (!avaliacao || avaliacao.secretariaId !== user.secretariaId) {
            return res.status(403).json({ error: "Acesso negado. Você não tem permissão para ver esta avaliação." });
        }

        res.json(avaliacao);
    } catch (error) {
        console.error("Erro ao buscar detalhes da avaliação do usuário:", error);
        res.status(500).json({ error: 'Ocorreu um erro ao buscar os detalhes da avaliação.' });
    }
});

// ROTA PARA O PRÉ-VALIDADOR
app.post('/pre-validate', async (req, res) => {
  const { urlSecretaria } = req.body;
  if (!urlSecretaria) {
    return res.status(400).json({ error: 'urlSecretaria é obrigatória' });
  }

  try {
    const requisitosParaVerificar = await prisma.requisito.findMany({
      where: { linkFixo: { not: null } }
    });
    
    if (requisitosParaVerificar.length === 0) {
      return res.json([]);
    }

    const linksParaProcurar = requisitosParaVerificar.map(r => r.linkFixo).filter(link => link && !link.startsWith('KEYWORD:'));
    
    if (linksParaProcurar.length === 0) {
      return res.json([]);
    }

    const scriptPath = path.join(__dirname, 'pre_validador.py');
    const scriptArgs = [
      scriptPath,
      urlSecretaria,
      '--find-links', 
      linksParaProcurar.join(',')
    ];

    const pythonProcess = spawn('python', scriptArgs, { cwd: __dirname });

    let resultadoJson = '';
    let erroOutput = '';

    pythonProcess.stdout.on('data', (data) => {
      resultadoJson += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      erroOutput += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Erro no script pre_validador.py: ${erroOutput}`);
        return res.status(500).json({ error: 'Falha na verificação automática.', details: erroOutput });
      }
      try {
        const linksEncontrados = JSON.parse(resultadoJson || '[]');
        res.json(linksEncontrados);
      } catch (parseError) {
        res.status(500).json({ error: 'Falha ao interpretar resultado da verificação.', details: resultadoJson });
      }
    });

  } catch (error) {
    res.status(500).json({ error: 'Erro interno no servidor ao tentar pré-validar.' });
  }
});

// ROTA PARA A VARREDURA COMPLETA
app.post('/start-crawl', authenticateToken, async (req, res) => {
  const { url, depth } = req.body;
  if (!url) { return res.status(400).json({ error: 'URL é obrigatória' }); }
  try {
    const sessionId = `session_${Date.now()}`;
    await prisma.scanSession.create({ data: { id: sessionId, url_base: url, status: 'iniciado' } });
    
    const scriptPath = path.join(__dirname, 'ScannerUnificado.py');
    const scriptArgs = [scriptPath, url, '--session-id', sessionId, '--depth', String(depth || 5)];
    const pythonProcess = spawn('python', scriptArgs, { cwd: __dirname });

    activeProcesses.set(sessionId, { process: pythonProcess, url: url, startTime: new Date() });
    pythonProcess.stdout.on('data', (data) => { console.log(`[${sessionId}]:`, data.toString().trim()); });
    pythonProcess.stderr.on('data', (data) => { console.error(`[${sessionId} Error]:`, data.toString().trim()); });
    pythonProcess.on('close', (code) => {
      console.log(`[${sessionId}] Processo finalizado com código: ${code}`);
      activeProcesses.delete(sessionId);
    });
    res.json({ success: true, message: 'Varredura iniciada!', sessionId: sessionId });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao iniciar varredura: ' + error.message });
  }
});

// ROTA PARA CRIAR LINKS (usada pelo scanner_completo.py)
app.post("/links", async (req, res) => {
  try {
    const { url, tipo, origem, status, httpCode, finalUrl, profundidade, session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'session_id é obrigatório.' });
    }
    const newLink = await prisma.link.create({
      data: {
        url, tipo, origem, status: status || "Não verificado", httpCode, finalUrl, profundidade,
        session: { connect: { id: session_id } },
      },
    });
    res.status(201).json(newLink);
  } catch (error) {
    console.error("[ERRO CRÍTICO] Falha ao criar link:", error);
    if (error.code === 'P2025') {
       return res.status(400).json({ error: `Falha: ScanSession com id '${req.body.session_id}' não existe.` });
    }
    res.status(500).json({ error: "Erro ao criar link" });
  }
});

// ROTA PARA O ADMIN VALIDAR UMA RESPOSTA ESPECÍFICA
// ROTA PARA O ADMIN VALIDAR UMA RESPOSTA ESPECÍFICA (VERSÃO APRIMORADA)
app.patch('/api/respostas/:id', authenticateToken, authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    // Pega todos os possíveis campos do corpo da requisição
    const { 
        statusValidacao, comentarioAdmin,
        validacaoDisponibilidade, comentarioDisponibilidade,
        validacaoSerieHistorica, comentarioSerieHistorica
    } = req.body;

    try {
        const dataToUpdate = {};
        // Adiciona os campos ao objeto de atualização apenas se eles foram enviados na requisição
        if (statusValidacao) dataToUpdate.statusValidacao = statusValidacao;
        if (comentarioAdmin !== undefined) dataToUpdate.comentarioAdmin = comentarioAdmin;
        
        if (validacaoDisponibilidade) dataToUpdate.validacaoDisponibilidade = validacaoDisponibilidade;
        if (comentarioDisponibilidade !== undefined) dataToUpdate.comentarioDisponibilidade = comentarioDisponibilidade;
        
        if (validacaoSerieHistorica) dataToUpdate.validacaoSerieHistorica = validacaoSerieHistorica;
        if (comentarioSerieHistorica !== undefined) dataToUpdate.comentarioSerieHistorica = comentarioSerieHistorica;

        const respostaAtualizada = await prisma.resposta.update({
            where: { id: parseInt(id) },
            data: dataToUpdate
        });
        res.json(respostaAtualizada);
    } catch (error) {
        console.error(`Erro ao atualizar resposta ${id}:`, error);
        res.status(500).json({ error: "Erro ao salvar a validação." });
    }
});

app.post('/api/avaliacoes/:id/devolver', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const avaliacaoAtualizada = await prisma.avaliacao.update({
            where: { id: parseInt(id) },
            data: {
                status: 'AGUARDANDO_RECURSO',
            },
        });

        res.json({ success: true, avaliacao: avaliacaoAtualizada });
    } catch (error) {
        console.error("Erro ao devolver avaliação:", error);
        res.status(500).json({ error: 'Ocorreu um erro ao tentar devolver a avaliação.' });
    }
});

// ROTA PARA A SECRETARIA ENVIAR O RECURSO DE UMA AVALIAÇÃO
app.post('/api/avaliacoes/:id/recurso', authenticateToken, async (req, res) => {
    try {
        const { id: avaliacaoId } = req.params;
        const respostasDoRecurso = req.body.respostas; 
        const userId = req.user.userId;
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { secretariaId: true } });
        const avaliacao = await prisma.avaliacao.findUnique({ where: { id: parseInt(avaliacaoId) }, select: { secretariaId: true } });

        if (!avaliacao || avaliacao.secretariaId !== user.secretariaId) {
            return res.status(403).json({ error: "Acesso negado. Você não tem permissão para editar esta avaliação." });
        }

        const updates = respostasDoRecurso.map(resposta => {
            return prisma.resposta.update({
                where: { id: resposta.respostaId },
                data: {
                    atende: resposta.atende,
                    comentarioRecurso: resposta.comentarioRecurso,
                    evidencias: {
                        deleteMany: {},
                        create: resposta.evidencias,
                    }
                }
            });
        });
        
        await prisma.$transaction(updates);

        await prisma.avaliacao.update({
            where: { id: parseInt(avaliacaoId) },
            data: { status: 'EM_ANALISE_DE_RECURSO' }
        });

        res.json({ success: true, message: "Recurso enviado com sucesso!" });

    } catch (error) {
        console.error("Erro ao enviar recurso:", error);
        res.status(500).json({ error: 'Ocorreu um erro ao processar seu recurso.' });
    }
});

// ROTA PARA O ADMIN ENCERRAR O CICLO E PUBLICAR A NOTA FINAL
app.post('/api/avaliacoes/:id/finalizar', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const { id: avaliacaoId } = req.params;

        // 1. Busca a avaliação completa com todas as respostas e pontuações dos requisitos
        const avaliacao = await prisma.avaliacao.findUnique({
            where: { id: parseInt(avaliacaoId) },
            include: {
                respostas: {
                    include: {
                        requisito: true,
                    },
                },
            },
        });

        if (!avaliacao) {
            return res.status(404).json({ error: 'Avaliação não encontrada.' });
        }

        // 2. Calcula a pontuação final no servidor (fonte da verdade)
        let pontuacaoAlcancada = 0;
        let pontuacaoTotal = 0;
        avaliacao.respostas.forEach(resposta => {
            const pontuacaoTotalRequisito = resposta.requisito.pontuacao;
            pontuacaoTotal += pontuacaoTotalRequisito;

            const isSplit = resposta.atendeDisponibilidade !== null || resposta.atendeSerieHistorica !== null;

            if (isSplit) {
                if (resposta.atendeDisponibilidade) pontuacaoAlcancada += pontuacaoTotalRequisito / 2;
                if (resposta.atendeSerieHistorica) pontuacaoAlcancada += pontuacaoTotalRequisito / 2;
            } else {
                if (resposta.atende) pontuacaoAlcancada += pontuacaoTotalRequisito;
            }
        });

        // 3. Atualiza a avaliação com o status FINALIZADA e a pontuação calculada
        const avaliacaoFinalizada = await prisma.avaliacao.update({
            where: { id: parseInt(avaliacaoId) },
            data: {
                status: 'FINALIZADA',
                pontuacaoFinal: pontuacaoAlcancada,
            },
        });

        res.json({ success: true, avaliacao: avaliacaoFinalizada });

    } catch (error) {
        console.error("Erro ao finalizar avaliação:", error);
        res.status(500).json({ error: 'Ocorreu um erro ao tentar finalizar a avaliação.' });
    }
});

// ROTA PARA SALVAR UMA NOVA AVALIAÇÃO COMPLETA (CORRIGIDA)
app.post('/avaliacoes', authenticateToken, async (req, res) => {
  const { secretariaId, urlSecretaria, nomeResponsavel, emailResponsavel, respostas } = req.body;

  if (!secretariaId || !urlSecretaria || !nomeResponsavel || !emailResponsavel || !respostas || !respostas.length) {
    return res.status(400).json({ error: 'Todos os campos e ao menos uma resposta são obrigatórios.' });
  }

  try {
    const novaAvaliacao = await prisma.avaliacao.create({
      data: {
        secretariaId: parseInt(secretariaId), 
        urlSecretaria,
        nomeResponsavel,
        emailResponsavel,
        status: 'EM_ANALISE_SCGE',
        respostas: {
          create: respostas.map(r => ({
              requisitoId: r.requisitoId,
              atende: r.atende,
              linkComprovante: r.linkComprovante,
              foiAutomatico: r.foiAutomatico,
              comentarioSecretaria: r.comentarioSecretaria,
              atendeDisponibilidade: r.atendeDisponibilidade, 
              atendeSerieHistorica: r.atendeSerieHistorica,  
              evidencias: {
                  create: r.evidencias,
              },
          })),
        },
      },
      include: { respostas: true },
    });
    res.status(201).json(novaAvaliacao);
  } catch (error) {
    console.error('Erro ao salvar avaliação:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao salvar a avaliação no banco de dados.' });
  }
});

// Parar uma varredura
app.post('/stop-crawl/:sessionId', authenticateToken, async (req, res) => {
  const { sessionId } = req.params;
  if (!activeProcesses.has(sessionId)) {
    try {
      await prisma.scanSession.update({ where: { id: sessionId, status: 'iniciado' }, data: { status: 'interrompido' } });
    } catch (error) {}
    return res.status(404).json({ message: 'Sessão não encontrada ou já finalizada.' });
  }
  try {
    const processInfo = activeProcesses.get(sessionId);
    processInfo.process.kill('SIGKILL');
    activeProcesses.delete(sessionId);
    await prisma.scanSession.update({ where: { id: sessionId }, data: { status: 'interrompido' } });
    res.json({ success: true, message: 'Varredura interrompida com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao parar varredura' });
  }
});

// Listar todas as avaliações
app.get('/api/avaliacoes', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const { status } = req.query; // Pega o status da URL
        const whereClause = {}; // Cláusula de busca começa vazia

        if (status) { // Se um status foi enviado, adiciona ao filtro
            whereClause.status = status;
        }

        const avaliacoes = await prisma.avaliacao.findMany({
            where: whereClause, // Aplica o filtro
            orderBy: { createdAt: 'desc' },
            include: { 
                secretaria: { select: { nome: true, sigla: true } },
                respostas: true
            },
        });
        res.json(avaliacoes);

      } catch (error) {
        console.error("ERRO na rota /avaliacoes:", error); // Adicionamos um log de erro aqui
        res.status(500).json({ error: "Erro ao buscar a lista de avaliações." });
      }
});

// Buscar detalhes de uma avaliação
app.get('/api/avaliacoes/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const avaliacao = await prisma.avaliacao.findUnique({
      where: { id: parseInt(id) },
      include: { secretaria: true, respostas: { orderBy: { requisitoId: 'asc' }, include: { requisito: true } } },
    });
    if (!avaliacao) { return res.status(404).json({ error: "Avaliação não encontrada." }); }
    res.json(avaliacao);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar detalhes da avaliação." });
  }
});

// Listar todas as sessões do scanner
app.get("/sessions", authenticateToken, async (req, res) => {
  try {
    const sessions = await prisma.scanSession.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar sessões" });
  }
});

app.get('/scan-stream/:sessionId', (req, res) => {
    const { sessionId } = req.params;

    // Configura os headers para a conexão SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Envia os headers imediatamente

    const processInfo = activeProcesses.get(sessionId);

    if (!processInfo || !processInfo.process) {
        res.write('data: Erro: Sessão não encontrada ou já finalizada.\n\n');
        return res.end();
    }

    const process = processInfo.process;

    const logListener = (data) => {
        const logLines = data.toString().trim().split('\n');
        logLines.forEach(line => {
            // Envia cada linha de log para o frontend
            res.write(`data: ${line}\n\n`);
        });
    };
    
    // "Sintoniza" nos logs do processo Python
    process.stdout.on('data', logListener);
    process.stderr.on('data', logListener);

    // Quando o cliente fecha a página, encerra a conexão
    req.on('close', () => {
        process.stdout.removeListener('data', logListener);
        process.stderr.removeListener('data', logListener);
        res.end();
    });
});

app.get('/verify-token', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// Listar todas as secretarias
app.get('/secretarias', async (req, res) => {
  try {
    const secretarias = await prisma.secretaria.findMany({ orderBy: { nome: 'asc' } });
    res.json(secretarias);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar a lista de secretarias." });
  }
});


app.get('/requisitos', async (req, res) => {
  try {
    const requisitos = await prisma.requisito.findMany({ orderBy: { id: 'asc' } });
    res.json(requisitos);
  } catch (error) {
    console.error("[ERRO CRÍTICO] Falha na rota /requisitos:", error);
    res.status(500).json({ error: "Erro ao buscar a lista de requisitos." });
  }
});

app.delete('/avaliacoes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.resposta.deleteMany({ where: { avaliacaoId: parseInt(id) } });
    await prisma.avaliacao.delete({ where: { id: parseInt(id) } });
    res.json({ success: true, message: 'Avaliação apagada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao apagar a avaliação.' });
  }
});


app.delete('/sessions/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.link.deleteMany({ where: { session_id: id } });
    await prisma.scanSession.delete({ where: { id: id } });
    res.json({ success: true, message: 'Sessão apagada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao apagar a sessão.' });
  }
});


app.get("/scan-sessions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const session = await prisma.scanSession.findUnique({ where: { id } });
    if (!session) { return res.status(404).json({ error: "Sessão não encontrada" }); }
    res.json(session);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar sessão" });
  }
});

app.patch("/scan-session/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { status, total_links, depthReached, errorMessage } = req.body;
    const updateData = {};
    if (status) updateData.status = status;
    if (typeof total_links !== 'undefined') updateData.total_links = total_links;
    if (typeof depthReached !== 'undefined') updateData.depthReached = depthReached;
    if (errorMessage) updateData.errorMessage = errorMessage;
    const updated = await prisma.scanSession.update({ where: { id }, data: updateData });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar scan session' });
  }
});

app.get("/links", async (req, res) => {
  try {
    const { session_id } = req.query;
    console.log(`--- [LOG] Rota GET /links chamada para a session_id: ${session_id}`);

    if (!session_id) {
      console.log("[AVISO] session_id não foi fornecido na requisição.");
      return res.status(400).json({error: "session_id é obrigatório"});
    }

    console.log(`[LOG] Buscando links no banco de dados onde a session_id é exatamente: '${session_id}'`);
    const links = await prisma.link.findMany({
      where: {
        session_id: session_id
      },
      orderBy: {
        createdAt: 'asc'
      }
    });
    
    console.log(`[LOG] A consulta do Prisma encontrou ${links.length} links para esta sessão.`);
    res.json(links);

  } catch (error) {
    console.error("[ERRO CRÍTICO] Falha na rota GET /links:", error);
    res.status(500).json({ error: "Erro ao buscar links" });
  }
});

app.patch('/links/by-url', async (req, res) => {
    const { url, session_id } = req.query; // CORREÇÃO: Pega da URL
    const { status, httpCode, finalUrl } = req.body; // O resto vem do corpo
    
    if (!url || !session_id) {
        return res.status(400).json({ error: 'url e session_id são obrigatórios nos parâmetros da URL.' });
    }
    try {
        const dataToUpdate = {};
        if (status) dataToUpdate.status = status;
        if (httpCode != null) dataToUpdate.httpCode = httpCode;
        if (finalUrl != null) dataToUpdate.finalUrl = finalUrl;
        
        const updated = await prisma.link.updateMany({
            where: { url: url, session_id: session_id },
            data: dataToUpdate,
        });
        
        if (updated.count > 0) {
            res.json({ success: true });
        } else {
            // Isso pode acontecer se o link foi criado com um status e a atualização chega antes. Não é um erro crítico.
            res.status(404).json({ success: false, message: 'Nenhum link correspondente encontrado para atualizar.' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar o status do link' });
    }
});

app.get('/export/csv/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const links = await prisma.link.findMany({ where: { session_id: sessionId }, orderBy: { url: 'asc' } });
    if (links.length === 0) return res.status(404).send('Nenhum link encontrado.');
    const header = 'URL;Status;Codigo_HTTP;Tipo;Origem;URL_Final\n';
    const rows = links.map(link => {
      const rowData = [link.url, link.status, link.httpCode || '', link.tipo, link.origem, link.finalUrl || ''].map(field => `"${String(field).replace(/"/g, '""')}"`);
      return rowData.join(';');
    }).join('\n');
    const csvContent = header + rows;
    const fileName = `relatorio_${sessionId.substring(0, 8)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.status(200).end(csvContent);
  } catch (error) { res.status(500).send('Erro ao gerar o relatório CSV.'); }
});

app.get('/export/json/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const links = await prisma.link.findMany({ where: { session_id: sessionId }, orderBy: { url: 'asc' } });
    if (links.length === 0) return res.status(404).send('Nenhum link encontrado.');
    const fileName = `relatorio_${sessionId.substring(0, 8)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.json(links);
  } catch (error) { res.status(500).send('Erro ao gerar o relatório JSON.'); }
});

app.get('/export/xlsx/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const links = await prisma.link.findMany({ where: { session_id: sessionId }, orderBy: { url: 'asc' } });
    if (links.length === 0) return res.status(404).send('Nenhum link encontrado.');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Links');
    worksheet.columns = [
      { header: 'URL', key: 'url', width: 70 }, { header: 'Status', key: 'status', width: 20 },
      { header: 'Codigo HTTP', key: 'httpCode', width: 15 }, { header: 'Tipo', key: 'tipo', width: 15 },
      { header: 'Origem', key: 'origem', width: 70 }, { header: 'URL Final', key: 'finalUrl', width: 70 },
    ];
    worksheet.addRows(links);
    const fileName = `relatorio_${sessionId.substring(0, 8)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) { res.status(500).send('Erro ao gerar o relatório Excel.'); }
});

async function initialCleanup() {
  try {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const deleted = await prisma.link.deleteMany({ where: { createdAt: { lt: twelveHoursAgo } } });
    if (deleted.count > 0) { console.log(`🧹 Limpeza inicial: ${deleted.count} links antigos removidos.`); }
  } catch (error) { console.error('❌ Erro na limpeza inicial:', error); }
}

// --- FUNÇÃO DE LIMPEZA PARA SESSÕES ZUMBIS ---
async function cleanupZombieScans() {
  try {
    // Encontra todas as sessões que foram deixadas "em andamento"
    const zombieScans = await prisma.scanSession.findMany({
      where: { status: 'iniciado' },
    });

    if (zombieScans.length > 0) {
      console.log(`🧹 Limpando ${zombieScans.length} varredura(s) "zumbi" da última execução...`);
      // Atualiza todas elas para "interrompido"
      await prisma.scanSession.updateMany({
        where: { status: 'iniciado' },
        data: { status: 'interrompido' },
      });
      console.log('🧹 Limpeza concluída.');
    }
  } catch (error) {
    console.error('❌ Erro durante a limpeza de varreduras zumbis:', error);
  }
}

app.listen(PORT, '0.0.0.0', async () => { // Adicionado 'async'
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    await cleanupZombieScans(); // ADICIONADO: Chama a limpeza
    // initialCleanup(); 
});