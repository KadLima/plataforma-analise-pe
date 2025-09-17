const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { spawn } = require('child_process');
const path = require('path');
const cors = require('cors');
const ExcelJS = require('exceljs');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const activeProcesses = new Map();

app.use(cors());
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// --- ROTAS DE PÁGINAS ---
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get("/scanner", (req, res) => { res.sendFile(path.join(__dirname, 'scanner.html')); });
app.get("/formulario", (req, res) => { res.sendFile(path.join(__dirname, 'formulario.html')); });
app.get("/admin", (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/avaliacao/:id', (req, res) => { res.sendFile(path.join(__dirname, 'avaliacao.html')); });

// --- ROTAS DA API ---

// ROTA PRINCIPAL: Iniciar uma nova varredura do Scanner de Links
app.post('/start-crawl', async (req, res) => {
  const { url, depth } = req.body;
  if (!url) { return res.status(400).json({ error: 'URL é obrigatória' }); }
  try {
    const sessionId = `session_${Date.now()}`;
    await prisma.scanSession.create({
      data: { id: sessionId, url_base: url, status: 'iniciado' }
    });
    console.log(`[${sessionId}] Sessão criada no banco de dados.`);
    const scriptPath = path.join(__dirname, 'ScannerUnificado.py');
    const scriptArgs = [scriptPath, url, '--session-id', sessionId, '--depth', String(depth || 5)];
    const pythonProcess = spawn('python', scriptArgs, { cwd: __dirname });
    activeProcesses.set(sessionId, { process: pythonProcess, url: url, startTime: new Date() });
    pythonProcess.stdout.on('data', (data) => { console.log(`[${sessionId}]:`, data.toString().trim()); });
    pythonProcess.stderr.on('data', (data) => { console.error(`[${sessionId} Error]:`, data.toString().trim()); });
    pythonProcess.on('close', (code) => {
      console.log(`[${sessionId}] Processo finalizado. Código: ${code}`);
      activeProcesses.delete(sessionId);
    });
    res.json({ success: true, message: 'Varredura iniciada!', sessionId: sessionId });
  } catch (error) {
    console.error("ERRO CRÍTICO em /start-crawl:", error);
    res.status(500).json({ error: 'Erro interno ao iniciar a varredura: ' + error.message });
  }
});

// ROTA PRINCIPAL: Criar um novo registro de link (usado pelo script Python)
app.post("/links", async (req, res) => {
  try {
    const { url, tipo, origem, status, httpCode, finalUrl, profundidade, session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'session_id é obrigatório no corpo da requisição.' });
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
       return res.status(400).json({ error: `Falha ao criar link: A ScanSession com id '${req.body.session_id}' não existe.` });
    }
    res.status(500).json({ error: "Erro ao criar link" });
  }
});

// Rota do Pré-Validador
app.post('/pre-validate', async (req, res) => {
  const { urlSecretaria } = req.body;
  if (!urlSecretaria) { return res.status(400).json({ error: 'urlSecretaria é obrigatória' }); }
  try {
    const requisitosParaVerificar = await prisma.requisito.findMany({ where: { linkFixo: { not: null } } });
    if (requisitosParaVerificar.length === 0) { return res.json([]); }
    const linksParaProcurar = requisitosParaVerificar.map(r => r.linkFixo).filter(link => link && !link.startsWith('KEYWORD:'));
    if (linksParaProcurar.length === 0) { return res.json([]); }
    const scriptPath = path.join(__dirname, 'ScannerUnificado.py');
    const scriptArgs = [scriptPath, urlSecretaria, '--find-links', linksParaProcurar.join(',')];
    const pythonProcess = spawn('python', scriptArgs, { cwd: __dirname });
    let resultadoJson = '';
    let erroOutput = '';
    pythonProcess.stdout.on('data', (data) => { resultadoJson += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { erroOutput += data.toString(); });
    pythonProcess.on('close', (code) => {
      if (code !== 0) { return res.status(500).json({ error: 'Falha na verificação automática.', details: erroOutput }); }
      try {
        const linksEncontrados = JSON.parse(resultadoJson);
        res.json(linksEncontrados);
      } catch (parseError) {
        res.status(500).json({ error: 'Falha ao interpretar resultado da verificação.', details: resultadoJson });
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao tentar pré-validar.' });
  }
});

// Salvar uma nova Avaliação
app.post('/avaliacoes', async (req, res) => {
  const { secretariaId, urlSecretaria, nomeResponsavel, emailResponsavel, respostas } = req.body;
  if (!secretariaId || !urlSecretaria || !nomeResponsavel || !emailResponsavel || !respostas || !respostas.length) {
    return res.status(400).json({ error: 'Todos os campos e ao menos uma resposta são obrigatórios.' });
  }
  try {
    const novaAvaliacao = await prisma.avaliacao.create({
      data: {
        secretariaId: parseInt(secretariaId), urlSecretaria, nomeResponsavel, emailResponsavel,
        respostas: {
          create: respostas.map(r => ({
            requisitoId: r.requisitoId, atende: r.atende,
            linkComprovante: r.linkComprovante, foiAutomatico: r.foiAutomatico,
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
app.post('/stop-crawl/:sessionId', async (req, res) => {
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
app.get('/avaliacoes', async (req, res) => {
  try {
    const avaliacoes = await prisma.avaliacao.findMany({
      orderBy: { createdAt: 'desc' },
      include: { secretaria: { select: { nome: true, sigla: true } } },
    });
    res.json(avaliacoes);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar a lista de avaliações." });
  }
});

// Buscar detalhes de uma avaliação
app.get('/avaliacoes/:id', async (req, res) => {
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
app.get("/sessions", async (req, res) => {
  try {
    const sessions = await prisma.scanSession.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar sessões" });
  }
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


app.delete('/sessions/:id', async (req, res) => {
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
  const { session_id } = req.query;
  try {
    if (!session_id) { return res.status(400).json({error: "session_id é obrigatório"}); }
    const links = await prisma.link.findMany({ where: { session_id }, orderBy: { createdAt: 'asc' } });
    res.json(links);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar links" });
  }
});

app.patch('/links/by-url', async (req, res) => {
  const { url, session_id, status, httpCode, finalUrl, profundidade } = req.body;
  if (!url || !session_id ) { return res.status(400).json({ error: 'url e session_id são obrigatórios' }); }
  try {
    const dataToUpdate = {};
    if (status) dataToUpdate.status = status;
    if (httpCode != null) dataToUpdate.httpCode = httpCode;
    if (finalUrl != null) dataToUpdate.finalUrl = finalUrl;
    if (profundidade != null) dataToUpdate.profundidade = profundidade;
    const updated = await prisma.link.updateMany({
      where: { url: url, session_id: session_id },
      data: dataToUpdate,
    });
    if (updated.count > 0) { res.json({ success: true }); }
    else { res.status(404).json({ success: false, message: 'Nenhum link correspondente encontrado para atualizar.' }); }
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    initialCleanup();
});